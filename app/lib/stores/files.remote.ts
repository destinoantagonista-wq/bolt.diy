import { getEncoding } from 'istextorbinary';
import { map, type MapStore } from 'nanostores';
import { Buffer } from 'node:buffer';
import { path } from '~/utils/path';
import { WORK_DIR } from '~/utils/constants';
import { computeFileModifications } from '~/utils/diff';
import { createScopedLogger } from '~/utils/logger';
import {
  addLockedFile,
  addLockedFolder,
  clearCache,
  getLockedFilesForChat,
  getLockedFoldersForChat,
  getLockedItemsForChat,
  isPathInLockedFolder,
  migrateLegacyLocks,
  removeLockedFile,
  removeLockedFolder,
} from '~/lib/persistence/lockedFiles';
import { getCurrentChatId } from '~/utils/fileLocks';
import { runtimeApi, toRuntimePath, type RuntimeFileEntry } from '~/lib/runtime-client/runtime-api';
import { RemoteWriteQueue } from './remote-write-queue';
import { runtimeSessionStore } from './runtimeSession';
import type { File, FileMap } from './files';

const logger = createScopedLogger('RemoteFilesStore');
const utf8TextDecoder = new TextDecoder('utf8', { fatal: true });

const LOCK_REFRESH_INTERVAL_MS = 30_000;
export const REMOTE_REFRESH_VISIBLE_INTERVAL_MS = 20_000;
export const REMOTE_REFRESH_HIDDEN_BACKOFF_MS = [20_000, 40_000, 80_000, 160_000, 300_000] as const;
export const DIRECTORY_CACHE_TTL_MS = 2_000;

export interface DirectoryCacheEntry {
  runtimeToken: string;
  runtimePath: string;
  expiresAt: number;
  entries: RuntimeFileEntry[];
}

export interface RefreshBackoffState {
  hiddenAttempt: number;
  lastDelayMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface RemoteFilesStoreOptions {
  autoInit?: boolean;
  enableDomObservers?: boolean;
  enableRefreshScheduler?: boolean;
  writeDebounceMs?: number;
  directoryCacheTtlMs?: number;
}

const defaultOptions: Required<RemoteFilesStoreOptions> = {
  autoInit: true,
  enableDomObservers: true,
  enableRefreshScheduler: true,
  writeDebounceMs: 200,
  directoryCacheTtlMs: DIRECTORY_CACHE_TTL_MS,
};

export const getHiddenRefreshDelayMs = (hiddenAttempt: number) => {
  const normalizedIndex = Math.max(0, Math.min(hiddenAttempt, REMOTE_REFRESH_HIDDEN_BACKOFF_MS.length - 1));
  return REMOTE_REFRESH_HIDDEN_BACKOFF_MS[normalizedIndex];
};

export class RemoteFilesStore {
  #size = 0;
  #modifiedFiles: Map<string, string> = import.meta.hot?.data.remoteModifiedFiles ?? new Map();
  #loadedFileContent = import.meta.hot?.data.remoteLoadedFileContent ?? new Set<string>();
  #lastRuntimeToken = import.meta.hot?.data.remoteRuntimeToken as string | undefined;
  #options: Required<RemoteFilesStoreOptions>;
  #writeQueue: RemoteWriteQueue;
  #refreshInFlight?: Promise<void>;
  #directoryCache = new Map<string, DirectoryCacheEntry>();
  #directoryListInFlight = new Map<string, Promise<RuntimeFileEntry[]>>();
  #refreshBackoff: RefreshBackoffState = {
    hiddenAttempt: 0,
    lastDelayMs: REMOTE_REFRESH_VISIBLE_INTERVAL_MS,
  };

  files: MapStore<FileMap> = import.meta.hot?.data.remoteFiles ?? map({});

  get filesCount() {
    return this.#size;
  }

  constructor(options: RemoteFilesStoreOptions = {}) {
    this.#options = {
      ...defaultOptions,
      ...options,
    };
    this.#writeQueue = new RemoteWriteQueue({
      debounceMs: this.#options.writeDebounceMs,
      write: async (job) => {
        const runtimeToken = await this.#ensureRuntimeToken();
        await runtimeApi.writeFile(runtimeToken, {
          path: job.path,
          content: job.content,
          encoding: job.encoding,
        });
        this.#invalidateDirectoryCache(runtimeToken);
      },
    });

    if (import.meta.hot) {
      import.meta.hot.data.remoteFiles = this.files;
      import.meta.hot.data.remoteModifiedFiles = this.#modifiedFiles;
      import.meta.hot.data.remoteLoadedFileContent = this.#loadedFileContent;
      import.meta.hot.data.remoteRuntimeToken = this.#lastRuntimeToken;
    }

    this.#loadLockedFiles();

    runtimeSessionStore.sessionState.subscribe((state) => {
      if (!state.runtimeToken) {
        this.#lastRuntimeToken = undefined;
        this.#invalidateDirectoryCache();
        this.#writeQueue.cancel();
        this.files.set({});
        this.#size = 0;
        this.#loadedFileContent.clear();

        return;
      }

      if (state.runtimeToken !== this.#lastRuntimeToken) {
        this.#lastRuntimeToken = state.runtimeToken;
        this.#invalidateDirectoryCache();
        this.#writeQueue.cancel();
        this.refreshFromRemote(true).catch((error) => {
          logger.error('Failed to refresh files after runtime token change', error);
        });
      }
    });

    if (this.#options.enableDomObservers && typeof window !== 'undefined') {
      let lastChatId = getCurrentChatId();

      const observer = new MutationObserver(() => {
        const currentChatId = getCurrentChatId();

        if (currentChatId !== lastChatId) {
          lastChatId = currentChatId;
          this.#loadLockedFiles(currentChatId);

          const nextChatId = currentChatId === 'default' ? undefined : currentChatId;
          runtimeSessionStore
            .ensureSession({ chatId: nextChatId, force: true })
            .then(() => this.refreshFromRemote(true))
            .catch((error: unknown) => {
              logger.warn('Failed to switch runtime session after chat change', error);
            });
        }
      });

      observer.observe(document, { subtree: true, childList: true });
      window.setInterval(() => {
        clearCache();
        this.#loadLockedFiles(getCurrentChatId());
      }, LOCK_REFRESH_INTERVAL_MS);
    }

    if (this.#options.autoInit && typeof window !== 'undefined') {
      this.#init().catch((error) => {
        logger.error('Remote files initialization failed', error);
      });
    }
  }

  getFile(filePath: string) {
    const dirent = this.files.get()[filePath];

    if (!dirent || dirent.type !== 'file') {
      return undefined;
    }

    return dirent;
  }

  getFileOrFolder(filePath: string) {
    return this.files.get()[filePath];
  }

  getFileModifications() {
    return computeFileModifications(this.files.get(), this.#modifiedFiles);
  }

  getModifiedFiles() {
    let modifiedFiles: { [path: string]: File } | undefined = undefined;

    for (const [filePath, originalContent] of this.#modifiedFiles) {
      const file = this.files.get()[filePath];

      if (file?.type !== 'file') {
        continue;
      }

      if (file.content === originalContent) {
        continue;
      }

      if (!modifiedFiles) {
        modifiedFiles = {};
      }

      modifiedFiles[filePath] = file;
    }

    return modifiedFiles;
  }

  resetFileModifications() {
    this.#modifiedFiles.clear();
  }

  async ensureFileContent(filePath: string) {
    const current = this.files.get()[filePath];

    if (!current || current.type !== 'file') {
      return;
    }

    if (this.#loadedFileContent.has(filePath)) {
      return;
    }

    const runtimeToken = await this.#ensureRuntimeToken();
    const runtimePath = toRuntimePath(filePath);

    if (!runtimePath) {
      return;
    }

    const { file } = await runtimeApi.readFile(runtimeToken, runtimePath);
    const nextFile: File = {
      type: 'file',
      content: file.content || '',
      isBinary: file.isBinary,
      isLocked: current.isLocked,
      lockedByFolder: current.lockedByFolder,
    };

    this.files.setKey(filePath, nextFile);
    this.#loadedFileContent.add(filePath);
  }

  async saveFile(filePath: string, content: string) {
    const runtimeToken = await this.#ensureRuntimeToken();
    const runtimePath = toRuntimePath(filePath);

    if (!runtimePath) {
      throw new Error(`EINVAL: invalid file path, write '${runtimePath}'`);
    }

    await this.#ensureRuntimeDirectory(runtimeToken, path.dirname(filePath));
    this.#invalidateDirectoryCache(runtimeToken);

    const previousEntry = this.files.get()[filePath];
    const previousLoaded = this.#loadedFileContent.has(filePath);
    const previousSize = this.#size;
    const hadModified = this.#modifiedFiles.has(filePath);
    const previousModified = this.#modifiedFiles.get(filePath);
    const oldContent = previousEntry?.type === 'file' ? previousEntry.content : '';

    if (!hadModified) {
      this.#modifiedFiles.set(filePath, oldContent);
    }

    const isLocked = previousEntry?.type === 'file' ? previousEntry.isLocked : false;
    const lockedByFolder = previousEntry?.type === 'file' ? previousEntry.lockedByFolder : undefined;

    if (!previousEntry) {
      this.#size += 1;
    }

    this.#ensureFolderTree(filePath);
    this.files.setKey(filePath, {
      type: 'file',
      content,
      isBinary: false,
      isLocked,
      lockedByFolder,
    });
    this.#loadedFileContent.add(filePath);

    try {
      await this.#writeQueue.enqueue({
        filePath,
        path: runtimePath,
        content,
        encoding: 'utf8',
      });
    } catch (error) {
      this.#size = previousSize;

      if (previousEntry) {
        this.files.setKey(filePath, previousEntry);
      } else {
        this.files.setKey(filePath, undefined);
      }

      if (previousLoaded) {
        this.#loadedFileContent.add(filePath);
      } else {
        this.#loadedFileContent.delete(filePath);
      }

      if (hadModified) {
        if (previousModified !== undefined) {
          this.#modifiedFiles.set(filePath, previousModified);
        } else {
          this.#modifiedFiles.delete(filePath);
        }
      } else {
        this.#modifiedFiles.delete(filePath);
      }

      throw error;
    }
  }

  async createFile(filePath: string, content: string | Uint8Array = '') {
    const runtimeToken = await this.#ensureRuntimeToken();
    const runtimePath = toRuntimePath(filePath);

    if (!runtimePath) {
      throw new Error(`EINVAL: invalid file path, create '${runtimePath}'`);
    }

    await this.#ensureRuntimeDirectory(runtimeToken, path.dirname(filePath));
    this.#invalidateDirectoryCache(runtimeToken);

    const isBinary = content instanceof Uint8Array;
    const payloadContent = isBinary ? Buffer.from(content).toString('base64') : (content as string);
    const previousEntry = this.files.get()[filePath];
    const previousLoaded = this.#loadedFileContent.has(filePath);
    const previousSize = this.#size;
    const hadModified = this.#modifiedFiles.has(filePath);
    const previousModified = this.#modifiedFiles.get(filePath);

    this.#ensureFolderTree(filePath);

    if (!previousEntry) {
      this.#size += 1;
    }

    this.files.setKey(filePath, {
      type: 'file',
      content: payloadContent,
      isBinary,
      isLocked: previousEntry?.type === 'file' ? previousEntry.isLocked : false,
      lockedByFolder: previousEntry?.type === 'file' ? previousEntry.lockedByFolder : undefined,
    });
    this.#modifiedFiles.set(filePath, payloadContent);
    this.#loadedFileContent.add(filePath);

    try {
      await this.#writeQueue.enqueue({
        filePath,
        path: runtimePath,
        content: payloadContent,
        encoding: isBinary ? 'base64' : 'utf8',
      });
      return true;
    } catch (error) {
      this.#size = previousSize;

      if (previousEntry) {
        this.files.setKey(filePath, previousEntry);
      } else {
        this.files.setKey(filePath, undefined);
      }

      if (previousLoaded) {
        this.#loadedFileContent.add(filePath);
      } else {
        this.#loadedFileContent.delete(filePath);
      }

      if (hadModified) {
        if (previousModified !== undefined) {
          this.#modifiedFiles.set(filePath, previousModified);
        } else {
          this.#modifiedFiles.delete(filePath);
        }
      } else {
        this.#modifiedFiles.delete(filePath);
      }

      throw error;
    }
  }

  async createFolder(folderPath: string) {
    const runtimeToken = await this.#ensureRuntimeToken();
    const runtimePath = toRuntimePath(folderPath);

    if (!runtimePath) {
      throw new Error(`EINVAL: invalid folder path, create '${runtimePath}'`);
    }

    await this.#ensureRuntimeDirectory(runtimeToken, folderPath);
    this.#invalidateDirectoryCache(runtimeToken);
    this.#ensureFolderTree(folderPath);
    this.files.setKey(folderPath, { type: 'folder' });

    return true;
  }

  async deleteFile(filePath: string) {
    const runtimeToken = await this.#ensureRuntimeToken();
    const runtimePath = toRuntimePath(filePath);

    if (!runtimePath) {
      throw new Error(`EINVAL: invalid file path, delete '${runtimePath}'`);
    }

    await this.#writeQueue.flush(filePath);
    await runtimeApi.delete(runtimeToken, runtimePath, false);
    this.#writeQueue.cancel(filePath);
    this.#invalidateDirectoryCache(runtimeToken);

    const current = this.files.get()[filePath];

    if (current?.type === 'file') {
      this.#size = Math.max(0, this.#size - 1);
    }

    this.files.setKey(filePath, undefined);
    this.#loadedFileContent.delete(filePath);
    this.#modifiedFiles.delete(filePath);

    return true;
  }

  async deleteFolder(folderPath: string) {
    const runtimeToken = await this.#ensureRuntimeToken();
    const runtimePath = toRuntimePath(folderPath);

    if (!runtimePath) {
      throw new Error(`EINVAL: invalid folder path, delete '${runtimePath}'`);
    }

    await this.#writeQueue.flushMatching(
      (entryPath) => entryPath === folderPath || entryPath.startsWith(`${folderPath}/`),
    );
    await runtimeApi.delete(runtimeToken, runtimePath, true);
    this.#writeQueue.cancelMatching((entryPath) => entryPath === folderPath || entryPath.startsWith(`${folderPath}/`));
    this.#invalidateDirectoryCache(runtimeToken);

    const allFiles = this.files.get();
    const updates: FileMap = {};

    for (const [entryPath, entry] of Object.entries(allFiles)) {
      if (entryPath === folderPath || entryPath.startsWith(`${folderPath}/`)) {
        updates[entryPath] = undefined;

        if (entry?.type === 'file') {
          this.#size = Math.max(0, this.#size - 1);
          this.#modifiedFiles.delete(entryPath);
          this.#loadedFileContent.delete(entryPath);
        }
      }
    }

    this.files.set({ ...allFiles, ...updates });

    return true;
  }

  lockFile(filePath: string, chatId?: string) {
    const file = this.getFile(filePath);
    const currentChatId = chatId || getCurrentChatId();

    if (!file) {
      logger.error(`Cannot lock non-existent file: ${filePath}`);
      return false;
    }

    this.files.setKey(filePath, {
      ...file,
      isLocked: true,
    });
    addLockedFile(currentChatId, filePath);

    return true;
  }

  lockFolder(folderPath: string, chatId?: string) {
    const folder = this.getFileOrFolder(folderPath);
    const currentFiles = this.files.get();
    const currentChatId = chatId || getCurrentChatId();

    if (!folder || folder.type !== 'folder') {
      logger.error(`Cannot lock non-existent folder: ${folderPath}`);
      return false;
    }

    const updates: FileMap = {};

    updates[folderPath] = {
      type: folder.type,
      isLocked: true,
    };

    this.#applyLockToFolderContents(currentFiles, updates, folderPath);
    this.files.set({ ...currentFiles, ...updates });
    addLockedFolder(currentChatId, folderPath);

    return true;
  }

  unlockFile(filePath: string, chatId?: string) {
    const file = this.getFile(filePath);
    const currentChatId = chatId || getCurrentChatId();

    if (!file) {
      logger.error(`Cannot unlock non-existent file: ${filePath}`);
      return false;
    }

    this.files.setKey(filePath, {
      ...file,
      isLocked: false,
      lockedByFolder: undefined,
    });
    removeLockedFile(currentChatId, filePath);

    return true;
  }

  unlockFolder(folderPath: string, chatId?: string) {
    const folder = this.getFileOrFolder(folderPath);
    const currentFiles = this.files.get();
    const currentChatId = chatId || getCurrentChatId();

    if (!folder || folder.type !== 'folder') {
      logger.error(`Cannot unlock non-existent folder: ${folderPath}`);
      return false;
    }

    const updates: FileMap = {};
    updates[folderPath] = {
      type: folder.type,
      isLocked: false,
    };

    const folderPrefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;

    Object.entries(currentFiles).forEach(([entryPath, entry]) => {
      if (entryPath.startsWith(folderPrefix) && entry) {
        if (entry.type === 'file' && entry.lockedByFolder === folderPath) {
          updates[entryPath] = {
            ...entry,
            isLocked: false,
            lockedByFolder: undefined,
          };
        } else if (entry.type === 'folder' && entry.lockedByFolder === folderPath) {
          updates[entryPath] = {
            type: entry.type,
            isLocked: false,
            lockedByFolder: undefined,
          };
        }
      }
    });

    this.files.set({ ...currentFiles, ...updates });
    removeLockedFolder(currentChatId, folderPath);

    return true;
  }

  isFileLocked(filePath: string, chatId?: string): { locked: boolean; lockedBy?: string } {
    const file = this.getFile(filePath);
    const currentChatId = chatId || getCurrentChatId();

    if (!file) {
      return { locked: false };
    }

    if (file.isLocked) {
      if (file.lockedByFolder) {
        return { locked: true, lockedBy: file.lockedByFolder as string };
      }

      return { locked: true, lockedBy: filePath };
    }

    const lockedFiles = getLockedFilesForChat(currentChatId);
    const lockedFile = lockedFiles.find((item) => item.path === filePath);

    if (lockedFile) {
      this.files.setKey(filePath, {
        ...file,
        isLocked: true,
      });
      return { locked: true, lockedBy: filePath };
    }

    const folderLockResult = this.isFileInLockedFolder(filePath, currentChatId);

    if (folderLockResult.locked) {
      this.files.setKey(filePath, {
        ...file,
        isLocked: true,
        lockedByFolder: folderLockResult.lockedBy,
      });
      return folderLockResult;
    }

    return { locked: false };
  }

  isFileInLockedFolder(filePath: string, chatId?: string): { locked: boolean; lockedBy?: string } {
    const currentChatId = chatId || getCurrentChatId();
    return isPathInLockedFolder(currentChatId, filePath);
  }

  isFolderLocked(folderPath: string, chatId?: string): { isLocked: boolean; lockedBy?: string } {
    const folder = this.getFileOrFolder(folderPath);
    const currentChatId = chatId || getCurrentChatId();

    if (!folder || folder.type !== 'folder') {
      return { isLocked: false };
    }

    if (folder.isLocked) {
      return { isLocked: true, lockedBy: folderPath };
    }

    const lockedFolders = getLockedFoldersForChat(currentChatId);
    const lockedFolder = lockedFolders.find((item) => item.path === folderPath);

    if (lockedFolder) {
      this.files.setKey(folderPath, {
        type: folder.type,
        isLocked: true,
      });
      return { isLocked: true, lockedBy: folderPath };
    }

    return { isLocked: false };
  }

  async refreshFromRemote(force = false) {
    if (this.#refreshInFlight) {
      return await this.#refreshInFlight;
    }

    this.#refreshInFlight = this.#refreshFromRemoteInternal(force).finally(() => {
      this.#refreshInFlight = undefined;
    });

    return await this.#refreshInFlight;
  }

  async #refreshFromRemoteInternal(force = false) {
    const runtimeToken = await this.#ensureRuntimeToken();
    const nextFiles: FileMap = {
      [WORK_DIR]: { type: 'folder' },
    };
    const nextLoadedContent = new Set<string>();
    const previousLoadedContent = new Set(this.#loadedFileContent);
    let nextSize = 0;

    const walk = async (runtimePath?: string) => {
      const entries = await this.#listDirectory(runtimeToken, runtimePath, force);

      for (const entry of entries || []) {
        const virtualPath = entry.virtualPath || path.join(WORK_DIR, entry.path);

        if (entry.type === 'directory') {
          nextFiles[virtualPath] = { type: 'folder' };
          await walk(entry.path);
          continue;
        }

        nextFiles[virtualPath] = {
          type: 'file',
          content: '',
          isBinary: false,
          isLocked: this.getFile(virtualPath)?.isLocked,
          lockedByFolder: this.getFile(virtualPath)?.lockedByFolder,
        };
        nextSize += 1;
      }
    };

    await walk(undefined);

    const previousFiles = this.files.get();

    for (const [filePath, entry] of Object.entries(nextFiles)) {
      if (entry?.type !== 'file') {
        continue;
      }

      const previous = previousFiles[filePath];

      if (previous?.type === 'file' && previousLoadedContent.has(filePath)) {
        nextFiles[filePath] = {
          ...entry,
          content: previous.content,
          isBinary: previous.isBinary,
          isLocked: previous.isLocked,
          lockedByFolder: previous.lockedByFolder,
        };
        nextLoadedContent.add(filePath);
      }
    }

    this.files.set(nextFiles);
    this.#size = nextSize;
    this.#loadedFileContent = nextLoadedContent;
    this.#loadLockedFiles();
  }

  async #init() {
    const currentChatId = getCurrentChatId();
    await runtimeSessionStore.ensureSession({
      chatId: currentChatId === 'default' ? undefined : currentChatId,
    });
    await this.refreshFromRemote(true);

    if (this.#options.enableRefreshScheduler && typeof window !== 'undefined') {
      this.#startRefreshScheduler();
    }
  }

  #startRefreshScheduler() {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    document.addEventListener('visibilitychange', this.#handleVisibilityChange);
    this.#scheduleNextRefresh();
  }

  #handleVisibilityChange = () => {
    if (typeof document === 'undefined' || document.hidden) {
      return;
    }

    this.#refreshBackoff.hiddenAttempt = 0;

    this.refreshFromRemote(true)
      .catch((error) => {
        logger.warn('Failed to refresh remote files after tab became visible', error);
      })
      .finally(() => {
        this.#scheduleNextRefresh();
      });
  };

  #scheduleNextRefresh() {
    if (typeof window === 'undefined') {
      return;
    }

    if (this.#refreshBackoff.timer) {
      clearTimeout(this.#refreshBackoff.timer);
      this.#refreshBackoff.timer = undefined;
    }

    const hidden = typeof document !== 'undefined' && document.hidden;
    const delayMs = hidden
      ? getHiddenRefreshDelayMs(this.#refreshBackoff.hiddenAttempt)
      : REMOTE_REFRESH_VISIBLE_INTERVAL_MS;

    if (hidden) {
      this.#refreshBackoff.hiddenAttempt = Math.min(
        this.#refreshBackoff.hiddenAttempt + 1,
        REMOTE_REFRESH_HIDDEN_BACKOFF_MS.length - 1,
      );
    } else {
      this.#refreshBackoff.hiddenAttempt = 0;
    }

    this.#refreshBackoff.lastDelayMs = delayMs;
    this.#refreshBackoff.timer = setTimeout(() => {
      this.#refreshBackoff.timer = undefined;
      this.refreshFromRemote()
        .catch((error) => {
          logger.warn('Periodic remote file refresh failed', error);
        })
        .finally(() => {
          this.#scheduleNextRefresh();
        });
    }, delayMs);
  }

  #getDirectoryCacheKey(runtimeToken: string, runtimePath?: string) {
    return `${runtimeToken}:${runtimePath || ''}`;
  }

  #invalidateDirectoryCache(runtimeToken?: string) {
    if (!runtimeToken) {
      this.#directoryCache.clear();
      this.#directoryListInFlight.clear();

      return;
    }

    const runtimePrefix = `${runtimeToken}:`;

    for (const key of this.#directoryCache.keys()) {
      if (key.startsWith(runtimePrefix)) {
        this.#directoryCache.delete(key);
      }
    }

    for (const key of this.#directoryListInFlight.keys()) {
      if (key.startsWith(runtimePrefix)) {
        this.#directoryListInFlight.delete(key);
      }
    }
  }

  async #listDirectory(runtimeToken: string, runtimePath?: string, force = false): Promise<RuntimeFileEntry[]> {
    const cacheKey = this.#getDirectoryCacheKey(runtimeToken, runtimePath);
    const now = Date.now();

    if (!force) {
      const cached = this.#directoryCache.get(cacheKey);

      if (cached && cached.expiresAt > now) {
        return cached.entries;
      }

      const inFlight = this.#directoryListInFlight.get(cacheKey);

      if (inFlight) {
        return await inFlight;
      }
    }

    const requestPromise = runtimeApi
      .listFiles(runtimeToken, runtimePath)
      .then((response) => {
        const entries = response.entries || [];
        this.#directoryCache.set(cacheKey, {
          runtimeToken,
          runtimePath: runtimePath || '',
          expiresAt: now + this.#options.directoryCacheTtlMs,
          entries,
        });

        return entries;
      })
      .finally(() => {
        this.#directoryListInFlight.delete(cacheKey);
      });

    this.#directoryListInFlight.set(cacheKey, requestPromise);

    return await requestPromise;
  }

  async #ensureRuntimeToken() {
    await runtimeSessionStore.ensureSession();

    const runtimeToken = runtimeSessionStore.runtimeToken;

    if (!runtimeToken) {
      throw new Error('Runtime session token is not available');
    }

    return runtimeToken;
  }

  async #ensureRuntimeDirectory(runtimeToken: string, virtualPath: string) {
    const runtimePath = toRuntimePath(virtualPath);

    if (!runtimePath || runtimePath === '.') {
      return;
    }

    const segments = runtimePath.split('/').filter(Boolean);
    let current = '';

    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;

      try {
        await runtimeApi.mkdir(runtimeToken, current);
      } catch {
        // ignore if directory already exists or cannot be created again
      }
    }
  }

  #ensureFolderTree(targetPath: string) {
    const currentFiles = this.files.get();
    const updates: FileMap = {};
    const segments = targetPath.split('/').filter(Boolean);

    if (segments.length === 0) {
      return;
    }

    let currentPath = '';

    for (let index = 0; index < segments.length - 1; index++) {
      currentPath += `/${segments[index]}`;

      if (!currentFiles[currentPath]) {
        updates[currentPath] = { type: 'folder' };
      }
    }

    if (Object.keys(updates).length > 0) {
      this.files.set({ ...currentFiles, ...updates });
    }
  }

  #loadLockedFiles(chatId?: string) {
    try {
      const currentChatId = chatId || getCurrentChatId();
      migrateLegacyLocks(currentChatId);

      const lockedItems = getLockedItemsForChat(currentChatId);

      if (lockedItems.length === 0) {
        return;
      }

      const lockedFiles = lockedItems.filter((item) => !item.isFolder);
      const lockedFolders = lockedItems.filter((item) => item.isFolder);
      const currentFiles = this.files.get();
      const updates: FileMap = {};

      for (const lockedFile of lockedFiles) {
        const file = currentFiles[lockedFile.path];

        if (file?.type === 'file') {
          updates[lockedFile.path] = {
            ...file,
            isLocked: true,
          };
        }
      }

      for (const lockedFolder of lockedFolders) {
        const folder = currentFiles[lockedFolder.path];

        if (folder?.type === 'folder') {
          updates[lockedFolder.path] = {
            ...folder,
            isLocked: true,
          };
          this.#applyLockToFolderContents(currentFiles, updates, lockedFolder.path);
        }
      }

      if (Object.keys(updates).length > 0) {
        this.files.set({ ...currentFiles, ...updates });
      }
    } catch (error) {
      logger.error('Failed to load locked files from localStorage', error);
    }
  }

  #applyLockToFolderContents(currentFiles: FileMap, updates: FileMap, folderPath: string) {
    const folderPrefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;

    Object.entries(currentFiles).forEach(([entryPath, entry]) => {
      if (!entryPath.startsWith(folderPrefix) || !entry) {
        return;
      }

      if (entry.type === 'file') {
        updates[entryPath] = {
          ...entry,
          isLocked: true,
          lockedByFolder: folderPath,
        };
        return;
      }

      updates[entryPath] = {
        ...entry,
        isLocked: true,
        lockedByFolder: folderPath,
      };
    });
  }
}

function isBinaryFile(buffer: Uint8Array | undefined) {
  if (buffer === undefined) {
    return false;
  }

  return getEncoding(convertToBuffer(buffer), { chunkLength: 100 }) === 'binary';
}

function convertToBuffer(view: Uint8Array): Buffer {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

export const decodeRemoteFileContent = (buffer?: Uint8Array) => {
  if (!buffer || buffer.byteLength === 0) {
    return '';
  }

  if (isBinaryFile(buffer)) {
    return Buffer.from(buffer).toString('base64');
  }

  try {
    return utf8TextDecoder.decode(buffer);
  } catch {
    return '';
  }
};
