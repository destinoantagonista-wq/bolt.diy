import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/cloudflare';
import { getRuntimeServerConfig } from './config';

export const getRuntimeRequestId = (request: Request) => {
  return request.headers.get('x-request-id') || crypto.randomUUID();
};

export const getRuntimeConfigFromContext = (args: Pick<ActionFunctionArgs | LoaderFunctionArgs, 'context'>) => {
  const env = (args.context as any)?.cloudflare?.env as Record<string, unknown> | undefined;
  return getRuntimeServerConfig(env);
};

export const getRuntimeTokenFromRequest = async (request: Request): Promise<string | null> => {
  const header = request.headers.get('authorization') || request.headers.get('Authorization');

  if (header?.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
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
