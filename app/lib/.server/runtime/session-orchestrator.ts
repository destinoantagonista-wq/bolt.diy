import { createScopedLogger } from '~/utils/logger';
import { cleanupExpiredActorSessions } from './cleanup';
import { type RuntimeServerConfig } from './config';
import {
  DokployClient,
  isDokployClientError,
  type DokployCompose,
  type DokployDeployment,
  type DokployProjectDetails,
} from './dokploy-client';
import { formatRuntimeMetadata, parseRuntimeMetadata } from './metadata';
import { toRuntimePath } from './path-mapper';
import { selectRuntimeRolloutCohort, type RuntimeRolloutSelection } from './rollout';
import { RuntimeRouteError, runtimeErrorResponse } from './route-utils';
import { signRuntimeToken, verifyRuntimeToken } from './runtime-token';
import { getRuntimeTemplate } from './templates/vite-react';
import type {
  RuntimeDeployStatus,
  RuntimeMetadata,
  RuntimeRolloutCohort,
  RuntimeSession,
  RuntimeSessionStatus,
} from './types';

const logger = createScopedLogger('RuntimeSessionOrchestrator');
const DEFAULT_ENVIRONMENT_NAME = 'production';
const DEFAULT_DOMAIN_PORT = 4173;
const DEFAULT_COMPOSE_SERVICE_NAME = 'app';
const inFlightSessionLocks = new Map<string, Promise<RuntimeSessionCreateResult>>();

type RuntimeSessionCreateResult = {
  runtimeToken: string;
  session: RuntimeSession;
  deploymentStatus: RuntimeDeployStatus;
};

interface ChatComposeMatch {
  composeId: string;
  metadata: RuntimeMetadata;
  fallbackEnvironmentId?: string;
}

interface ComposeCandidate {
  compose: DokployCompose;
  metadata: RuntimeMetadata;
  deployments: DokployDeployment[];
  deploymentStatus: RuntimeDeployStatus;
  sessionStatus: RuntimeSessionStatus;
  fallbackEnvironmentId?: string;
}

class RuntimeSessionOrchestratorError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'RuntimeSessionOrchestratorError';
    this.status = status;
    this.code = code;
  }
}

const stableHash = (input: string) => {
  let hash = 2166136261;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return (hash >>> 0).toString(36);
};

const isoNow = () => new Date().toISOString();

const asTimestamp = (value?: string) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const getDeploymentStatus = (deployments: DokployDeployment[]): RuntimeDeployStatus => {
  if (!deployments?.length) {
    return 'queued';
  }

  const [latest] = [...deployments].sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));

  if (latest.status === 'done') {
    return 'done';
  }

  if (latest.status === 'error' || latest.status === 'cancelled') {
    return 'error';
  }

  return 'running';
};

const getSessionStatus = (compose: DokployCompose, deployments: DokployDeployment[]): RuntimeSessionStatus => {
  const deploymentStatus = getDeploymentStatus(deployments);

  if (deploymentStatus === 'error' || compose.composeStatus === 'error') {
    return 'error';
  }

  if (deploymentStatus === 'done' || compose.composeStatus === 'done') {
    return 'ready';
  }

  if (deploymentStatus === 'running') {
    return 'deploying';
  }

  return 'creating';
};

const isReusableSessionStatus = (status: RuntimeSessionStatus) => {
  return status === 'creating' || status === 'deploying' || status === 'ready';
};

const ensureEnvironmentId = (project: DokployProjectDetails): string => {
  const environments = project?.environments || [];
  const production = environments.find((env) => env.isDefault || env.name === DEFAULT_ENVIRONMENT_NAME);

  if (production?.environmentId) {
    return production.environmentId;
  }

  if (environments[0]?.environmentId) {
    return environments[0].environmentId;
  }

  throw new RuntimeSessionOrchestratorError('Project has no environments', 500, 'NO_ENVIRONMENT');
};

const listChatComposes = (project: DokployProjectDetails, actorId: string, chatId: string) => {
  const matches: ChatComposeMatch[] = [];

  for (const environment of project?.environments || []) {
    for (const compose of environment?.compose || []) {
      const metadata = parseRuntimeMetadata(compose.description);

      if (!metadata) {
        continue;
      }

      if (metadata.actorId !== actorId || metadata.chatId !== chatId) {
        continue;
      }

      if (typeof compose.composeId !== 'string' || compose.composeId.length === 0) {
        continue;
      }

      matches.push({
        composeId: compose.composeId,
        metadata,
        fallbackEnvironmentId: environment.environmentId,
      });
    }
  }

  return matches;
};

const updateComposeMetadata = async (
  client: DokployClient,
  compose: DokployCompose,
  metadata: RuntimeMetadata,
  requestId?: string,
) => {
  await client.composeUpdate(
    {
      composeId: compose.composeId,
      description: formatRuntimeMetadata(metadata),
    },
    requestId,
  );
};

const resolveStableServerId = async (
  client: DokployClient,
  config: RuntimeServerConfig,
  requestId?: string,
): Promise<string | undefined> => {
  if (config.dokployServerId) {
    return config.dokployServerId;
  }

  const servers = await client.serverWithSshKey(requestId);
  const serverId = servers?.find(
    (server) => typeof server.serverId === 'string' && server.serverId.trim().length > 0,
  )?.serverId;

  if (serverId) {
    return serverId.trim();
  }

  logger.info('No explicit Dokploy deploy server resolved, using Dokploy default server assignment', {
    requestId,
  });

  return undefined;
};

const resolveServerIdForRollout = async ({
  client,
  config,
  rollout,
  requestId,
}: {
  client: DokployClient;
  config: RuntimeServerConfig;
  rollout: RuntimeRolloutSelection;
  requestId?: string;
}): Promise<string | undefined> => {
  if (rollout.rolloutCohort === 'canary') {
    if (!config.dokployCanaryServerId) {
      throw new RuntimeSessionOrchestratorError(
        'No eligible Dokploy canary deploy server found. Configure DOKPLOY_CANARY_SERVER_ID or set DOKPLOY_CANARY_ROLLOUT_PERCENT=0.',
        503,
        'NO_CANARY_DEPLOY_SERVER',
      );
    }

    return config.dokployCanaryServerId;
  }

  return await resolveStableServerId(client, config, requestId);
};

const resolveComposeServerId = (compose: DokployCompose) => {
  const raw = (compose as Record<string, unknown>).serverId;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
};

const resolveMetadataRolloutCohort = ({
  compose,
  metadata,
  config,
  fallbackRolloutCohort,
}: {
  compose: DokployCompose;
  metadata?: RuntimeMetadata;
  config: RuntimeServerConfig;
  fallbackRolloutCohort?: RuntimeRolloutCohort;
}): RuntimeRolloutCohort => {
  if (metadata?.rolloutCohort) {
    return metadata.rolloutCohort;
  }

  const composeServerId = resolveComposeServerId(compose);

  if (composeServerId && config.dokployCanaryServerId && composeServerId === config.dokployCanaryServerId) {
    return 'canary';
  }

  return fallbackRolloutCohort || 'stable';
};

const ensureActorProject = async (client: DokployClient, actorId: string, requestId?: string) => {
  const projectName = `bolt-actor-${stableHash(actorId).slice(0, 10)}`;
  const allProjects = await client.projectAll(requestId);
  const existing = (allProjects || []).find((project) => project.name === projectName);

  if (existing) {
    return {
      project: await client.projectOne(existing.projectId, requestId),
      created: false,
    };
  }

  const created = await client.projectCreate(
    {
      name: projectName,
      description: `Bolt runtime project for actor ${actorId}`,
    },
    requestId,
  );

  return {
    project: await client.projectOne(created.project.projectId, requestId),
    created: true,
  };
};

const writeTemplateFiles = async (
  client: DokployClient,
  composeId: string,
  templateId: string | undefined,
  requestId?: string,
) => {
  const template = getRuntimeTemplate(templateId);

  for (const [filePath, content] of Object.entries(template.files)) {
    await client.fileWrite(
      {
        serviceId: composeId,
        serviceType: 'compose',
        path: toRuntimePath(`/home/project/${filePath}`),
        content,
        encoding: 'utf8',
        overwrite: true,
      },
      requestId,
    );
  }

  return template.composeFile;
};

const getExpiresAt = (metadata: RuntimeMetadata) => {
  const startedAt = Date.parse(metadata.lastSeenAt);
  return new Date(startedAt + metadata.idleTtlSec * 1000).toISOString();
};

const resolveComposeProjectId = (compose: DokployCompose, fallbackProjectId?: string) => {
  const envProjectId =
    typeof compose?.environment?.projectId === 'string' && compose.environment.projectId.length > 0
      ? compose.environment.projectId
      : undefined;
  const directProjectId =
    typeof (compose as Record<string, unknown>).projectId === 'string'
      ? ((compose as Record<string, unknown>).projectId as string)
      : undefined;

  return envProjectId || directProjectId || fallbackProjectId || '';
};

const resolveComposeEnvironmentId = (compose: DokployCompose, fallbackEnvironmentId?: string) => {
  return (
    (typeof compose?.environmentId === 'string' ? compose.environmentId : undefined) || fallbackEnvironmentId || ''
  );
};

const buildSession = (
  compose: DokployCompose,
  domain: string,
  metadata: RuntimeMetadata,
  status: RuntimeSessionStatus,
  fallbackProjectId?: string,
  fallbackEnvironmentId?: string,
): RuntimeSession => {
  const serverId = resolveComposeServerId(compose);

  return {
    projectId: resolveComposeProjectId(compose, fallbackProjectId),
    environmentId: resolveComposeEnvironmentId(compose, fallbackEnvironmentId),
    composeId: compose.composeId,
    domain,
    previewUrl: domain ? `http://${domain}` : '',
    status,
    expiresAt: getExpiresAt(metadata),
    serverId,
    rolloutCohort: metadata.rolloutCohort || 'stable',
  };
};

const buildRuntimeToken = async ({
  actorId,
  chatId,
  projectId,
  environmentId,
  composeId,
  domain,
  config,
}: {
  actorId: string;
  chatId: string;
  projectId: string;
  environmentId: string;
  composeId: string;
  domain: string;
  config: RuntimeServerConfig;
}) => {
  return await signRuntimeToken(
    {
      v: 1,
      actorId,
      chatId,
      projectId,
      environmentId,
      composeId,
      domain,
    },
    config.tokenSecret,
    config.sessionIdleMinutes * 60,
  );
};

const withSessionLock = async <T>(lockKey: string, task: () => Promise<T>) => {
  const existing = inFlightSessionLocks.get(lockKey) as Promise<T> | undefined;

  if (existing) {
    return await existing;
  }

  const taskPromise = task();
  inFlightSessionLocks.set(lockKey, taskPromise as unknown as Promise<RuntimeSessionCreateResult>);

  try {
    return await taskPromise;
  } finally {
    const current = inFlightSessionLocks.get(lockKey);

    if (current === (taskPromise as unknown as Promise<RuntimeSessionCreateResult>)) {
      inFlightSessionLocks.delete(lockKey);
    }
  }
};

const deleteComposesBestEffort = async (client: DokployClient, composeIds: string[], requestId?: string) => {
  const uniqueComposeIds = [...new Set(composeIds.filter((composeId) => typeof composeId === 'string' && composeId))];

  await Promise.allSettled(
    uniqueComposeIds.map(async (composeId) => {
      try {
        await client.composeDelete(composeId, true, requestId);
      } catch (error) {
        logger.warn('Best-effort compose cleanup failed', { requestId, composeId, error });
      }
    }),
  );
};

const evaluateReusableCandidate = async (
  client: DokployClient,
  matches: ChatComposeMatch[],
  requestId?: string,
): Promise<{ candidate?: ComposeCandidate; staleComposeIds: string[] }> => {
  let candidate: ComposeCandidate | undefined;
  const staleComposeIds: string[] = [];

  for (const match of matches) {
    try {
      const compose = await client.composeOne(match.composeId, requestId);
      const deployments = await client.deploymentAllByCompose(match.composeId, requestId);
      const metadata = parseRuntimeMetadata(compose.description) || match.metadata;

      if (!metadata) {
        staleComposeIds.push(match.composeId);
        continue;
      }

      const deploymentStatus = getDeploymentStatus(deployments || []);
      const sessionStatus = getSessionStatus(compose, deployments || []);

      if (!isReusableSessionStatus(sessionStatus)) {
        staleComposeIds.push(match.composeId);
        continue;
      }

      const current: ComposeCandidate = {
        compose,
        metadata,
        deployments: deployments || [],
        deploymentStatus,
        sessionStatus,
        fallbackEnvironmentId: match.fallbackEnvironmentId,
      };

      if (!candidate) {
        candidate = current;
        continue;
      }

      if (asTimestamp(current.metadata.lastSeenAt) > asTimestamp(candidate.metadata.lastSeenAt)) {
        staleComposeIds.push(candidate.compose.composeId);
        candidate = current;
      } else {
        staleComposeIds.push(current.compose.composeId);
      }
    } catch {
      staleComposeIds.push(match.composeId);
    }
  }

  return {
    candidate,
    staleComposeIds,
  };
};

const ensureComposeDomain = async ({
  client,
  compose,
  preferredServerId,
  requestId,
}: {
  client: DokployClient;
  compose: DokployCompose;
  preferredServerId?: string;
  requestId?: string;
}) => {
  const domains = await client.domainByComposeId(compose.composeId, requestId);
  const existingDomain = (domains || [])
    .map((domain) => (typeof domain.host === 'string' ? domain.host.trim() : ''))
    .find((host) => host.length > 0);

  if (existingDomain) {
    return existingDomain;
  }

  const appName = typeof compose.appName === 'string' ? compose.appName.trim() : '';

  if (!appName) {
    throw new RuntimeSessionOrchestratorError(
      `Compose ${compose.composeId} has no appName and no domain. Unable to resolve preview host.`,
      503,
      'RUNTIME_DOMAIN_UNAVAILABLE',
    );
  }

  const host = await client.domainGenerateDomain(
    appName,
    preferredServerId || resolveComposeServerId(compose),
    requestId,
  );
  await client.domainCreate(
    {
      host,
      path: '/',
      port: DEFAULT_DOMAIN_PORT,
      https: false,
      certificateType: 'none',
      composeId: compose.composeId,
      serviceName: DEFAULT_COMPOSE_SERVICE_NAME,
      domainType: 'compose',
    },
    requestId,
  );

  return host;
};

const normalizeMetadata = ({
  actorId,
  chatId,
  metadata,
  config,
  rolloutCohort,
}: {
  actorId: string;
  chatId: string;
  metadata?: RuntimeMetadata;
  config: RuntimeServerConfig;
  rolloutCohort?: RuntimeRolloutCohort;
}) => {
  const now = isoNow();

  return {
    v: 1,
    actorId,
    chatId,
    createdAt: metadata?.createdAt || now,
    lastSeenAt: now,
    idleTtlSec: config.sessionIdleMinutes * 60,
    rolloutCohort: rolloutCohort || metadata?.rolloutCohort || 'stable',
  } satisfies RuntimeMetadata;
};

const shouldQueueDeploy = (deploymentStatus: RuntimeDeployStatus) => {
  return deploymentStatus === 'queued' || deploymentStatus === 'error';
};

const buildResultFromCandidate = async ({
  client,
  candidate,
  actorId,
  chatId,
  config,
  fallbackProjectId,
  fallbackEnvironmentId,
  requestId,
  preferredServerId,
  fallbackRolloutCohort,
}: {
  client: DokployClient;
  candidate: ComposeCandidate;
  actorId: string;
  chatId: string;
  config: RuntimeServerConfig;
  fallbackProjectId: string;
  fallbackEnvironmentId: string;
  requestId?: string;
  preferredServerId?: string;
  fallbackRolloutCohort?: RuntimeRolloutCohort;
}): Promise<RuntimeSessionCreateResult> => {
  const composeForSession: DokployCompose = {
    ...candidate.compose,
    serverId: resolveComposeServerId(candidate.compose) || preferredServerId,
  };

  const rolloutCohort = resolveMetadataRolloutCohort({
    compose: composeForSession,
    metadata: candidate.metadata,
    config,
    fallbackRolloutCohort,
  });

  const metadata = normalizeMetadata({
    actorId,
    chatId,
    metadata: candidate.metadata,
    config,
    rolloutCohort,
  });
  await updateComposeMetadata(client, candidate.compose, metadata, requestId);

  const domain = await ensureComposeDomain({
    client,
    compose: composeForSession,
    preferredServerId,
    requestId,
  });

  let deploymentStatus = candidate.deploymentStatus;
  let sessionStatus = candidate.sessionStatus;

  if (shouldQueueDeploy(deploymentStatus)) {
    await client.composeDeploy(candidate.compose.composeId, requestId);
    deploymentStatus = 'queued';
    sessionStatus = 'deploying';
  }

  const projectId = resolveComposeProjectId(candidate.compose, fallbackProjectId);
  const environmentId = resolveComposeEnvironmentId(
    candidate.compose,
    candidate.fallbackEnvironmentId || fallbackEnvironmentId,
  );

  const runtimeToken = await buildRuntimeToken({
    actorId,
    chatId,
    projectId,
    environmentId,
    composeId: composeForSession.composeId,
    domain,
    config,
  });
  const session = buildSession(
    composeForSession,
    domain,
    metadata,
    sessionStatus,
    fallbackProjectId,
    candidate.fallbackEnvironmentId || fallbackEnvironmentId,
  );

  return {
    runtimeToken,
    session,
    deploymentStatus,
  };
};

export const createRuntimeSession = async ({
  config,
  chatId,
  templateId,
  actorId,
  requestId,
}: {
  config: RuntimeServerConfig;
  chatId: string;
  templateId?: string;
  actorId: string;
  requestId?: string;
}) => {
  return await withSessionLock(`${actorId}:${chatId}`, async () => {
    const client = new DokployClient({
      baseUrl: config.dokployBaseUrl,
      apiKey: config.dokployApiKey,
    });

    try {
      await cleanupExpiredActorSessions(client, actorId, requestId);
    } catch (error) {
      logger.warn('Pre-create cleanup failed (best-effort)', { requestId, actorId, chatId, error });
    }

    const { project } = await ensureActorProject(client, actorId, requestId);
    const environmentId = ensureEnvironmentId(project);
    const rolloutSelection = selectRuntimeRolloutCohort({
      actorId,
      chatId,
      canaryPercent: config.dokployCanaryRolloutPercent,
    });
    const chatMatches = listChatComposes(project, actorId, chatId);
    const { candidate, staleComposeIds } = await evaluateReusableCandidate(client, chatMatches, requestId);

    if (candidate) {
      const reusableResult = await buildResultFromCandidate({
        client,
        candidate,
        actorId,
        chatId,
        config,
        fallbackProjectId: project.projectId,
        fallbackEnvironmentId: environmentId,
        requestId,
        preferredServerId: resolveComposeServerId(candidate.compose),
        fallbackRolloutCohort: rolloutSelection.rolloutCohort,
      });

      if (staleComposeIds.length > 0) {
        await deleteComposesBestEffort(client, staleComposeIds, requestId);
      }

      logger.info('Runtime session resolved from reusable compose', {
        requestId,
        actorId,
        chatId,
        bucket: rolloutSelection.bucket,
        percent: rolloutSelection.percent,
        rolloutCohort: reusableResult.session.rolloutCohort,
        serverId: reusableResult.session.serverId,
        composeId: reusableResult.session.composeId,
      });

      return reusableResult;
    }

    if (staleComposeIds.length > 0) {
      await deleteComposesBestEffort(client, staleComposeIds, requestId);
    }

    const serverId = await resolveServerIdForRollout({
      client,
      config,
      rollout: rolloutSelection,
      requestId,
    });
    const chatHash = stableHash(`${actorId}:${chatId}`).slice(0, 12);
    const appName = `bolt-chat-${chatHash}`;
    const composeName = `bolt-chat-${chatHash}`;
    const metadata = normalizeMetadata({
      actorId,
      chatId,
      config,
      rolloutCohort: rolloutSelection.rolloutCohort,
    });

    const templateCompose = getRuntimeTemplate(templateId).composeFile;
    let compose: DokployCompose;

    try {
      compose = await client.composeCreate(
        {
          name: composeName,
          description: formatRuntimeMetadata(metadata),
          environmentId,
          composeType: 'docker-compose',
          appName,
          composeFile: templateCompose,
          serverId,
        },
        requestId,
      );
    } catch (error) {
      if (!(isDokployClientError(error) && error.code === 'CONFLICT')) {
        throw error;
      }

      const refreshedProject = await client.projectOne(project.projectId, requestId);
      const recoveredMatches = listChatComposes(refreshedProject, actorId, chatId);
      const recovered = await evaluateReusableCandidate(client, recoveredMatches, requestId);

      if (!recovered.candidate) {
        throw error;
      }

      const recoveredResult = await buildResultFromCandidate({
        client,
        candidate: recovered.candidate,
        actorId,
        chatId,
        config,
        fallbackProjectId: project.projectId,
        fallbackEnvironmentId: environmentId,
        requestId,
        preferredServerId: resolveComposeServerId(recovered.candidate.compose) || serverId,
        fallbackRolloutCohort: rolloutSelection.rolloutCohort,
      });

      const conflictStaleIds = [...staleComposeIds, ...recovered.staleComposeIds];

      if (conflictStaleIds.length > 0) {
        await deleteComposesBestEffort(client, conflictStaleIds, requestId);
      }

      logger.info('Runtime session recovered after compose conflict', {
        requestId,
        actorId,
        chatId,
        bucket: rolloutSelection.bucket,
        percent: rolloutSelection.percent,
        rolloutCohort: recoveredResult.session.rolloutCohort,
        serverId: recoveredResult.session.serverId,
        composeId: recoveredResult.session.composeId,
      });

      return recoveredResult;
    }

    await client.composeUpdate(
      {
        composeId: compose.composeId,
        sourceType: 'raw',
        composePath: 'docker-compose.yml',
        description: formatRuntimeMetadata(metadata),
      },
      requestId,
    );

    await writeTemplateFiles(client, compose.composeId, templateId, requestId);

    compose = {
      ...compose,
      appName: compose.appName || appName,
      environmentId: compose.environmentId || environmentId,
      environment: compose.environment || { projectId: project.projectId },
      serverId: resolveComposeServerId(compose) || serverId,
    };

    const host = await ensureComposeDomain({
      client,
      compose,
      preferredServerId: serverId,
      requestId,
    });
    const deployments = await client.deploymentAllByCompose(compose.composeId, requestId).catch(() => []);
    let deploymentStatus = getDeploymentStatus(deployments || []);
    let sessionStatus = getSessionStatus(compose, deployments || []);

    if (shouldQueueDeploy(deploymentStatus)) {
      await client.composeDeploy(compose.composeId, requestId);
      deploymentStatus = 'queued';
      sessionStatus = 'deploying';
    }

    const runtimeToken = await buildRuntimeToken({
      actorId,
      chatId,
      projectId: project.projectId,
      environmentId,
      composeId: compose.composeId,
      domain: host,
      config,
    });
    const session = buildSession(compose, host, metadata, sessionStatus, project.projectId, environmentId);

    logger.info('Runtime session created', {
      requestId,
      actorId,
      chatId,
      bucket: rolloutSelection.bucket,
      percent: rolloutSelection.percent,
      rolloutCohort: session.rolloutCohort,
      serverId: session.serverId,
      composeId: session.composeId,
    });

    return {
      runtimeToken,
      session,
      deploymentStatus,
    };
  });
};

export const getRuntimeSession = async ({
  config,
  runtimeToken,
  requestId,
}: {
  config: RuntimeServerConfig;
  runtimeToken: string;
  requestId?: string;
}) => {
  const claims = await verifyRuntimeToken(runtimeToken, config.tokenSecret);
  const client = new DokployClient({
    baseUrl: config.dokployBaseUrl,
    apiKey: config.dokployApiKey,
  });
  const compose = await client.composeOne(claims.composeId, requestId);
  const deployments = await client.deploymentAllByCompose(claims.composeId, requestId);
  const domains = await client.domainByComposeId(claims.composeId, requestId);
  const parsedMetadata = parseRuntimeMetadata(compose.description);
  const metadata: RuntimeMetadata =
    parsedMetadata ||
    ({
      v: 1,
      actorId: claims.actorId,
      chatId: claims.chatId,
      createdAt: new Date(claims.iat * 1000).toISOString(),
      lastSeenAt: new Date(claims.iat * 1000).toISOString(),
      idleTtlSec: config.sessionIdleMinutes * 60,
      rolloutCohort: resolveMetadataRolloutCohort({
        compose,
        config,
      }),
    } satisfies RuntimeMetadata);
  const resolvedMetadata: RuntimeMetadata = {
    ...metadata,
    rolloutCohort: resolveMetadataRolloutCohort({
      compose,
      metadata,
      config,
    }),
  };
  const domain = domains?.[0]?.host || claims.domain;
  const deploymentStatus = getDeploymentStatus(deployments || []);
  const sessionStatus = getSessionStatus(compose, deployments || []);
  const session = buildSession(
    compose,
    domain,
    resolvedMetadata,
    sessionStatus,
    claims.projectId,
    claims.environmentId,
  );

  return {
    claims,
    session,
    deploymentStatus,
  };
};

export const heartbeatRuntimeSession = async ({
  config,
  runtimeToken,
  requestId,
}: {
  config: RuntimeServerConfig;
  runtimeToken: string;
  requestId?: string;
}) => {
  const result = await getRuntimeSession({
    config,
    runtimeToken,
    requestId,
  });
  const client = new DokployClient({
    baseUrl: config.dokployBaseUrl,
    apiKey: config.dokployApiKey,
  });

  const compose = await client.composeOne(result.claims.composeId, requestId);
  const parsedMetadata = parseRuntimeMetadata(compose.description);
  const composeMetadata: RuntimeMetadata =
    parsedMetadata ||
    ({
      v: 1,
      actorId: result.claims.actorId,
      chatId: result.claims.chatId,
      createdAt: new Date(result.claims.iat * 1000).toISOString(),
      lastSeenAt: new Date(result.claims.iat * 1000).toISOString(),
      idleTtlSec: config.sessionIdleMinutes * 60,
      rolloutCohort: resolveMetadataRolloutCohort({
        compose,
        config,
      }),
    } satisfies RuntimeMetadata);

  const nextMetadata: RuntimeMetadata = {
    ...composeMetadata,
    lastSeenAt: isoNow(),
    idleTtlSec: config.sessionIdleMinutes * 60,
    rolloutCohort: resolveMetadataRolloutCohort({
      compose,
      metadata: composeMetadata,
      config,
    }),
  };

  await updateComposeMetadata(client, compose, nextMetadata, requestId);
  await cleanupExpiredActorSessions(client, result.claims.actorId, requestId);

  const nextRuntimeToken = await buildRuntimeToken({
    actorId: result.claims.actorId,
    chatId: result.claims.chatId,
    projectId: result.session.projectId || result.claims.projectId,
    environmentId: result.session.environmentId || result.claims.environmentId,
    composeId: result.claims.composeId,
    domain: result.session.domain || result.claims.domain,
    config,
  });

  return {
    status: result.session.status,
    expiresAt: getExpiresAt(nextMetadata),
    runtimeToken: nextRuntimeToken,
  };
};

export const deleteRuntimeSession = async ({
  config,
  runtimeToken,
  requestId,
}: {
  config: RuntimeServerConfig;
  runtimeToken: string;
  requestId?: string;
}) => {
  const claims = await verifyRuntimeToken(runtimeToken, config.tokenSecret);
  const client = new DokployClient({
    baseUrl: config.dokployBaseUrl,
    apiKey: config.dokployApiKey,
  });

  await client.composeDelete(claims.composeId, true, requestId);

  return {
    deleted: true,
  };
};

export const withRuntimeClaims = async ({
  config,
  runtimeToken,
}: {
  config: RuntimeServerConfig;
  runtimeToken: string;
}) => {
  return await verifyRuntimeToken(runtimeToken, config.tokenSecret);
};

export const mapRuntimeRouteError = (error: unknown) => {
  if (error instanceof RuntimeRouteError) {
    return runtimeErrorResponse(error.message, error.status, error.code, undefined, error.details);
  }

  if (error instanceof Error && error.message === 'Invalid runtime path') {
    return runtimeErrorResponse(error.message, 400, 'BAD_REQUEST');
  }

  if (error instanceof RuntimeSessionOrchestratorError) {
    return runtimeErrorResponse(error.message, error.status, error.code);
  }

  if (isDokployClientError(error)) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
    return runtimeErrorResponse(error.message, status, error.code);
  }

  if (error instanceof Error) {
    return runtimeErrorResponse(error.message, 500, 'INTERNAL_SERVER_ERROR');
  }

  return runtimeErrorResponse('Unexpected runtime error', 500, 'INTERNAL_SERVER_ERROR');
};
