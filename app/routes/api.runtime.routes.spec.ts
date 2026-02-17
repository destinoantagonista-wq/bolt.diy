import { beforeEach, describe, expect, it, vi } from 'vitest';

const orchestratorMocks = vi.hoisted(() => ({
  createRuntimeSession: vi.fn(),
  deleteRuntimeSession: vi.fn(),
  getRuntimeSession: vi.fn(),
  heartbeatRuntimeSession: vi.fn(),
  withRuntimeClaims: vi.fn(),
}));

const dokployMocks = vi.hoisted(() => ({
  fileList: vi.fn(),
  fileRead: vi.fn(),
  fileWrite: vi.fn(),
  fileMkdir: vi.fn(),
  fileDelete: vi.fn(),
  fileSearch: vi.fn(),
  composeRedeploy: vi.fn(),
  projectAll: vi.fn(),
}));

vi.mock('~/lib/.server/runtime/session-orchestrator', async () => {
  const actual = await vi.importActual<typeof import('~/lib/.server/runtime/session-orchestrator')>(
    '~/lib/.server/runtime/session-orchestrator',
  );

  return {
    ...actual,
    createRuntimeSession: orchestratorMocks.createRuntimeSession,
    deleteRuntimeSession: orchestratorMocks.deleteRuntimeSession,
    getRuntimeSession: orchestratorMocks.getRuntimeSession,
    heartbeatRuntimeSession: orchestratorMocks.heartbeatRuntimeSession,
    withRuntimeClaims: orchestratorMocks.withRuntimeClaims,
  };
});

vi.mock('~/lib/.server/runtime/dokploy-client', async () => {
  const actual = await vi.importActual<typeof import('~/lib/.server/runtime/dokploy-client')>(
    '~/lib/.server/runtime/dokploy-client',
  );

  class MockDokployClient {
    fileList = dokployMocks.fileList;
    fileRead = dokployMocks.fileRead;
    fileWrite = dokployMocks.fileWrite;
    fileMkdir = dokployMocks.fileMkdir;
    fileDelete = dokployMocks.fileDelete;
    fileSearch = dokployMocks.fileSearch;
    composeRedeploy = dokployMocks.composeRedeploy;
    projectAll = dokployMocks.projectAll;
  }

  return {
    ...actual,
    DokployClient: MockDokployClient as unknown as typeof actual.DokployClient,
  };
});

import { DokployClientError } from '~/lib/.server/runtime/dokploy-client';
import * as runtimeSessionRoute from './api.runtime.session';
import * as runtimeFilesReadRoute from './api.runtime.files.read';
import * as runtimeFilesWriteRoute from './api.runtime.files.write';
import * as runtimeFilesListRoute from './api.runtime.files.list';
import * as runtimeFilesSearchRoute from './api.runtime.files.search';
import * as runtimeDeployRedeployRoute from './api.runtime.deploy.redeploy';
import * as runtimeCleanupRoute from './api.runtime.cleanup';

const runtimeEnv = {
  RUNTIME_PROVIDER: 'dokploy',
  DOKPLOY_BASE_URL: 'https://dokploy.local',
  DOKPLOY_API_KEY: 'secret',
  RUNTIME_TOKEN_SECRET: 'runtime-secret',
};

const contextWithEnv = (overrides?: Record<string, string>) =>
  ({
    cloudflare: {
      env: {
        ...runtimeEnv,
        ...(overrides || {}),
      },
    },
  }) as any;

const json = async (response: Response) => {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
};

describe('runtime routes contracts', () => {
  beforeEach(() => {
    for (const mockFn of Object.values(orchestratorMocks)) {
      mockFn.mockReset();
    }

    for (const mockFn of Object.values(dokployMocks)) {
      mockFn.mockReset();
    }

    orchestratorMocks.withRuntimeClaims.mockResolvedValue({
      composeId: 'compose-1',
      actorId: 'actor-1',
      chatId: 'chat-1',
      projectId: 'project-1',
      environmentId: 'env-1',
      domain: 'preview.runtime.test',
    });
  });

  it('returns 405 for unsupported session method', async () => {
    const request = new Request('https://bolt.local/api/runtime/session', { method: 'PATCH' });
    const response = await runtimeSessionRoute.action({
      request,
      context: contextWithEnv(),
      params: {},
    } as any);

    expect(response.status).toBe(405);
  });

  it('returns 400 for session create without chatId', async () => {
    const request = new Request('https://bolt.local/api/runtime/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await runtimeSessionRoute.action({
      request,
      context: contextWithEnv(),
      params: {},
    } as any);

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: 'chatId is required' });
  });

  it('returns rollout cohort and server id in session create response', async () => {
    orchestratorMocks.createRuntimeSession.mockResolvedValue({
      runtimeToken: 'runtime-token-1',
      deploymentStatus: 'queued',
      session: {
        projectId: 'project-1',
        environmentId: 'env-1',
        composeId: 'compose-1',
        domain: 'preview.runtime.test',
        previewUrl: 'http://preview.runtime.test',
        status: 'deploying',
        expiresAt: '2026-02-17T12:00:00.000Z',
        serverId: 'server-canary',
        rolloutCohort: 'canary',
      },
    });

    const request = new Request('https://bolt.local/api/runtime/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId: 'chat-create',
      }),
    });

    const response = await runtimeSessionRoute.action({
      request,
      context: contextWithEnv(),
      params: {},
    } as any);

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      runtimeToken: 'runtime-token-1',
      deploymentStatus: 'queued',
      session: {
        serverId: 'server-canary',
        rolloutCohort: 'canary',
      },
    });
  });

  it('returns 401 for runtime token missing in file write', async () => {
    const request = new Request('https://bolt.local/api/runtime/files/write', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/home/project/src/main.ts',
        content: 'console.log("hello")',
      }),
    });

    const response = await runtimeFilesWriteRoute.action({
      request,
      context: contextWithEnv(),
      params: {},
    } as any);

    expect(response.status).toBe(401);
  });

  it('returns 400 when read path has traversal', async () => {
    const request = new Request('https://bolt.local/api/runtime/files/read?path=..%2Fsecret&runtimeToken=t', {
      method: 'GET',
      headers: { Authorization: 'Bearer token-1' },
    });

    const response = await runtimeFilesReadRoute.loader({
      request,
      context: contextWithEnv(),
      params: {},
    } as any);

    expect(response.status).toBe(400);
  });

  it('returns 403 when redeploy is forbidden by upstream', async () => {
    dokployMocks.composeRedeploy.mockRejectedValue(new DokployClientError('forbidden', 403, 'FORBIDDEN'));

    const request = new Request('https://bolt.local/api/runtime/deploy/redeploy', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reason: 'manual' }),
    });

    const response = await runtimeDeployRedeployRoute.action({
      request,
      context: contextWithEnv(),
      params: {},
    } as any);

    expect(response.status).toBe(403);
  });

  it('returns 404 when list endpoint receives not found from upstream', async () => {
    dokployMocks.fileList.mockRejectedValue(new DokployClientError('not found', 404, 'NOT_FOUND'));

    const request = new Request('https://bolt.local/api/runtime/files/list?path=src', {
      method: 'GET',
      headers: { Authorization: 'Bearer token-1' },
    });

    const response = await runtimeFilesListRoute.loader({
      request,
      context: contextWithEnv(),
      params: {},
    } as any);

    expect(response.status).toBe(404);
  });

  it('returns 500 for unexpected errors in search endpoint', async () => {
    orchestratorMocks.withRuntimeClaims.mockRejectedValue(new Error('unexpected failure'));

    const request = new Request('https://bolt.local/api/runtime/files/search?query=main.ts', {
      method: 'GET',
      headers: { Authorization: 'Bearer token-1' },
    });

    const response = await runtimeFilesSearchRoute.loader({
      request,
      context: contextWithEnv(),
      params: {},
    } as any);

    expect(response.status).toBe(500);
  });

  it('returns 200 for successful write endpoint', async () => {
    dokployMocks.fileWrite.mockResolvedValue({});

    const request = new Request('https://bolt.local/api/runtime/files/write', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer token-1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/home/project/src/main.ts',
        content: 'console.log("ok")',
        encoding: 'utf8',
      }),
    });

    const response = await runtimeFilesWriteRoute.action({
      request,
      context: contextWithEnv(),
      params: {},
    } as any);

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true });
  });

  it('returns 401 for cleanup without valid secret', async () => {
    const request = new Request('https://bolt.local/api/runtime/cleanup', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const response = await runtimeCleanupRoute.action({
      request,
      context: contextWithEnv({
        RUNTIME_CLEANUP_SECRET: 'cleanup-secret',
      }),
      params: {},
    } as any);

    expect(response.status).toBe(401);
  });
});
