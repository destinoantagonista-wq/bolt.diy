import { atom } from 'nanostores';
import { runtimeApi } from '~/lib/runtime-client/runtime-api';
import type { PreviewInfo, PreviewOperationalState, PreviewStatusSnapshot } from './previews';
import { runtimeSessionStore, type RuntimeSessionState } from './runtimeSession';

const RUNTIME_PREVIEW_PORT = 4173;
export const QUEUED_TIMEOUT_MS = 180_000;
export const MAX_AUTO_RETRIES = 1;
export const RECONNECT_GRACE_MS = 30_000;

const DEFAULT_STATUS_MESSAGE: Record<PreviewOperationalState, string> = {
  provisioning: 'Provisionando ambiente remoto',
  deploying: 'Deploy em andamento',
  ready: 'Preview pronto',
  error: 'Preview indisponivel',
  reconnecting: 'Reconectando ao runtime',
};

export interface RemotePreviewStatusMemory {
  sessionKey: string;
  queuedSince?: number;
  reconnectSince?: number;
  retryCount: number;
  lastHealthyAt?: number;
  lastTransitionAt: number;
  lastState: PreviewOperationalState;
}

interface RemotePreviewDeriveOptions {
  now?: number;
  queuedTimeoutMs?: number;
  maxAutoRetry?: number;
  reconnectGraceMs?: number;
}

interface RemotePreviewDeriveResult {
  snapshot: PreviewStatusSnapshot;
  memory: RemotePreviewStatusMemory;
  shouldAutoRedeploy: boolean;
}

const DEFAULT_MEMORY = (): RemotePreviewStatusMemory => {
  const now = Date.now();

  return {
    sessionKey: '',
    retryCount: 0,
    lastTransitionAt: now,
    lastState: 'provisioning',
  };
};

const buildSnapshot = ({
  state,
  retryCount,
  maxRetries,
  queuedSince,
  message,
  lastTransitionAt,
}: {
  state: PreviewOperationalState;
  retryCount: number;
  maxRetries: number;
  queuedSince?: number;
  message?: string;
  lastTransitionAt: number;
}): PreviewStatusSnapshot => {
  return {
    state,
    message: message || DEFAULT_STATUS_MESSAGE[state],
    retryCount,
    maxRetries,
    queuedSince,
    lastTransitionAt,
  };
};

const resolveSessionStatus = (state: RuntimeSessionState) => state.sessionStatus || state.session?.status;

export const deriveRemotePreviewStatus = (
  state: RuntimeSessionState,
  previousMemory?: RemotePreviewStatusMemory,
  options?: RemotePreviewDeriveOptions,
): RemotePreviewDeriveResult => {
  const now = options?.now ?? Date.now();
  const queuedTimeoutMs = options?.queuedTimeoutMs ?? QUEUED_TIMEOUT_MS;
  const maxAutoRetry = options?.maxAutoRetry ?? MAX_AUTO_RETRIES;
  const reconnectGraceMs = options?.reconnectGraceMs ?? RECONNECT_GRACE_MS;
  const sessionStatus = resolveSessionStatus(state);
  const deploymentStatus = state.deploymentStatus;
  const composeId = state.session?.composeId || '';
  const sessionKey = `${state.chatId || ''}:${composeId}`;
  let memory: RemotePreviewStatusMemory = previousMemory ? { ...previousMemory } : DEFAULT_MEMORY();

  if (memory.sessionKey !== sessionKey) {
    memory = {
      sessionKey,
      retryCount: 0,
      lastTransitionAt: now,
      lastState: 'provisioning',
    };
  }

  if (deploymentStatus === 'running' || deploymentStatus === 'done') {
    memory.retryCount = 0;
    memory.queuedSince = undefined;
  } else if (deploymentStatus === 'queued') {
    memory.queuedSince = memory.queuedSince ?? now;
  }

  let shouldAutoRedeploy = false;
  let forcedErrorMessage: string | undefined;

  if (deploymentStatus === 'queued' && memory.queuedSince) {
    const queuedElapsedMs = now - memory.queuedSince;

    if (queuedElapsedMs >= queuedTimeoutMs) {
      if (memory.retryCount < maxAutoRetry) {
        memory.retryCount += 1;
        memory.queuedSince = now;
        shouldAutoRedeploy = true;
      } else {
        forcedErrorMessage = 'Preview indisponivel: deploy ficou em fila acima do tempo limite.';
      }
    }
  }

  let nextState: PreviewOperationalState = 'provisioning';
  let message = DEFAULT_STATUS_MESSAGE.provisioning;
  const hasToken = Boolean(state.runtimeToken);
  const canReconnect = hasToken && typeof memory.lastHealthyAt === 'number';
  const isErrorSignal = state.state === 'error' || sessionStatus === 'error' || deploymentStatus === 'error';

  if (forcedErrorMessage) {
    nextState = 'error';
    message = forcedErrorMessage;
  } else if (isErrorSignal) {
    const reconnectSince = memory.reconnectSince ?? now;
    const reconnectElapsedMs = now - reconnectSince;

    if (canReconnect && reconnectElapsedMs < reconnectGraceMs) {
      nextState = 'reconnecting';
      message = DEFAULT_STATUS_MESSAGE.reconnecting;
      memory.reconnectSince = reconnectSince;
    } else {
      nextState = 'error';
      message = DEFAULT_STATUS_MESSAGE.error;
    }
  } else if (state.state === 'creating' || sessionStatus === 'creating' || (!state.session && !state.runtimeToken)) {
    nextState = 'provisioning';
    message = DEFAULT_STATUS_MESSAGE.provisioning;
    memory.reconnectSince = undefined;
  } else if (deploymentStatus === 'queued' || deploymentStatus === 'running' || sessionStatus === 'deploying') {
    nextState = 'deploying';
    message = DEFAULT_STATUS_MESSAGE.deploying;
    memory.reconnectSince = undefined;
  } else if (
    sessionStatus === 'ready' &&
    (deploymentStatus === 'done' || (deploymentStatus === undefined && typeof memory.lastHealthyAt === 'number'))
  ) {
    nextState = 'ready';
    message = DEFAULT_STATUS_MESSAGE.ready;
    memory.lastHealthyAt = now;
    memory.reconnectSince = undefined;
    memory.queuedSince = undefined;
  } else if (state.session?.previewUrl) {
    nextState = 'deploying';
    message = DEFAULT_STATUS_MESSAGE.deploying;
    memory.reconnectSince = undefined;
  }

  const lastTransitionAt = memory.lastState === nextState ? memory.lastTransitionAt : now;

  memory.lastState = nextState;
  memory.lastTransitionAt = lastTransitionAt;

  return {
    snapshot: buildSnapshot({
      state: nextState,
      retryCount: memory.retryCount,
      maxRetries: maxAutoRetry,
      queuedSince: memory.queuedSince,
      message,
      lastTransitionAt,
    }),
    memory,
    shouldAutoRedeploy,
  };
};

export class RemotePreviewsStore {
  #memory: RemotePreviewStatusMemory = DEFAULT_MEMORY();
  #autoRedeployInFlight?: Promise<void>;

  previews = atom<PreviewInfo[]>([]);
  status = atom<PreviewStatusSnapshot>({
    state: 'provisioning',
    message: DEFAULT_STATUS_MESSAGE.provisioning,
    retryCount: 0,
    maxRetries: MAX_AUTO_RETRIES,
    lastTransitionAt: Date.now(),
  });

  #syncSessionState = () => {
    const state = runtimeSessionStore.sessionState.get();
    const { snapshot, memory, shouldAutoRedeploy } = deriveRemotePreviewStatus(state, this.#memory);
    const previewUrl = state.session?.previewUrl || '';

    this.#memory = memory;
    this.status.set(snapshot);

    if (!previewUrl) {
      this.previews.set([]);
    } else {
      this.previews.set([
        {
          port: RUNTIME_PREVIEW_PORT,
          ready: snapshot.state === 'ready' || snapshot.state === 'deploying' || snapshot.state === 'reconnecting',
          baseUrl: previewUrl,
          operationalState: snapshot.state,
          statusMessage: snapshot.message,
          retryCount: snapshot.retryCount,
          maxRetries: snapshot.maxRetries,
          lastTransitionAt: snapshot.lastTransitionAt,
        },
      ]);
    }

    if (shouldAutoRedeploy && state.runtimeToken) {
      this.#triggerAutoRedeploy(state.runtimeToken);
    }
  };

  constructor() {
    runtimeSessionStore.sessionState.subscribe(this.#syncSessionState);
    this.#syncSessionState();
  }

  refreshAllPreviews() {
    this.#syncSessionState();
    runtimeSessionStore
      .refreshSession()
      .then(() => {
        this.#syncSessionState();
      })
      .catch(() => {
        const current = this.status.get();
        const nextState: PreviewOperationalState = current.state === 'error' ? 'error' : 'reconnecting';

        this.status.set({
          ...current,
          state: nextState,
          message: DEFAULT_STATUS_MESSAGE[nextState],
          lastTransitionAt: Date.now(),
        });
      });
  }

  #triggerAutoRedeploy(runtimeToken: string) {
    if (this.#autoRedeployInFlight) {
      return;
    }

    this.#autoRedeployInFlight = runtimeApi
      .redeploy(runtimeToken, 'queued_timeout_auto_retry')
      .then(() => undefined)
      .catch(() => {
        const current = this.status.get();

        this.status.set({
          ...current,
          state: 'error',
          message: 'Preview indisponivel: falha ao tentar novo deploy automatico.',
          lastTransitionAt: Date.now(),
        });
      })
      .finally(() => {
        this.#autoRedeployInFlight = undefined;
      });
  }
}
