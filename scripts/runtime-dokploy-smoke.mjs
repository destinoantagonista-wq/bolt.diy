#!/usr/bin/env node

const requiredEnv = ['DOKPLOY_BASE_URL', 'DOKPLOY_API_KEY'];
const missing = requiredEnv.filter((key) => !(process.env[key] || '').trim());

if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const baseUrl = process.env.DOKPLOY_BASE_URL.replace(/\/+$/, '');
const apiKey = process.env.DOKPLOY_API_KEY;
const configuredServerId = (process.env.DOKPLOY_SERVER_ID || '').trim() || undefined;
const requestId = `runtime-smoke-${Date.now()}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const trpc = async (procedure, type, input) => {
  const url = new URL(`/api/trpc/${procedure}`, baseUrl);
  const payload = JSON.stringify({
    0: {
      json: input ?? null,
    },
  });

  url.searchParams.set('batch', '1');

  if (type === 'query') {
    url.searchParams.set('input', payload);
  }

  const response = await fetch(url.toString(), {
    method: type === 'query' ? 'GET' : 'POST',
    headers: {
      'x-api-key': apiKey,
      'x-request-id': requestId,
      ...(type === 'mutation' ? { 'content-type': 'application/json' } : {}),
    },
    ...(type === 'mutation' ? { body: payload } : {}),
  });

  const raw = await response.text();
  let parsed;

  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`Invalid JSON from Dokploy (${procedure}): ${raw.slice(0, 400)}`);
  }

  const item = Array.isArray(parsed) ? parsed[0] : parsed;

  if (!item || typeof item !== 'object') {
    throw new Error(`Unexpected tRPC envelope for ${procedure}`);
  }

  if (item.error) {
    const code = item.error?.data?.code || 'UNKNOWN';
    throw new Error(`Dokploy tRPC error (${procedure}): ${code} ${item.error?.message || ''}`.trim());
  }

  if (!response.ok) {
    throw new Error(`Dokploy HTTP error (${procedure}): ${response.status} ${response.statusText}`);
  }

  return item?.result?.data?.json ?? item?.result?.data ?? item?.result ?? null;
};

const nowSuffix = Date.now().toString(36);
const projectName = `bolt-smoke-${nowSuffix}`;
const composeName = `bolt-smoke-compose-${nowSuffix}`;
const composeAppName = `bolt-smoke-${nowSuffix}`;

let projectId;
let composeId;

try {
  console.log('[1/11] Resolving deploy server (optional)');
  let serverId = configuredServerId;

  if (!serverId) {
    const servers = await trpc('server.withSSHKey', 'query');
    serverId = servers?.[0]?.serverId;
  }

  if (!serverId) {
    console.log('No explicit deploy server found. Using Dokploy default server resolution.');
  }

  console.log(`[2/11] Creating project "${projectName}"`);
  const projectCreate = await trpc('project.create', 'mutation', {
    name: projectName,
    description: 'Runtime smoke test project',
  });
  projectId = projectCreate?.project?.projectId;

  if (!projectId) {
    throw new Error('project.create did not return project.projectId');
  }

  console.log('[3/11] Loading project details');
  const project = await trpc('project.one', 'query', { projectId });
  const environmentId =
    project?.environments?.find?.((env) => env?.isDefault)?.environmentId || project?.environments?.[0]?.environmentId;

  if (!environmentId) {
    throw new Error('No environmentId found for created project');
  }

  console.log(`[4/11] Creating compose "${composeName}"`);
  const composeFile = `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
`;

  const compose = await trpc('compose.create', 'mutation', {
    name: composeName,
    description: 'Runtime smoke test compose',
    environmentId,
    composeType: 'docker-compose',
    appName: composeAppName,
    composeFile,
    ...(serverId ? { serverId } : {}),
  });
  composeId = compose?.composeId;

  if (!composeId) {
    throw new Error('compose.create did not return composeId');
  }

  console.log('[5/11] Setting compose source type to raw');
  await trpc('compose.update', 'mutation', {
    composeId,
    sourceType: 'raw',
    composePath: 'docker-compose.yml',
  });

  console.log('[6/11] Validating file manager write/read/delete');
  const smokeFilePath = 'smoke/runtime-smoke.txt';
  const smokeFileContent = `runtime-smoke:${requestId}`;

  await trpc('fileManager.write', 'mutation', {
    serviceId: composeId,
    serviceType: 'compose',
    path: smokeFilePath,
    content: smokeFileContent,
    encoding: 'utf8',
    overwrite: true,
  });

  const smokeRead = await trpc('fileManager.read', 'query', {
    serviceId: composeId,
    serviceType: 'compose',
    path: smokeFilePath,
    encoding: 'utf8',
  });

  if ((smokeRead?.content || '').trim() !== smokeFileContent) {
    throw new Error('fileManager.read content mismatch after write');
  }

  await trpc('fileManager.delete', 'mutation', {
    serviceId: composeId,
    serviceType: 'compose',
    path: smokeFilePath,
    recursive: false,
  });

  console.log('[7/11] Creating domain');
  const host = await trpc('domain.generateDomain', 'mutation', {
    appName: composeAppName,
    ...(serverId ? { serverId } : {}),
  });

  await trpc('domain.create', 'mutation', {
    host,
    path: '/',
    port: 80,
    https: false,
    certificateType: 'none',
    composeId,
    serviceName: 'app',
    domainType: 'compose',
  });

  console.log('[8/11] Queueing deploy');
  await trpc('compose.deploy', 'mutation', { composeId, title: 'Runtime smoke deploy' });

  console.log('[9/11] Validating deployment list (best-effort)');
  await sleep(500);
  await trpc('deployment.allByCompose', 'query', { composeId });

  console.log('[10/11] Validating compose details (best-effort)');
  await trpc('compose.one', 'query', { composeId });

  console.log('[11/11] Smoke checks complete');
  console.log('Smoke completed successfully.');
} catch (error) {
  console.error('Runtime smoke failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (composeId) {
    try {
      console.log('Cleanup: deleting compose');
      await trpc('compose.delete', 'mutation', { composeId, deleteVolumes: true });
    } catch (error) {
      console.warn('Cleanup warning (compose.delete):', error instanceof Error ? error.message : String(error));
    }
  }

  if (projectId) {
    try {
      console.log('Cleanup: deleting project');
      await trpc('project.remove', 'mutation', { projectId });
    } catch (error) {
      console.warn('Cleanup warning (project.remove):', error instanceof Error ? error.message : String(error));
    }
  }
}
