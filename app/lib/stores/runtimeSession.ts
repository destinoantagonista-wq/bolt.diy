import { atom, type WritableAtom } from 'nanostores';
import { isDokployRuntime } from '~/lib/runtime-provider';
import {
  isRuntimeApiError,
  runtimeApi,
  type RuntimeDeployStatus,
  type RuntimeSession,
  type RuntimeSessionStatus,
} from '~/lib/runtime-client/runtime-api';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('RuntimeSessionStore');
const DRAFT_CHAT_STORAGE_KEY = 'bolt_runtime_draft_chat_id';

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value || '', 10);

  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
};

const HEARTBEAT_SECONDS = parsePositiveInt(import.meta.env.VITE_RUNTIME_HEARTBEAT_SEC, 30);

export type RuntimeConnectionState = 'idle' | 'creating' | 'ready' | 'error';

export interface RuntimeSessionState {
  provider: 'webcontainer' | 'dokploy';
  state: RuntimeConnectionState;
  chatId?: string;
  runtimeToken?: string;
  session?: RuntimeSession;
  deploymentStatus?: RuntimeDeployStatus;
  sessionStatus?: RuntimeSessionStatus;
  error?: string;
}

const initialState: RuntimeSessionState = {
  provider: isDokployRuntime ? 'dokploy' : 'webcontainer',
  state: 'idle',
};

export class RuntimeSessionStore {
  #createSessionPromise?: Promise<RuntimeSession | undefined>;
  #heartbeatTimer?: ReturnType<typeof setInterval>;
  #statusTimer?: ReturnType<typeof setInterval>;
  #lifecycleBound = false;

  sessionState: WritableAtom<RuntimeSessionState> = import.meta.hot?.data.runtimeSessionState ?? atom(initialState);

  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.runtimeSessionState = this.sessionState;
    }
  }

  get runtimeToken() {
    return this.sessionState.get().runtimeToken;
  }

  get session() {
    return this.sessionState.get().session;
  }

  async ensureSession(input?: {
    chatId?: string;
    templateId?: string;
    force?: boolean;
  }): Promise<RuntimeSession | undefined> {
    if (!isDokployRuntime) {
      return undefined;
    }

    const chatId = this.#resolveChatId(input?.chatId);
    const current = this.sessionState.get();
    const shouldReplace = Boolean(current.runtimeToken && (input?.force || current.chatId !== chatId));

    if (!input?.force && current.runtimeToken && current.chatId === chatId && current.session) {
      return current.session;
    }

    if (this.#createSessionPromise) {
      if (shouldReplace) {
        await this.#createSessionPromise.catch(() => undefined);
        return this.ensureSession(input);
      }

      return this.#createSessionPromise;
    }

    if (shouldReplace && current.runtimeToken) {
      try {
        await runtimeApi.deleteSession(current.runtimeToken);
      } catch (error) {
        logger.warn('Failed to delete previous runtime session before switching chat', error);
      }
    }

    this.sessionState.set({
      provider: 'dokploy',
      chatId,
      state: 'creating',
      runtimeToken: undefined,
      session: undefined,
      deploymentStatus: undefined,
      sessionStatus: 'creating',
      error: undefined,
    });

    this.#createSessionPromise = runtimeApi
      .createSession({
        chatId,
        templateId: input?.templateId,
      })
      .then((result) => {
        this.sessionState.set({
          provider: 'dokploy',
          state: 'ready',
          chatId,
          runtimeToken: result.runtimeToken,
          session: result.session,
          deploymentStatus: result.deploymentStatus,
          sessionStatus: result.session.status,
        });
        this.#bindLifecycleEvents();
        this.#startTimers();

        return result.session;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to create runtime session';
        logger.error('Failed to create runtime session', error);
        this.sessionState.set({
          provider: 'dokploy',
          state: 'error',
          chatId,
          error: message,
        });
        throw error;
      })
      .finally(() => {
        this.#createSessionPromise = undefined;
      });

    return this.#createSessionPromise;
  }

  async refreshSession() {
    if (!isDokployRuntime) {
      return undefined;
    }

    const current = this.sessionState.get();

    if (!current.runtimeToken) {
      return undefined;
    }

    try {
      const result = await runtimeApi.getSession(current.runtimeToken);
      this.sessionState.set({
        ...current,
        state: 'ready',
        session: result.session,
        deploymentStatus: result.deploymentStatus,
        sessionStatus: result.sessionStatus,
        error: undefined,
      });

      return result;
    } catch (error) {
      logger.error('Failed to refresh runtime session', error);

      if (isRuntimeApiError(error) && error.status === 401) {
        this.#reset();
      } else {
        this.sessionState.set({
          ...current,
          state: 'error',
          error: error instanceof Error ? error.message : 'Failed to refresh runtime session',
        });
      }

      throw error;
    }
  }

  async heartbeat() {
    if (!isDokployRuntime) {
      return undefined;
    }

    const current = this.sessionState.get();

    if (!current.runtimeToken) {
      return undefined;
    }

    const result = await runtimeApi.heartbeat(current.runtimeToken);
    const updatedSession = current.session
      ? {
          ...current.session,
          expiresAt: result.expiresAt,
        }
      : current.session;

    this.sessionState.set({
      ...current,
      state: 'ready',
      session: updatedSession,
      sessionStatus: result.status,
      error: undefined,
    });

    return result;
  }

  async teardownSession() {
    if (!isDokployRuntime) {
      return;
    }

    const token = this.sessionState.get().runtimeToken;

    if (token) {
      try {
        await runtimeApi.deleteSession(token);
      } catch (error) {
        logger.warn('Failed to delete runtime session', error);
      }
    }

    this.#reset();
  }

  #readChatIdFromUrl() {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const match = window.location.pathname.match(/^\/chat\/([^/?#]+)/);

    return match ? decodeURIComponent(match[1]) : undefined;
  }

  #resolveChatId(explicitChatId?: string) {
    if (explicitChatId && explicitChatId.trim().length > 0) {
      return explicitChatId.trim();
    }

    const urlChatId = this.#readChatIdFromUrl();

    if (urlChatId) {
      return urlChatId;
    }

    if (typeof sessionStorage !== 'undefined') {
      const stored = sessionStorage.getItem(DRAFT_CHAT_STORAGE_KEY);

      if (stored) {
        return stored;
      }

      const nextDraft = `draft-${crypto.randomUUID().slice(0, 12)}`;
      sessionStorage.setItem(DRAFT_CHAT_STORAGE_KEY, nextDraft);

      return nextDraft;
    }

    return `draft-${crypto.randomUUID().slice(0, 12)}`;
  }

  #bindLifecycleEvents() {
    if (this.#lifecycleBound || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    window.addEventListener('beforeunload', this.#handleBeforeUnload);
    document.addEventListener('visibilitychange', this.#handleVisibilityChange);
    this.#lifecycleBound = true;
  }

  #startTimers() {
    if (this.#heartbeatTimer || this.#statusTimer) {
      return;
    }

    this.#heartbeatTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }

      this.heartbeat().catch((error) => {
        logger.warn('Runtime heartbeat failed', error);
      });
    }, HEARTBEAT_SECONDS * 1000);

    this.#statusTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }

      const state = this.sessionState.get();

      if (!state.runtimeToken) {
        return;
      }

      this.refreshSession().catch((error) => {
        logger.warn('Runtime status refresh failed', error);
      });
    }, 4000);
  }

  #stopTimers() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }

    if (this.#statusTimer) {
      clearInterval(this.#statusTimer);
      this.#statusTimer = undefined;
    }
  }

  #reset() {
    this.#stopTimers();
    this.sessionState.set({
      provider: 'dokploy',
      state: 'idle',
    });
  }

  #handleBeforeUnload = () => {
    const token = this.sessionState.get().runtimeToken;

    if (token) {
      runtimeApi.deleteSessionWithBeacon(token);
    }
  };

  #handleVisibilityChange = () => {
    if (typeof document === 'undefined' || document.hidden) {
      return;
    }

    this.heartbeat()
      .then(() => this.refreshSession())
      .catch((error) => {
        logger.warn('Failed to refresh runtime after tab visibility change', error);
      });
  };
}

export const runtimeSessionStore = new RuntimeSessionStore();
