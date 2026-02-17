import type { RuntimeFileEntry } from './types';

type ProcedureType = 'query' | 'mutation';

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

interface DokployClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const mapTrpcCodeToHttp = (code?: string) => {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'NOT_FOUND':
      return 404;
    case 'BAD_REQUEST':
      return 400;
    case 'FORBIDDEN':
      return 403;
    default:
      return 502;
  }
};

export class DokployClient {
  #baseUrl: string;
  #apiKey: string;
  #timeoutMs: number;
  #maxRetries: number;

  constructor(options: DokployClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#maxRetries = options.maxRetries ?? 2;
  }

  async #request<T>(procedure: string, type: ProcedureType, input?: unknown, requestId?: string): Promise<T> {
    const url = new URL(`/api/trpc/${procedure}`, this.#baseUrl);
    const batchInput = JSON.stringify({
      0: {
        json: input ?? null,
      },
    });

    url.searchParams.set('batch', '1');

    if (type === 'query') {
      url.searchParams.set('input', batchInput);
    }

    const headers: Record<string, string> = {
      'x-api-key': this.#apiKey,
    };

    if (requestId) {
      headers['x-request-id'] = requestId;
    }

    const fetchInit: RequestInit = {
      method: type === 'query' ? 'GET' : 'POST',
      headers: {
        ...headers,
        ...(type === 'mutation' ? { 'content-type': 'application/json' } : {}),
      },
      ...(type === 'mutation' ? { body: batchInput } : {}),
    };

    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.#maxRetries) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

      try {
        const response = await fetch(url.toString(), {
          ...fetchInit,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const payload = await response.json();
        const item = Array.isArray(payload) ? payload[0] : payload;
        const trpcError = item?.error;

        if (!response.ok || trpcError) {
          const code = trpcError?.data?.code as string | undefined;
          const message = trpcError?.message || response.statusText || 'Dokploy request failed';
          throw new DokployClientError(message, response.ok ? mapTrpcCodeToHttp(code) : response.status, code, item);
        }

        return (item?.result?.data?.json ?? item?.result?.data ?? item?.result ?? null) as T;
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;

        const isLastAttempt = attempt >= this.#maxRetries;

        if (isLastAttempt) {
          break;
        }

        await sleep(250 * 2 ** attempt);
        attempt += 1;
      }
    }

    if (lastError instanceof DokployClientError) {
      throw lastError;
    }

    throw new DokployClientError('Dokploy request failed', 502, 'INTERNAL_SERVER_ERROR', lastError);
  }

  // project
  projectAll(requestId?: string) {
    return this.#request<any[]>('project.all', 'query', undefined, requestId);
  }

  projectOne(projectId: string, requestId?: string) {
    return this.#request<any>('project.one', 'query', { projectId }, requestId);
  }

  projectCreate(input: { name: string; description?: string; env?: string }, requestId?: string) {
    return this.#request<any>('project.create', 'mutation', input, requestId);
  }

  projectRemove(projectId: string, requestId?: string) {
    return this.#request<any>('project.remove', 'mutation', { projectId }, requestId);
  }

  // compose
  composeCreate(
    input: {
      name: string;
      description?: string;
      environmentId: string;
      composeFile?: string;
      composeType?: 'docker-compose' | 'stack';
      appName?: string;
      serverId?: string;
    },
    requestId?: string,
  ) {
    return this.#request<any>('compose.create', 'mutation', input, requestId);
  }

  composeOne(composeId: string, requestId?: string) {
    return this.#request<any>('compose.one', 'query', { composeId }, requestId);
  }

  composeUpdate(input: Record<string, unknown>, requestId?: string) {
    return this.#request<any>('compose.update', 'mutation', input, requestId);
  }

  composeDeploy(composeId: string, requestId?: string) {
    return this.#request<any>('compose.deploy', 'mutation', { composeId }, requestId);
  }

  composeRedeploy(composeId: string, reason?: string, requestId?: string) {
    return this.#request<any>('compose.redeploy', 'mutation', { composeId, description: reason }, requestId);
  }

  composeDelete(composeId: string, deleteVolumes = true, requestId?: string) {
    return this.#request<any>('compose.delete', 'mutation', { composeId, deleteVolumes }, requestId);
  }

  // deployment
  deploymentAllByCompose(composeId: string, requestId?: string) {
    return this.#request<any[]>('deployment.allByCompose', 'query', { composeId }, requestId);
  }

  // domain
  domainGenerateDomain(appName: string, serverId?: string, requestId?: string) {
    return this.#request<string>('domain.generateDomain', 'mutation', { appName, serverId }, requestId);
  }

  domainCreate(
    input: {
      host: string;
      path?: string;
      port?: number;
      https?: boolean;
      certificateType?: 'none' | 'letsencrypt' | 'custom';
      customCertResolver?: string;
      composeId: string;
      serviceName: string;
      domainType: 'compose';
    },
    requestId?: string,
  ) {
    return this.#request<any>('domain.create', 'mutation', input, requestId);
  }

  domainByComposeId(composeId: string, requestId?: string) {
    return this.#request<any[]>('domain.byComposeId', 'query', { composeId }, requestId);
  }

  // server
  serverWithSshKey(requestId?: string) {
    return this.#request<any[]>('server.withSSHKey', 'query', undefined, requestId);
  }

  // file manager
  fileList(input: { serviceId: string; serviceType: 'compose'; path?: string }, requestId?: string) {
    return this.#request<RuntimeFileEntry[]>('fileManager.list', 'query', input, requestId);
  }

  fileRead(
    input: { serviceId: string; serviceType: 'compose'; path: string; encoding?: 'utf8' | 'base64' },
    requestId?: string,
  ) {
    return this.#request<any>('fileManager.read', 'query', input, requestId);
  }

  fileWrite(
    input: {
      serviceId: string;
      serviceType: 'compose';
      path: string;
      content: string;
      encoding?: 'utf8' | 'base64';
      overwrite?: boolean;
    },
    requestId?: string,
  ) {
    return this.#request<any>('fileManager.write', 'mutation', input, requestId);
  }

  fileMkdir(input: { serviceId: string; serviceType: 'compose'; path: string }, requestId?: string) {
    return this.#request<any>('fileManager.mkdir', 'mutation', input, requestId);
  }

  fileDelete(
    input: { serviceId: string; serviceType: 'compose'; path: string; recursive?: boolean },
    requestId?: string,
  ) {
    return this.#request<any>('fileManager.delete', 'mutation', input, requestId);
  }

  fileSearch(
    input: {
      serviceId: string;
      serviceType: 'compose';
      query: string;
      path?: string;
      includeHidden?: boolean;
      limit?: number;
      maxDepth?: number;
    },
    requestId?: string,
  ) {
    return this.#request<RuntimeFileEntry[]>('fileManager.search', 'query', input, requestId);
  }
}

export const isDokployClientError = (error: unknown): error is DokployClientError => {
  return error instanceof DokployClientError;
};
