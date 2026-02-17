import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeApiMocks = vi.hoisted(() => ({
  redeploy: vi.fn(),
}));

type SessionStateValue = {
  provider: 'dokploy';
  state: 'idle' | 'creating' | 'ready' | 'error';
  runtimeToken?: string;
  session?: {
    status?: 'creating' | 'deploying' | 'ready' | 'error' | 'deleted';
    previewUrl?: string;
    composeId?: string;
  };
  deploymentStatus?: 'queued' | 'running' | 'done' | 'error';
  sessionStatus?: 'creating' | 'deploying' | 'ready' | 'error' | 'deleted';
  error?: string;
};

type SessionListener = (value: SessionStateValue) => void;

const sessionState = vi.hoisted(() => {
  let value: SessionStateValue = {
    provider: 'dokploy',
    state: 'idle',
  };
  const listeners = new Set<SessionListener>();

  return {
    get() {
      return value;
    },
    set(nextValue: SessionStateValue) {
      value = nextValue;

      for (const listener of listeners) {
        listener(value);
      }
    },
    subscribe(listener: SessionListener) {
      listeners.add(listener);
      listener(value);

      return () => listeners.delete(listener);
    },
  };
});

const runtimeSessionStoreMock = vi.hoisted(() => ({
  refreshSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/lib/runtime-client/runtime-api', () => ({
  runtimeApi: {
    redeploy: runtimeApiMocks.redeploy,
  },
}));

vi.mock('./runtimeSession', () => ({
  runtimeSessionStore: {
    sessionState,
    refreshSession: runtimeSessionStoreMock.refreshSession,
  },
}));

import { QUEUED_TIMEOUT_MS, RemotePreviewsStore, deriveRemotePreviewStatus } from './previews.remote';

describe('RemotePreviewsStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T00:00:00.000Z'));
    sessionState.set({
      provider: 'dokploy',
      state: 'idle',
    });
    runtimeApiMocks.redeploy.mockReset();
    runtimeApiMocks.redeploy.mockResolvedValue({ queued: true });
    runtimeSessionStoreMock.refreshSession.mockReset();
    runtimeSessionStoreMock.refreshSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps creating state to provisioning', () => {
    const result = deriveRemotePreviewStatus({
      provider: 'dokploy',
      state: 'creating',
      sessionStatus: 'creating',
    } as any);

    expect(result.snapshot.state).toBe('provisioning');
  });

  it('maps queued/running deployments to deploying', () => {
    const queued = deriveRemotePreviewStatus({
      provider: 'dokploy',
      state: 'ready',
      runtimeToken: 'runtime-token',
      deploymentStatus: 'queued',
      sessionStatus: 'deploying',
      session: {
        composeId: 'compose-1',
        previewUrl: 'http://preview.local',
      },
    } as any);
    const running = deriveRemotePreviewStatus({
      provider: 'dokploy',
      state: 'ready',
      runtimeToken: 'runtime-token',
      deploymentStatus: 'running',
      sessionStatus: 'deploying',
      session: {
        composeId: 'compose-1',
        previewUrl: 'http://preview.local',
      },
    } as any);

    expect(queued.snapshot.state).toBe('deploying');
    expect(running.snapshot.state).toBe('deploying');
  });

  it('maps done + ready to ready', () => {
    const result = deriveRemotePreviewStatus({
      provider: 'dokploy',
      state: 'ready',
      runtimeToken: 'runtime-token',
      deploymentStatus: 'done',
      sessionStatus: 'ready',
      session: {
        composeId: 'compose-1',
        status: 'ready',
        previewUrl: 'http://preview.local',
      },
    } as any);

    expect(result.snapshot.state).toBe('ready');
  });

  it('transitions from reconnecting to ready after transient error recovery', () => {
    const healthy = deriveRemotePreviewStatus(
      {
        provider: 'dokploy',
        state: 'ready',
        runtimeToken: 'runtime-token',
        deploymentStatus: 'done',
        sessionStatus: 'ready',
        session: {
          composeId: 'compose-1',
          status: 'ready',
          previewUrl: 'http://preview.local',
        },
      } as any,
      undefined,
      { now: 1000 },
    );
    const reconnecting = deriveRemotePreviewStatus(
      {
        provider: 'dokploy',
        state: 'error',
        runtimeToken: 'runtime-token',
        deploymentStatus: 'error',
        sessionStatus: 'error',
        session: {
          composeId: 'compose-1',
          status: 'error',
          previewUrl: 'http://preview.local',
        },
      } as any,
      healthy.memory,
      { now: 4000 },
    );
    const recovered = deriveRemotePreviewStatus(
      {
        provider: 'dokploy',
        state: 'ready',
        runtimeToken: 'runtime-token',
        deploymentStatus: 'done',
        sessionStatus: 'ready',
        session: {
          composeId: 'compose-1',
          status: 'ready',
          previewUrl: 'http://preview.local',
        },
      } as any,
      reconnecting.memory,
      { now: 6000 },
    );

    expect(reconnecting.snapshot.state).toBe('reconnecting');
    expect(recovered.snapshot.state).toBe('ready');
  });

  it('triggers a single auto-redeploy when queued exceeds timeout and then transitions to error if still queued', async () => {
    sessionState.set({
      provider: 'dokploy',
      state: 'ready',
      runtimeToken: 'runtime-token',
      deploymentStatus: 'queued',
      sessionStatus: 'deploying',
      session: {
        composeId: 'compose-1',
        previewUrl: 'http://preview.local',
      },
    });

    const store = new RemotePreviewsStore();

    vi.setSystemTime(new Date('2026-02-17T00:03:00.001Z'));
    sessionState.set({
      ...sessionState.get(),
    });
    await Promise.resolve();

    expect(runtimeApiMocks.redeploy).toHaveBeenCalledTimes(1);
    expect(runtimeApiMocks.redeploy).toHaveBeenCalledWith('runtime-token', 'queued_timeout_auto_retry');

    vi.setSystemTime(new Date('2026-02-17T00:06:00.005Z'));
    sessionState.set({
      ...sessionState.get(),
    });

    expect(runtimeApiMocks.redeploy).toHaveBeenCalledTimes(1);
    expect(store.status.get().state).toBe('error');
    expect(store.status.get().message).toContain('tempo limite');
  });

  it('calls runtimeSessionStore.refreshSession from refreshAllPreviews', async () => {
    const store = new RemotePreviewsStore();
    store.refreshAllPreviews();
    await Promise.resolve();

    expect(runtimeSessionStoreMock.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('uses queued timeout default of 180 seconds', () => {
    expect(QUEUED_TIMEOUT_MS).toBe(180_000);
  });
});
