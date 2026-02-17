import { WORK_DIR } from '~/utils/constants';
import { path } from '~/utils/path';

export type RuntimeSessionStatus = 'creating' | 'deploying' | 'ready' | 'error' | 'deleted';
export type RuntimeDeployStatus = 'queued' | 'running' | 'done' | 'error';

export interface RuntimeSession {
  projectId: string;
  environmentId: string;
  composeId: string;
  domain: string;
  previewUrl: string;
  status: RuntimeSessionStatus;
  expiresAt: string;
  serverId?: string;
  rolloutCohort?: 'stable' | 'canary';
}

export interface RuntimeFileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  extension?: string;
  modifiedAt: string;
  createdAt?: string;
  virtualPath?: string;
}

export interface RuntimeFile {
  name: string;
  path: string;
  type: 'file';
  size: number;
  content: string;
  encoding: 'utf8' | 'base64';
  isBinary: boolean;
  virtualPath?: string;
}

export interface RuntimeSessionCreateResponse {
  runtimeToken: string;
  session: RuntimeSession;
  deploymentStatus: RuntimeDeployStatus;
}

export interface RuntimeSessionGetResponse {
  sessionStatus: RuntimeSessionStatus;
  previewUrl: string;
  deploymentStatus: RuntimeDeployStatus;
  session: RuntimeSession;
}

export interface RuntimeHeartbeatResponse {
  expiresAt: string;
  status: RuntimeSessionStatus;
  runtimeToken?: string;
}

class RuntimeApiError extends Error {
  status: number;
  payload?: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = 'RuntimeApiError';
    this.status = status;
    this.payload = payload;
  }
}

const normalize = (value: string) => value.replaceAll('\\', '/');
const stripLeadingSlash = (value: string) => value.replace(/^\/+/, '');

const ensureNoTraversal = (value: string) => {
  const segments = normalize(value).split('/').filter(Boolean);

  if (segments.some((segment) => segment === '..')) {
    throw new RuntimeApiError('Invalid runtime path', 400);
  }
};

export const toRuntimePath = (virtualPath: string) => {
  const normalized = normalize(virtualPath);

  if (normalized === WORK_DIR || normalized === `${WORK_DIR}/`) {
    return '';
  }

  if (normalized.startsWith(`${WORK_DIR}/`)) {
    const candidate = normalized.slice(WORK_DIR.length + 1);
    ensureNoTraversal(candidate);

    return stripLeadingSlash(candidate);
  }

  const candidate = stripLeadingSlash(normalized);
  ensureNoTraversal(candidate);

  return candidate;
};

export const toVirtualPath = (runtimePath: string) => {
  const safePath = stripLeadingSlash(normalize(runtimePath));
  ensureNoTraversal(safePath);

  if (!safePath) {
    return WORK_DIR;
  }

  return path.join(WORK_DIR, safePath);
};

const parseJson = async (response: Response) => {
  const raw = await response.text();

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const resolveRuntimeRequestUrl = (requestPath: string) => {
  if (typeof window === 'undefined') {
    throw new RuntimeApiError('Runtime API is only available in browser context', 500);
  }

  return new URL(requestPath, window.location.origin);
};

const request = async <T>({
  path,
  method = 'GET',
  runtimeToken,
  query,
  body,
  signal,
}: {
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  runtimeToken?: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<T> => {
  const url = resolveRuntimeRequestUrl(path);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
  }

  const headers: Record<string, string> = {};

  if (runtimeToken) {
    headers.Authorization = `Bearer ${runtimeToken}`;
  }

  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  const payload = await parseJson(response);

  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : response.statusText || 'Runtime request failed';
    throw new RuntimeApiError(message, response.status, payload);
  }

  return payload as T;
};

export const runtimeApi = {
  createSession(input: { chatId: string; templateId?: string }) {
    return request<RuntimeSessionCreateResponse>({
      path: '/api/runtime/session',
      method: 'POST',
      body: input,
    });
  },
  getSession(runtimeToken: string) {
    return request<RuntimeSessionGetResponse>({
      path: '/api/runtime/session',
      method: 'GET',
      runtimeToken,
    });
  },
  heartbeat(runtimeToken: string) {
    return request<RuntimeHeartbeatResponse>({
      path: '/api/runtime/session/heartbeat',
      method: 'POST',
      runtimeToken,
      body: { runtimeToken },
    });
  },
  deleteSession(runtimeToken: string) {
    return request<{ deleted: true }>({
      path: '/api/runtime/session',
      method: 'DELETE',
      runtimeToken,
      body: { runtimeToken },
    });
  },
  deleteSessionWithBeacon(runtimeToken: string) {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
      return false;
    }

    const payload = new Blob([JSON.stringify({ runtimeToken })], {
      type: 'application/json',
    });

    return navigator.sendBeacon('/api/runtime/session?intent=delete', payload);
  },
  listFiles(runtimeToken: string, runtimePath?: string, signal?: AbortSignal) {
    return request<{ entries: RuntimeFileEntry[] }>({
      path: '/api/runtime/files/list',
      method: 'GET',
      runtimeToken,
      query: {
        path: runtimePath,
      },
      signal,
    });
  },
  readFile(runtimeToken: string, runtimePath: string, signal?: AbortSignal) {
    return request<{ file: RuntimeFile }>({
      path: '/api/runtime/files/read',
      method: 'GET',
      runtimeToken,
      query: {
        path: runtimePath,
      },
      signal,
    });
  },
  writeFile(
    runtimeToken: string,
    input: { path: string; content: string; encoding?: 'utf8' | 'base64' },
    signal?: AbortSignal,
  ) {
    return request<{ ok: true }>({
      path: '/api/runtime/files/write',
      method: 'PUT',
      runtimeToken,
      body: input,
      signal,
    });
  },
  mkdir(runtimeToken: string, runtimePath: string) {
    return request<{ ok: true }>({
      path: '/api/runtime/files/mkdir',
      method: 'POST',
      runtimeToken,
      body: {
        path: runtimePath,
      },
    });
  },
  delete(runtimeToken: string, runtimePath: string, recursive = false) {
    return request<{ ok: true }>({
      path: '/api/runtime/files/delete',
      method: 'DELETE',
      runtimeToken,
      body: {
        path: runtimePath,
        recursive,
      },
    });
  },
  search(runtimeToken: string, query: string, runtimePath?: string, signal?: AbortSignal) {
    return request<{ entries: RuntimeFileEntry[] }>({
      path: '/api/runtime/files/search',
      method: 'GET',
      runtimeToken,
      query: {
        query,
        path: runtimePath,
      },
      signal,
    });
  },
  redeploy(runtimeToken: string, reason?: string) {
    return request<{ queued: true }>({
      path: '/api/runtime/deploy/redeploy',
      method: 'POST',
      runtimeToken,
      body: {
        reason,
      },
    });
  },
};

export const isRuntimeApiError = (error: unknown): error is RuntimeApiError => {
  return error instanceof RuntimeApiError;
};
