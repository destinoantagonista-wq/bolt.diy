import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/cloudflare';
import { type ZodTypeAny, z } from 'zod';
import { getRuntimeServerConfig } from './config';

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const AUTHORIZATION_HEADER_PATTERN = /^Bearer\s+(.+)$/i;

export class RuntimeRouteError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'RuntimeRouteError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const getRuntimeRequestId = (request: Request) => {
  const headerValue = request.headers.get(REQUEST_ID_HEADER)?.trim();

  if (headerValue && REQUEST_ID_PATTERN.test(headerValue)) {
    return headerValue;
  }

  return crypto.randomUUID();
};

export const getRuntimeConfigFromContext = (args: Pick<ActionFunctionArgs | LoaderFunctionArgs, 'context'>) => {
  const env = (args.context as any)?.cloudflare?.env as Record<string, unknown> | undefined;
  return getRuntimeServerConfig(env);
};

const getBearerToken = (request: Request) => {
  const header = request.headers.get('authorization') || request.headers.get('Authorization');

  if (!header) {
    return null;
  }

  const match = header.match(AUTHORIZATION_HEADER_PATTERN);

  if (!match) {
    return null;
  }

  const token = match[1]?.trim();

  return token || null;
};

const formatSchemaError = (error: z.ZodError) => {
  const firstIssue = error.issues[0];

  if (!firstIssue) {
    return 'Invalid request payload';
  }

  return firstIssue.message || 'Invalid request payload';
};

export const runtimeErrorResponse = (
  message: string,
  status: number,
  code?: string,
  headers?: HeadersInit,
  details?: unknown,
) => {
  const payload: Record<string, unknown> = {
    error: message,
  };

  if (code) {
    payload.code = code;
  }

  if (details !== undefined) {
    payload.details = details;
  }

  return jsonResponse(payload, status, headers);
};

export const assertMethod = (request: Request, methods: string | string[]) => {
  const allowedMethods = Array.isArray(methods) ? methods : [methods];

  if (!allowedMethods.includes(request.method)) {
    throw new RuntimeRouteError('Method not allowed', 405, 'METHOD_NOT_ALLOWED');
  }
};

export const parseJsonBody = async <TSchema extends ZodTypeAny>(
  request: Request,
  schema: TSchema,
): Promise<z.infer<TSchema>> => {
  const rawText = await request.text();
  let payload: unknown = {};

  if (rawText.trim().length > 0) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      throw new RuntimeRouteError('Invalid JSON body', 400, 'BAD_REQUEST');
    }
  }

  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    throw new RuntimeRouteError(formatSchemaError(parsed.error), 400, 'BAD_REQUEST', parsed.error.flatten());
  }

  return parsed.data;
};

export const parseQuery = <TSchema extends ZodTypeAny>(request: Request, schema: TSchema): z.infer<TSchema> => {
  const query = Object.fromEntries(new URL(request.url).searchParams.entries());
  const parsed = schema.safeParse(query);

  if (!parsed.success) {
    throw new RuntimeRouteError(formatSchemaError(parsed.error), 400, 'BAD_REQUEST', parsed.error.flatten());
  }

  return parsed.data;
};

export const requireRuntimeToken = (
  request: Request,
  options?: {
    bodyRuntimeToken?: string | null | undefined;
    queryRuntimeToken?: string | null | undefined;
  },
) => {
  const headerToken = getBearerToken(request);

  if (headerToken) {
    return headerToken;
  }

  const bodyToken = options?.bodyRuntimeToken?.trim();

  if (bodyToken) {
    return bodyToken;
  }

  const queryToken =
    options?.queryRuntimeToken?.trim() || new URL(request.url).searchParams.get('runtimeToken')?.trim();

  if (queryToken) {
    return queryToken;
  }

  throw new RuntimeRouteError('Missing runtime token', 401, 'MISSING_RUNTIME_TOKEN');
};

export const getRuntimeTokenFromRequest = async (request: Request): Promise<string | null> => {
  const headerToken = getBearerToken(request);

  if (headerToken) {
    return headerToken;
  }

  if (request.method !== 'GET') {
    try {
      const clone = request.clone();
      const body = (await clone.json()) as any;

      if (typeof body?.runtimeToken === 'string' && body.runtimeToken.length > 0) {
        return body.runtimeToken;
      }
    } catch {
      // noop
    }
  }

  const url = new URL(request.url);
  const queryToken = url.searchParams.get('runtimeToken');

  if (queryToken) {
    return queryToken;
  }

  return null;
};

export const jsonResponse = (data: unknown, status = 200, headers?: HeadersInit) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
};

export const actorCookieName = 'bolt_actor_id';

export const getOrCreateActorId = (request: Request) => {
  const cookie = request.headers.get('cookie') || '';
  const actorCookie = cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${actorCookieName}=`));

  if (actorCookie) {
    return actorCookie.slice(actorCookie.indexOf('=') + 1);
  }

  return crypto.randomUUID();
};

export const buildActorCookieHeader = (actorId: string) => {
  const oneYearSec = 60 * 60 * 24 * 365;
  return `${actorCookieName}=${encodeURIComponent(actorId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${oneYearSec}`;
};
