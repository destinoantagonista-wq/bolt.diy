import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeApiMocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  delete: vi.fn(),
  search: vi.fn(),
}));

interface SessionStateSnapshot {
  runtimeToken: string | undefined;
  session: unknown;
  state: 'ready' | 'initializing' | 'error';
}

type SessionStateListener = (value: SessionStateSnapshot) => void;

const sessionState = vi.hoisted(() => {
  let value: SessionStateSnapshot = {
    runtimeToken: 'token-1',
    session: undefined,
    state: 'ready',
  };
  const listeners = new Set<SessionStateListener>();

  return {
    get() {
      return value;
    },
    set(nextValue: SessionStateSnapshot) {
      value = nextValue;

      for (const listener of listeners) {
        listener(value);
      }
    },
    subscribe(listener: SessionStateListener) {
      listeners.add(listener);
      listener(value);

      return () => {
        listeners.delete(listener);
      };
    },
  };
});

const runtimeSessionStoreMock = vi.hoisted(() => ({
  ensureSession: vi.fn().mockResolvedValue(undefined),
  refreshSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/lib/runtime-client/runtime-api', () => ({
  runtimeApi: {
    listFiles: runtimeApiMocks.listFiles,
    readFile: runtimeApiMocks.readFile,
    writeFile: runtimeApiMocks.writeFile,
    mkdir: runtimeApiMocks.mkdir,
    delete: runtimeApiMocks.delete,
    search: runtimeApiMocks.search,
  },
  toRuntimePath: (virtualPath: string) => {
    const normalized = virtualPath.replaceAll('\\', '/');

    if (normalized === '/home/project' || normalized === '/home/project/') {
      return '';
    }

    if (normalized.startsWith('/home/project/')) {
      return normalized.slice('/home/project/'.length);
    }

    return normalized.replace(/^\/+/, '');
  },
}));

vi.mock('./runtimeSession', () => ({
  runtimeSessionStore: {
    sessionState,
    ensureSession: runtimeSessionStoreMock.ensureSession,
    refreshSession: runtimeSessionStoreMock.refreshSession,
    get runtimeToken() {
      return sessionState.get().runtimeToken;
    },
  },
}));

vi.mock('~/lib/persistence/lockedFiles', () => ({
  addLockedFile: vi.fn(),
  addLockedFolder: vi.fn(),
  clearCache: vi.fn(),
  getLockedFilesForChat: vi.fn().mockReturnValue([]),
  getLockedFoldersForChat: vi.fn().mockReturnValue([]),
  getLockedItemsForChat: vi.fn().mockReturnValue([]),
  isPathInLockedFolder: vi.fn().mockReturnValue({ locked: false }),
  migrateLegacyLocks: vi.fn(),
  removeLockedFile: vi.fn(),
  removeLockedFolder: vi.fn(),
}));

vi.mock('~/utils/fileLocks', () => ({
  getCurrentChatId: vi.fn().mockReturnValue('chat-1'),
}));

import { DIRECTORY_CACHE_TTL_MS, RemoteFilesStore, getHiddenRefreshDelayMs } from './files.remote';

describe('RemoteFilesStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T00:00:00.000Z'));
    sessionState.set({
      runtimeToken: 'token-1',
      session: undefined,
      state: 'ready',
    });

    for (const mockFn of Object.values(runtimeApiMocks)) {
      mockFn.mockReset();
    }

    runtimeSessionStoreMock.ensureSession.mockReset();
    runtimeSessionStoreMock.ensureSession.mockResolvedValue(undefined);
    runtimeApiMocks.listFiles.mockResolvedValue({
      entries: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses short directory cache to reduce list round-trips', async () => {
    const store = new RemoteFilesStore({
      autoInit: false,
      enableDomObservers: false,
      enableRefreshScheduler: false,
    });

    await store.refreshFromRemote();
    await store.refreshFromRemote();

    expect(runtimeApiMocks.listFiles).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(DIRECTORY_CACHE_TTL_MS + 100);
    await store.refreshFromRemote();
    expect(runtimeApiMocks.listFiles).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent refresh calls with in-flight lock', async () => {
    let resolveList: ((value: { entries: [] }) => void) | undefined;
    runtimeApiMocks.listFiles.mockImplementation(
      async () =>
        await new Promise<{ entries: [] }>((resolve) => {
          resolveList = resolve;
        }),
    );

    const store = new RemoteFilesStore({
      autoInit: false,
      enableDomObservers: false,
      enableRefreshScheduler: false,
    });

    const first = store.refreshFromRemote(true);
    const second = store.refreshFromRemote(true);

    await vi.waitFor(() => {
      expect(runtimeApiMocks.listFiles).toHaveBeenCalledTimes(1);
    });

    resolveList?.({ entries: [] });
    await Promise.all([first, second]);
  });

  it('exports hidden-tab backoff curve', () => {
    expect(getHiddenRefreshDelayMs(0)).toBe(20_000);
    expect(getHiddenRefreshDelayMs(1)).toBe(40_000);
    expect(getHiddenRefreshDelayMs(2)).toBe(80_000);
    expect(getHiddenRefreshDelayMs(3)).toBe(160_000);
    expect(getHiddenRefreshDelayMs(4)).toBe(300_000);
    expect(getHiddenRefreshDelayMs(999)).toBe(300_000);
  });
});
