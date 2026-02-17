import { createScopedLogger } from '~/utils/logger';
import type { RuntimeFileEntry } from './types';

type ProcedureType = 'query' | 'mutation';
type TrpcErrorCode = string;

const logger = createScopedLogger('DokployClient');
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface DokployProjectSummary {
  projectId: string;
  name: string;
  environments?: DokployEnvironmentSummary[];
  [key: string]: unknown;
}

export interface DokployEnvironmentSummary {
  environmentId: string;
  name?: string;
  isDefault?: boolean;
  compose?: DokployCompose[];
  [key: string]: unknown;
}

export interface DokployProjectDetails extends DokployProjectSummary {
  environments: DokployEnvironmentSummary[];
}

export interface DokployProjectCreateResult {
  project: {
    projectId: string;
    name: string;
    [key: string]: unknown;
  };
  environment?: {
    environmentId: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface DokployCompose {
  composeId: string;
  name?: string;
  appName?: string;
  description?: string | null;
  composeStatus?: string;
  environmentId?: string;
  environment?: {
    projectId?: string;
    project?: {
      projectId?: string;
      organizationId?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface DokployDeployment {
  deploymentId: string;
  status: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface DokployDomain {
  domainId: string;
  host: string;
  port?: number;
  path?: string;
  https?: boolean;
  composeId?: string;
  serviceName?: string;
  [key: string]: unknown;
}

export interface DokployServer {
  serverId: string;
  name?: string;
  ipAddress?: string;
  serverType?: string;
  [key: string]: unknown;
}

export interface DokployFileReadResult extends RuntimeFileEntry {
  type: 'file';
  content: string;
  encoding: 'utf8' | 'base64';
  isBinary: boolean;
  [key: string]: unknown;
}

interface TrpcErrorPayload {
  message?: string;
  data?: {
    code?: TrpcErrorCode;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export class DokployClientError extends Error {
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
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'BAD_REQUEST':
      return 400;
    case 'CONFLICT':
      return 409;
    case 'PAYLOAD_TOO_LARGE':
      return 413;
    case 'TOO_MANY_REQUESTS':
      return 429;
    case 'NOT_IMPLEMENTED':
      return 501;
    default:
      return 502;
  }
};

const isObject = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object';
};

const sanitizeStatus = (status: number, fallback = 502) => {
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return status;
  }

  return fallback;
};

const isAbortError = (error: unknown) => {
  return (
    (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') ||
    (isObject(error) && error.name === 'AbortError')
  );
};

const isNetworkError = (error: unknown) => {
  return error instanceof TypeError;
};

const ensureNonEmptyString = (value: string | undefined, key: string) => {
  if (!value || value.trim().length === 0) {
    throw new DokployClientError(`${key} is required`, 400, 'BAD_REQUEST');
  }

  return value.trim();
};

const resolveRequestId = (requestId?: string) => {
  const normalized = (requestId || '').trim();

  if (normalized.length > 0) {
    return normalized;
  }

  return crypto.randomUUID();
};

const getRetryDelayMs = (attempt: number) => {
  const exponential = 200 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 120);

  return Math.min(2_000, exponential + jitter);
};

export class DokployClient {
  #baseUrl: string;
  #apiKey: string;
  #timeoutMs: number;
  #maxRetries: number;

  constructor(options: DokployClientOptions) {
    this.#baseUrl = ensureNonEmptyString(options.baseUrl, 'baseUrl').replace(/\/+$/, '');
    this.#apiKey = ensureNonEmptyString(options.apiKey, 'apiKey');
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#maxRetries = Math.max(0, options.maxRetries ?? 2);
  }

  #isRetryable(error: DokployClientError) {
    return TRANSIENT_HTTP_STATUSES.has(error.status);
  }

  #normalizeError(error: unknown, procedure: string) {
    if (error instanceof DokployClientError) {
      return error;
    }

    if (isAbortError(error)) {
      return new DokployClientError(`Dokploy request timed out: ${procedure}`, 504, 'TIMEOUT', {
        procedure,
      });
    }

    if (isNetworkError(error)) {
      return new DokployClientError(`Dokploy network error: ${procedure}`, 502, 'NETWORK_ERROR', {
        procedure,
      });
    }

    return new DokployClientError(`Dokploy request failed: ${procedure}`, 502, 'INTERNAL_SERVER_ERROR', {
      procedure,
      cause: error,
    });
  }

  async #parsePayload(response: Response, procedure: string): Promise<unknown> {
    const raw = await response.text();

    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new DokployClientError(`Invalid JSON response from Dokploy (${procedure})`, 502, 'INVALID_JSON_RESPONSE', {
        procedure,
        status: response.status,
        responseBodySample: raw.slice(0, 1000),
      });
    }
  }

  #extractResult<T>(response: Response, payload: unknown, procedure: string): T {
    if (payload === null) {
      throw new DokployClientError(`Invalid tRPC envelope from Dokploy (${procedure})`, 502, 'INVALID_TRPC_RESPONSE', {
        procedure,
        status: response.status,
      });
    }

    const envelope = Array.isArray(payload) ? payload[0] : payload;

    if (!isObject(envelope)) {
      throw new DokployClientError(`Invalid tRPC envelope from Dokploy (${procedure})`, 502, 'INVALID_TRPC_RESPONSE', {
        procedure,
        status: response.status,
      });
    }

    const trpcError = envelope.error as TrpcErrorPayload | undefined;

    if (trpcError) {
      const code = trpcError?.data?.code;
      const status = mapTrpcCodeToHttp(code);
      const message = trpcError.message || `Dokploy tRPC error (${procedure})`;
      throw new DokployClientError(message, status, code, envelope);
    }

    if (!response.ok) {
      throw new DokployClientError(
        `Dokploy HTTP error (${procedure}): ${response.status} ${response.statusText}`,
        sanitizeStatus(response.status),
        'HTTP_ERROR',
        envelope,
      );
    }

    if (!('result' in envelope)) {
      throw new DokployClientError(`Missing tRPC result from Dokploy (${procedure})`, 502, 'INVALID_TRPC_RESPONSE', {
        procedure,
        status: response.status,
        envelope,
      });
    }

    const result = envelope.result;

    if (result === undefined || result === null) {
      return result as T;
    }

    if (!isObject(result)) {
      return result as T;
    }

    const data = result.data;

    if (data === undefined) {
      return result as T;
    }

    if (isObject(data) && 'json' in data) {
      return (data as { json: T }).json;
    }

    return data as T;
  }

  async #request<T>(procedure: string, type: ProcedureType, input?: unknown, requestId?: string): Promise<T> {
    const url = new URL(`/api/trpc/${procedure}`, this.#baseUrl);
    const batchInput = JSON.stringify({
      0: {
        json: input ?? null,
      },
    });
    const resolvedRequestId = resolveRequestId(requestId);

    url.searchParams.set('batch', '1');

    if (type === 'query') {
      url.searchParams.set('input', batchInput);
    }

    const headers: Record<string, string> = {
      'x-api-key': this.#apiKey,
      'x-request-id': resolvedRequestId,
    };

    const fetchInit: RequestInit = {
      method: type === 'query' ? 'GET' : 'POST',
      headers: {
        ...headers,
        ...(type === 'mutation' ? { 'content-type': 'application/json' } : {}),
      },
      ...(type === 'mutation' ? { body: batchInput } : {}),
    };

    const maxAttempts = this.#maxRetries + 1;
    let attempt = 0;

    while (attempt < maxAttempts) {
      const attemptNumber = attempt + 1;
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), this.#timeoutMs);

      logger.debug('Dokploy request start', {
        requestId: resolvedRequestId,
        procedure,
        type,
        attempt: attemptNumber,
      });

      try {
        const response = await fetch(url.toString(), {
          ...fetchInit,
          signal: controller.signal,
        });
        const payload = await this.#parsePayload(response, procedure);
        const result = this.#extractResult<T>(response, payload, procedure);
        const latencyMs = Date.now() - startedAt;

        logger.info('Dokploy request success', {
          requestId: resolvedRequestId,
          procedure,
          type,
          attempt: attemptNumber,
          status: response.status,
          latencyMs,
        });

        return result;
      } catch (error) {
        const normalizedError = this.#normalizeError(error, procedure);
        const latencyMs = Date.now() - startedAt;
        const retryable = this.#isRetryable(normalizedError);
        const isLastAttempt = attemptNumber >= maxAttempts;

        logger[retryable && !isLastAttempt ? 'warn' : 'error']('Dokploy request failed', {
          requestId: resolvedRequestId,
          procedure,
          type,
          attempt: attemptNumber,
          latencyMs,
          retryable,
          status: normalizedError.status,
          code: normalizedError.code,
          message: normalizedError.message,
        });

        if (!retryable || isLastAttempt) {
          throw normalizedError;
        }

        await sleep(getRetryDelayMs(attempt));
      } finally {
        clearTimeout(timeoutHandle);
      }

      attempt += 1;
    }

    throw new DokployClientError(`Dokploy request exhausted retries: ${procedure}`, 502, 'RETRY_EXHAUSTED', {
      procedure,
    });
  }

  // project
  projectAll(requestId?: string) {
    return this.#request<DokployProjectSummary[]>('project.all', 'query', undefined, requestId);
  }

  projectOne(projectId: string, requestId?: string) {
    return this.#request<DokployProjectDetails>(
      'project.one',
      'query',
      { projectId: ensureNonEmptyString(projectId, 'projectId') },
      requestId,
    );
  }

  projectCreate(input: { name: string; description?: string; env?: string }, requestId?: string) {
    return this.#request<DokployProjectCreateResult>(
      'project.create',
      'mutation',
      {
        ...input,
        name: ensureNonEmptyString(input.name, 'name'),
      },
      requestId,
    );
  }

  projectRemove(projectId: string, requestId?: string) {
    return this.#request<Record<string, unknown>>(
      'project.remove',
      'mutation',
      { projectId: ensureNonEmptyString(projectId, 'projectId') },
      requestId,
    );
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
    return this.#request<DokployCompose>(
      'compose.create',
      'mutation',
      {
        ...input,
        name: ensureNonEmptyString(input.name, 'name'),
        environmentId: ensureNonEmptyString(input.environmentId, 'environmentId'),
      },
      requestId,
    );
  }

  composeOne(composeId: string, requestId?: string) {
    return this.#request<DokployCompose>(
      'compose.one',
      'query',
      { composeId: ensureNonEmptyString(composeId, 'composeId') },
      requestId,
    );
  }

  composeUpdate(input: { composeId: string } & Record<string, unknown>, requestId?: string) {
    return this.#request<DokployCompose>(
      'compose.update',
      'mutation',
      {
        ...input,
        composeId: ensureNonEmptyString(input.composeId, 'composeId'),
      },
      requestId,
    );
  }

  composeDeploy(composeId: string, requestId?: string) {
    return this.#request<{ success?: boolean; message?: string; composeId?: string } | true>(
      'compose.deploy',
      'mutation',
      { composeId: ensureNonEmptyString(composeId, 'composeId') },
      requestId,
    );
  }

  composeRedeploy(composeId: string, reason?: string, requestId?: string) {
    return this.#request<{ success?: boolean; message?: string; composeId?: string } | true>(
      'compose.redeploy',
      'mutation',
      { composeId: ensureNonEmptyString(composeId, 'composeId'), description: reason },
      requestId,
    );
  }

  composeDelete(composeId: string, deleteVolumes = true, requestId?: string) {
    return this.#request<DokployCompose | Record<string, unknown>>(
      'compose.delete',
      'mutation',
      { composeId: ensureNonEmptyString(composeId, 'composeId'), deleteVolumes },
      requestId,
    );
  }

  // deployment
  deploymentAllByCompose(composeId: string, requestId?: string) {
    return this.#request<DokployDeployment[]>(
      'deployment.allByCompose',
      'query',
      { composeId: ensureNonEmptyString(composeId, 'composeId') },
      requestId,
    );
  }

  // domain
  domainGenerateDomain(appName: string, serverId?: string, requestId?: string) {
    return this.#request<string>(
      'domain.generateDomain',
      'mutation',
      { appName: ensureNonEmptyString(appName, 'appName'), serverId },
      requestId,
    );
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
    return this.#request<DokployDomain>(
      'domain.create',
      'mutation',
      {
        ...input,
        host: ensureNonEmptyString(input.host, 'host'),
        composeId: ensureNonEmptyString(input.composeId, 'composeId'),
        serviceName: ensureNonEmptyString(input.serviceName, 'serviceName'),
      },
      requestId,
    );
  }

  domainByComposeId(composeId: string, requestId?: string) {
    return this.#request<DokployDomain[]>(
      'domain.byComposeId',
      'query',
      { composeId: ensureNonEmptyString(composeId, 'composeId') },
      requestId,
    );
  }

  // server
  serverWithSshKey(requestId?: string) {
    return this.#request<DokployServer[]>('server.withSSHKey', 'query', undefined, requestId);
  }

  // file manager
  fileList(input: { serviceId: string; serviceType: 'compose'; path?: string }, requestId?: string) {
    return this.#request<RuntimeFileEntry[]>(
      'fileManager.list',
      'query',
      {
        ...input,
        serviceId: ensureNonEmptyString(input.serviceId, 'serviceId'),
      },
      requestId,
    );
  }

  fileRead(
    input: { serviceId: string; serviceType: 'compose'; path: string; encoding?: 'utf8' | 'base64' },
    requestId?: string,
  ) {
    return this.#request<DokployFileReadResult>(
      'fileManager.read',
      'query',
      {
        ...input,
        serviceId: ensureNonEmptyString(input.serviceId, 'serviceId'),
        path: ensureNonEmptyString(input.path, 'path'),
      },
      requestId,
    );
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
    return this.#request<Record<string, unknown>>(
      'fileManager.write',
      'mutation',
      {
        ...input,
        serviceId: ensureNonEmptyString(input.serviceId, 'serviceId'),
        path: ensureNonEmptyString(input.path, 'path'),
      },
      requestId,
    );
  }

  fileMkdir(input: { serviceId: string; serviceType: 'compose'; path: string }, requestId?: string) {
    return this.#request<Record<string, unknown>>(
      'fileManager.mkdir',
      'mutation',
      {
        ...input,
        serviceId: ensureNonEmptyString(input.serviceId, 'serviceId'),
        path: ensureNonEmptyString(input.path, 'path'),
      },
      requestId,
    );
  }

  fileDelete(
    input: { serviceId: string; serviceType: 'compose'; path: string; recursive?: boolean },
    requestId?: string,
  ) {
    return this.#request<Record<string, unknown>>(
      'fileManager.delete',
      'mutation',
      {
        ...input,
        serviceId: ensureNonEmptyString(input.serviceId, 'serviceId'),
        path: ensureNonEmptyString(input.path, 'path'),
      },
      requestId,
    );
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
    return this.#request<RuntimeFileEntry[]>(
      'fileManager.search',
      'query',
      {
        ...input,
        serviceId: ensureNonEmptyString(input.serviceId, 'serviceId'),
        query: ensureNonEmptyString(input.query, 'query'),
      },
      requestId,
    );
  }
}

export const isDokployClientError = (error: unknown): error is DokployClientError => {
  return error instanceof DokployClientError;
};
