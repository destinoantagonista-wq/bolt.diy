import { cleanupExpiredActorSessions } from './cleanup';
import { type RuntimeServerConfig } from './config';
import { DokployClient, isDokployClientError } from './dokploy-client';
import { formatRuntimeMetadata, parseRuntimeMetadata } from './metadata';
import { toRuntimePath } from './path-mapper';
import { signRuntimeToken, verifyRuntimeToken } from './runtime-token';
import { getRuntimeTemplate } from './templates/vite-react';
import type {
  RuntimeDeployStatus,
  RuntimeMetadata,
  RuntimeSession,
  RuntimeSessionStatus,
  RuntimeTokenClaims,
} from './types';

const DEFAULT_ENVIRONMENT_NAME = 'production';
const DEFAULT_DOMAIN_PORT = 4173;
const DEFAULT_COMPOSE_SERVICE_NAME = 'app';

const stableHash = (input: string) => {
  let hash = 2166136261;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return (hash >>> 0).toString(36);
};

const isoNow = () => new Date().toISOString();

const getDeploymentStatus = (deployments: any[]): RuntimeDeployStatus => {
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

const getSessionStatus = (compose: any, deployments: any[]): RuntimeSessionStatus => {
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

const ensureEnvironmentId = (project: any): string => {
  const environments = project?.environments || [];
  const production = environments.find((env: any) => env.isDefault || env.name === DEFAULT_ENVIRONMENT_NAME);

  if (production?.environmentId) {
    return production.environmentId;
  }

  if (environments[0]?.environmentId) {
    return environments[0].environmentId;
  }

  throw new Error('Project has no environments');
};

const listChatComposes = (project: any, actorId: string, chatId: string) => {
  const matches: Array<{ composeId: string }> = [];

  for (const environment of project?.environments || []) {
    for (const compose of environment?.compose || []) {
      const metadata = parseRuntimeMetadata(compose.description);

      if (!metadata) {
        continue;
      }

      if (metadata.actorId !== actorId || metadata.chatId !== chatId) {
        continue;
      }

      if (typeof compose.composeId === 'string' && compose.composeId.length > 0) {
        matches.push({ composeId: compose.composeId });
      }
    }
  }

  return matches;
};

const updateComposeMetadata = async (
  client: DokployClient,
  compose: any,
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

const resolveServerId = async (client: DokployClient, config: RuntimeServerConfig, requestId?: string) => {
  if (config.dokployServerId) {
    return config.dokployServerId;
  }

  const servers = await client.serverWithSshKey(requestId);

  return servers?.[0]?.serverId || undefined;
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

const buildClaims = (
  metadata: RuntimeMetadata,
  compose: any,
  projectId: string,
  environmentId: string,
  domain: string,
  sessionIdleMinutes: number,
) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSec = sessionIdleMinutes * 60;

  const claims: RuntimeTokenClaims = {
    v: 1,
    actorId: metadata.actorId,
    chatId: metadata.chatId,
    projectId,
    environmentId,
    composeId: compose.composeId,
    domain,
    iat: nowSec,
    exp: nowSec + ttlSec,
  };

  return claims;
};

const resolveComposeProjectId = (compose: any, fallbackProjectId?: string) => {
  return compose?.environment?.projectId || compose?.projectId || fallbackProjectId || '';
};

const resolveComposeEnvironmentId = (compose: any, fallbackEnvironmentId?: string) => {
  return compose?.environmentId || fallbackEnvironmentId || '';
};

const buildSession = (
  compose: any,
  domain: string,
  metadata: RuntimeMetadata,
  status: RuntimeSessionStatus,
  fallbackProjectId?: string,
  fallbackEnvironmentId?: string,
): RuntimeSession => {
  return {
    projectId: resolveComposeProjectId(compose, fallbackProjectId),
    environmentId: resolveComposeEnvironmentId(compose, fallbackEnvironmentId),
    composeId: compose.composeId,
    domain,
    previewUrl: domain ? `http://${domain}` : '',
    status,
    expiresAt: getExpiresAt(metadata),
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
  const client = new DokployClient({
    baseUrl: config.dokployBaseUrl,
    apiKey: config.dokployApiKey,
  });

  await cleanupExpiredActorSessions(client, actorId, requestId);

  const { project } = await ensureActorProject(client, actorId, requestId);
  const environmentId = ensureEnvironmentId(project);
  const serverId = await resolveServerId(client, config, requestId);
  const chatHash = stableHash(`${actorId}:${chatId}`).slice(0, 8);
  const suffix = Date.now().toString(36).slice(-4);
  const appName = `bolt-chat-${chatHash}-${suffix}`;
  const composeName = `bolt-chat-${chatHash}-${suffix}`;
  const now = isoNow();
  const metadata: RuntimeMetadata = {
    v: 1,
    actorId,
    chatId,
    createdAt: now,
    lastSeenAt: now,
    idleTtlSec: config.sessionIdleMinutes * 60,
  };

  const staleComposes = listChatComposes(project, actorId, chatId);

  for (const composeEntry of staleComposes) {
    try {
      await client.composeDelete(composeEntry.composeId, true, requestId);
    } catch {
      // Best-effort cleanup before creating a new chat runtime.
    }
  }

  const templateCompose = getRuntimeTemplate(templateId).composeFile;
  const compose = await client.composeCreate(
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

  const host = await client.domainGenerateDomain(appName, serverId, requestId);
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

  await client.composeDeploy(compose.composeId, requestId);

  const claims = buildClaims(
    metadata,
    { ...compose, environment: { projectId: project.projectId } },
    project.projectId,
    environmentId,
    host,
    config.sessionIdleMinutes,
  );
  const runtimeToken = await signRuntimeToken(
    {
      v: 1,
      actorId: claims.actorId,
      chatId: claims.chatId,
      projectId: claims.projectId,
      environmentId: claims.environmentId,
      composeId: claims.composeId,
      domain: claims.domain,
    },
    config.tokenSecret,
    config.sessionIdleMinutes * 60,
  );

  const session = buildSession(
    {
      ...compose,
      environmentId,
      environment: { projectId: project.projectId },
    },
    host,
    metadata,
    'deploying',
    project.projectId,
    environmentId,
  );

  return {
    runtimeToken,
    session,
    deploymentStatus: 'queued' as RuntimeDeployStatus,
  };
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
  const metadata =
    parseRuntimeMetadata(compose.description) ||
    ({
      v: 1,
      actorId: claims.actorId,
      chatId: claims.chatId,
      createdAt: new Date(claims.iat * 1000).toISOString(),
      lastSeenAt: new Date(claims.iat * 1000).toISOString(),
      idleTtlSec: config.sessionIdleMinutes * 60,
    } satisfies RuntimeMetadata);
  const domain = domains?.[0]?.host || claims.domain;
  const deploymentStatus = getDeploymentStatus(deployments || []);
  const sessionStatus = getSessionStatus(compose, deployments || []);
  const session = buildSession(compose, domain, metadata, sessionStatus, claims.projectId, claims.environmentId);

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
  const composeMetadata =
    parseRuntimeMetadata(compose.description) ||
    ({
      v: 1,
      actorId: result.claims.actorId,
      chatId: result.claims.chatId,
      createdAt: new Date(result.claims.iat * 1000).toISOString(),
      lastSeenAt: new Date(result.claims.iat * 1000).toISOString(),
      idleTtlSec: config.sessionIdleMinutes * 60,
    } satisfies RuntimeMetadata);

  const nextMetadata: RuntimeMetadata = {
    ...composeMetadata,
    lastSeenAt: isoNow(),
    idleTtlSec: config.sessionIdleMinutes * 60,
  };

  await updateComposeMetadata(client, compose, nextMetadata, requestId);
  await cleanupExpiredActorSessions(client, result.claims.actorId, requestId);

  return {
    status: result.session.status,
    expiresAt: getExpiresAt(nextMetadata),
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
  if (error instanceof Error && error.message === 'Invalid runtime path') {
    return new Response(
      JSON.stringify({
        error: error.message,
      }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  if (isDokployClientError(error)) {
    return new Response(
      JSON.stringify({
        error: error.message,
        code: error.code,
      }),
      {
        status: error.status,
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  if (error instanceof Error) {
    return new Response(
      JSON.stringify({
        error: error.message,
      }),
      {
        status: 500,
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  return new Response(
    JSON.stringify({
      error: 'Unexpected runtime error',
    }),
    {
      status: 500,
      headers: { 'content-type': 'application/json' },
    },
  );
};
