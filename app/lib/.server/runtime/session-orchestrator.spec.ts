import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeServerConfig } from './config';
import { formatRuntimeMetadata } from './metadata';

const dokployMocks = vi.hoisted(() => ({
  projectAll: vi.fn(),
  projectOne: vi.fn(),
  projectCreate: vi.fn(),
  projectRemove: vi.fn(),
  composeCreate: vi.fn(),
  composeOne: vi.fn(),
  composeUpdate: vi.fn(),
  composeDeploy: vi.fn(),
  composeRedeploy: vi.fn(),
  composeDelete: vi.fn(),
  deploymentAllByCompose: vi.fn(),
  domainGenerateDomain: vi.fn(),
  domainCreate: vi.fn(),
  domainByComposeId: vi.fn(),
  serverWithSshKey: vi.fn(),
  fileWrite: vi.fn(),
  fileRead: vi.fn(),
  fileList: vi.fn(),
  fileDelete: vi.fn(),
  fileMkdir: vi.fn(),
  fileSearch: vi.fn(),
}));

const cleanupMocks = vi.hoisted(() => ({
  cleanupExpiredActorSessions: vi.fn(),
}));

const tokenMocks = vi.hoisted(() => ({
  signRuntimeToken: vi.fn(),
  verifyRuntimeToken: vi.fn(),
}));

vi.mock('./dokploy-client', () => {
  class DokployClientError extends Error {
    status: number;
    code?: string;
    details?: unknown;

    constructor(message: string, status: number, code?: string, details?: unknown) {
      super(message);
      this.name = 'DokployClientError';
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  class DokployClient {
    projectAll = dokployMocks.projectAll;
    projectOne = dokployMocks.projectOne;
    projectCreate = dokployMocks.projectCreate;
    projectRemove = dokployMocks.projectRemove;
    composeCreate = dokployMocks.composeCreate;
    composeOne = dokployMocks.composeOne;
    composeUpdate = dokployMocks.composeUpdate;
    composeDeploy = dokployMocks.composeDeploy;
    composeRedeploy = dokployMocks.composeRedeploy;
    composeDelete = dokployMocks.composeDelete;
    deploymentAllByCompose = dokployMocks.deploymentAllByCompose;
    domainGenerateDomain = dokployMocks.domainGenerateDomain;
    domainCreate = dokployMocks.domainCreate;
    domainByComposeId = dokployMocks.domainByComposeId;
    serverWithSshKey = dokployMocks.serverWithSshKey;
    fileWrite = dokployMocks.fileWrite;
    fileRead = dokployMocks.fileRead;
    fileList = dokployMocks.fileList;
    fileDelete = dokployMocks.fileDelete;
    fileMkdir = dokployMocks.fileMkdir;
    fileSearch = dokployMocks.fileSearch;
  }

  return {
    DokployClient,
    DokployClientError,
    isDokployClientError: (error: unknown) => error instanceof DokployClientError,
  };
});

vi.mock('./cleanup', () => ({
  cleanupExpiredActorSessions: cleanupMocks.cleanupExpiredActorSessions,
}));

vi.mock('./runtime-token', () => ({
  signRuntimeToken: tokenMocks.signRuntimeToken,
  verifyRuntimeToken: tokenMocks.verifyRuntimeToken,
}));

vi.mock('./templates/vite-react', () => ({
  getRuntimeTemplate: () => ({
    composeFile: `services:
  app:
    image: nginx:alpine
`,
    files: {
      'index.html': '<h1>runtime</h1>',
    },
  }),
}));

import { cleanupExpiredActorSessions } from './cleanup';
import { DokployClientError } from './dokploy-client';
import { createRuntimeSession, heartbeatRuntimeSession } from './session-orchestrator';
import { signRuntimeToken, verifyRuntimeToken } from './runtime-token';

const baseConfig: RuntimeServerConfig = {
  runtimeProvider: 'dokploy',
  enableWebcontainerLegacy: false,
  dokployBaseUrl: 'https://dokploy.local',
  dokployApiKey: 'secret',
  dokployServerId: undefined,
  dokployCanaryServerId: undefined,
  dokployCanaryRolloutPercent: 0,
  sessionIdleMinutes: 15,
  heartbeatSeconds: 30,
  tokenSecret: 'runtime-secret',
  cleanupSecret: undefined,
};

const nowIso = '2026-02-17T00:00:00.000Z';

const metadataDescription = (actorId: string, chatId: string, lastSeenAt = nowIso) =>
  formatRuntimeMetadata({
    v: 1,
    actorId,
    chatId,
    createdAt: nowIso,
    lastSeenAt,
    idleTtlSec: 900,
  });

describe('session-orchestrator', () => {
  let signedTokenCounter = 0;

  beforeEach(() => {
    vi.restoreAllMocks();

    for (const mockFn of Object.values(dokployMocks)) {
      mockFn.mockReset();
    }

    cleanupMocks.cleanupExpiredActorSessions.mockReset();
    tokenMocks.signRuntimeToken.mockReset();
    tokenMocks.verifyRuntimeToken.mockReset();
    signedTokenCounter = 0;

    cleanupMocks.cleanupExpiredActorSessions.mockResolvedValue(undefined);

    dokployMocks.projectAll.mockResolvedValue([]);
    dokployMocks.projectCreate.mockResolvedValue({
      project: { projectId: 'project-1' },
    });
    dokployMocks.projectOne.mockResolvedValue({
      projectId: 'project-1',
      environments: [
        {
          environmentId: 'env-1',
          name: 'production',
          isDefault: true,
          compose: [],
        },
      ],
    });
    dokployMocks.serverWithSshKey.mockResolvedValue([{ serverId: 'server-1' }]);
    dokployMocks.composeCreate.mockResolvedValue({
      composeId: 'compose-new',
      appName: 'bolt-chat-default',
      environmentId: 'env-1',
      environment: { projectId: 'project-1' },
    });
    dokployMocks.composeUpdate.mockResolvedValue({
      composeId: 'compose-new',
      appName: 'bolt-chat-default',
      environmentId: 'env-1',
      environment: { projectId: 'project-1' },
    });
    dokployMocks.fileWrite.mockResolvedValue({});
    dokployMocks.domainByComposeId.mockResolvedValue([]);
    dokployMocks.domainGenerateDomain.mockResolvedValue('preview.runtime.test');
    dokployMocks.domainCreate.mockResolvedValue({ host: 'preview.runtime.test' });
    dokployMocks.deploymentAllByCompose.mockResolvedValue([]);
    dokployMocks.composeDeploy.mockResolvedValue(true);
    dokployMocks.composeDelete.mockResolvedValue({});
    dokployMocks.composeOne.mockResolvedValue({
      composeId: 'compose-new',
      appName: 'bolt-chat-default',
      environmentId: 'env-1',
      environment: { projectId: 'project-1' },
      description: metadataDescription('actor-1', 'chat-1'),
    });

    tokenMocks.signRuntimeToken.mockImplementation(async () => `signed-${++signedTokenCounter}`);
    tokenMocks.verifyRuntimeToken.mockResolvedValue({
      v: 1,
      actorId: 'actor-1',
      chatId: 'chat-1',
      projectId: 'project-1',
      environmentId: 'env-1',
      composeId: 'compose-new',
      domain: 'preview.runtime.test',
      iat: 1,
      exp: 2,
    });
  });

  it('uses actor+chat lock and creates only one compose under concurrent calls', async () => {
    dokployMocks.composeCreate.mockImplementation(
      async () =>
        await new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                composeId: 'compose-lock',
                appName: 'bolt-chat-lock',
                environmentId: 'env-1',
                environment: { projectId: 'project-1' },
              }),
            30,
          ),
        ),
    );

    const [first, second] = await Promise.all([
      createRuntimeSession({
        config: baseConfig,
        actorId: 'actor-lock',
        chatId: 'chat-lock',
        requestId: 'req-lock',
      }),
      createRuntimeSession({
        config: baseConfig,
        actorId: 'actor-lock',
        chatId: 'chat-lock',
        requestId: 'req-lock',
      }),
    ]);

    expect(first.session.composeId).toBe('compose-lock');
    expect(second.session.composeId).toBe('compose-lock');
    expect(first.runtimeToken).toBe(second.runtimeToken);
    expect(dokployMocks.composeCreate).toHaveBeenCalledTimes(1);
  });

  it('reuses active compose and keeps cleanup best-effort for stale duplicates', async () => {
    dokployMocks.projectOne.mockResolvedValue({
      projectId: 'project-1',
      environments: [
        {
          environmentId: 'env-1',
          name: 'production',
          isDefault: true,
          compose: [
            {
              composeId: 'compose-active',
              description: metadataDescription('actor-reuse', 'chat-reuse', '2026-02-17T00:10:00.000Z'),
            },
            {
              composeId: 'compose-stale',
              description: metadataDescription('actor-reuse', 'chat-reuse', '2026-02-17T00:05:00.000Z'),
            },
          ],
        },
      ],
    });

    dokployMocks.composeOne.mockImplementation(async (composeId: string) => {
      if (composeId === 'compose-active') {
        return {
          composeId,
          appName: 'bolt-chat-active',
          environmentId: 'env-1',
          environment: { projectId: 'project-1' },
          description: metadataDescription('actor-reuse', 'chat-reuse', '2026-02-17T00:10:00.000Z'),
        };
      }

      return {
        composeId,
        appName: 'bolt-chat-stale',
        environmentId: 'env-1',
        environment: { projectId: 'project-1' },
        description: metadataDescription('actor-reuse', 'chat-reuse', '2026-02-17T00:05:00.000Z'),
      };
    });
    dokployMocks.deploymentAllByCompose.mockImplementation(async (composeId: string) => [
      {
        deploymentId: `dep-${composeId}`,
        status: 'done',
        createdAt: '2026-02-17T00:12:00.000Z',
      },
    ]);
    dokployMocks.domainByComposeId.mockImplementation(async (composeId: string) => {
      if (composeId === 'compose-active') {
        return [{ host: 'active.runtime.test' }];
      }

      return [{ host: 'stale.runtime.test' }];
    });
    dokployMocks.composeDelete.mockImplementation(async (composeId: string) => {
      if (composeId === 'compose-stale') {
        throw new Error('delete failed');
      }

      return {};
    });

    const result = await createRuntimeSession({
      config: baseConfig,
      actorId: 'actor-reuse',
      chatId: 'chat-reuse',
      requestId: 'req-reuse',
    });

    expect(result.session.composeId).toBe('compose-active');
    expect(result.session.domain).toBe('active.runtime.test');
    expect(dokployMocks.composeCreate).not.toHaveBeenCalled();
    expect(dokployMocks.composeDelete).toHaveBeenCalledWith('compose-stale', true, 'req-reuse');
  });

  it('recovers from compose.create CONFLICT by loading existing compose for actor+chat', async () => {
    dokployMocks.projectOne
      .mockResolvedValueOnce({
        projectId: 'project-1',
        environments: [
          {
            environmentId: 'env-1',
            name: 'production',
            isDefault: true,
            compose: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        projectId: 'project-1',
        environments: [
          {
            environmentId: 'env-1',
            name: 'production',
            isDefault: true,
            compose: [
              {
                composeId: 'compose-conflict',
                description: metadataDescription('actor-conflict', 'chat-conflict', '2026-02-17T00:20:00.000Z'),
              },
            ],
          },
        ],
      });
    dokployMocks.composeCreate.mockRejectedValue(new DokployClientError('conflict', 409, 'CONFLICT'));
    dokployMocks.composeOne.mockResolvedValue({
      composeId: 'compose-conflict',
      appName: 'bolt-chat-conflict',
      environmentId: 'env-1',
      environment: { projectId: 'project-1' },
      description: metadataDescription('actor-conflict', 'chat-conflict', '2026-02-17T00:20:00.000Z'),
    });
    dokployMocks.deploymentAllByCompose.mockResolvedValue([
      {
        deploymentId: 'dep-conflict',
        status: 'done',
        createdAt: '2026-02-17T00:21:00.000Z',
      },
    ]);
    dokployMocks.domainByComposeId.mockResolvedValue([{ host: 'conflict.runtime.test' }]);

    const result = await createRuntimeSession({
      config: baseConfig,
      actorId: 'actor-conflict',
      chatId: 'chat-conflict',
      requestId: 'req-conflict',
    });

    expect(result.session.composeId).toBe('compose-conflict');
    expect(result.session.domain).toBe('conflict.runtime.test');
    expect(dokployMocks.composeCreate).toHaveBeenCalledTimes(1);
  });

  it('falls back to Dokploy default server assignment when no server can be resolved', async () => {
    dokployMocks.serverWithSshKey.mockResolvedValue([]);

    const result = await createRuntimeSession({
      config: baseConfig,
      actorId: 'actor-noserver',
      chatId: 'chat-noserver',
      requestId: 'req-noserver',
    });

    expect(result.session.composeId).toBe('compose-new');
    expect(result.session.serverId).toBeUndefined();
    expect(dokployMocks.composeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: undefined,
      }),
      'req-noserver',
    );
    expect(dokployMocks.domainGenerateDomain).toHaveBeenCalledWith(expect.any(String), undefined, 'req-noserver');
  });

  it('uses canary server and persists canary cohort metadata when rollout selects canary', async () => {
    const canaryConfig: RuntimeServerConfig = {
      ...baseConfig,
      dokployCanaryServerId: 'server-canary',
      dokployCanaryRolloutPercent: 100,
    };

    const result = await createRuntimeSession({
      config: canaryConfig,
      actorId: 'actor-canary',
      chatId: 'chat-canary',
      requestId: 'req-canary',
    });

    expect(dokployMocks.composeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'server-canary',
      }),
      'req-canary',
    );

    const composeCreateInput = dokployMocks.composeCreate.mock.calls[0]?.[0] as { description?: string };
    expect(composeCreateInput?.description).toContain('"rolloutCohort":"canary"');
    expect(result.session.rolloutCohort).toBe('canary');
    expect(result.session.serverId).toBe('server-canary');
  });

  it('returns controlled NO_CANARY_DEPLOY_SERVER when canary cohort is selected without canary server', async () => {
    const canaryConfig: RuntimeServerConfig = {
      ...baseConfig,
      dokployCanaryRolloutPercent: 100,
      dokployCanaryServerId: undefined,
    };

    await expect(
      createRuntimeSession({
        config: canaryConfig,
        actorId: 'actor-canary-missing',
        chatId: 'chat-canary-missing',
        requestId: 'req-canary-missing',
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'NO_CANARY_DEPLOY_SERVER',
    });
  });

  it('renews runtime token on heartbeat (sliding TTL)', async () => {
    dokployMocks.composeOne.mockResolvedValue({
      composeId: 'compose-heartbeat',
      appName: 'bolt-chat-heartbeat',
      environmentId: 'env-1',
      environment: { projectId: 'project-1' },
      description: metadataDescription('actor-heartbeat', 'chat-heartbeat'),
    });
    dokployMocks.deploymentAllByCompose.mockResolvedValue([
      {
        deploymentId: 'dep-heartbeat',
        status: 'done',
        createdAt: '2026-02-17T00:30:00.000Z',
      },
    ]);
    dokployMocks.domainByComposeId.mockResolvedValue([{ host: 'heartbeat.runtime.test' }]);
    tokenMocks.verifyRuntimeToken.mockResolvedValue({
      v: 1,
      actorId: 'actor-heartbeat',
      chatId: 'chat-heartbeat',
      projectId: 'project-1',
      environmentId: 'env-1',
      composeId: 'compose-heartbeat',
      domain: 'heartbeat.runtime.test',
      iat: 10,
      exp: 20,
    });
    tokenMocks.signRuntimeToken.mockResolvedValue('rotated-token');

    const result = await heartbeatRuntimeSession({
      config: baseConfig,
      runtimeToken: 'old-token',
      requestId: 'req-heartbeat',
    });

    expect(result.runtimeToken).toBe('rotated-token');
    expect(result.status).toBe('ready');
    expect(dokployMocks.composeUpdate).toHaveBeenCalledTimes(1);
    expect(cleanupExpiredActorSessions).toHaveBeenCalledWith(expect.anything(), 'actor-heartbeat', 'req-heartbeat');
    expect(verifyRuntimeToken).toHaveBeenCalledWith('old-token', baseConfig.tokenSecret);
    expect(signRuntimeToken).toHaveBeenCalledTimes(1);
  });
});
