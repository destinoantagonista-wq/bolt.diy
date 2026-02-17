import type { RuntimeProvider } from './types';

export interface RuntimeServerConfig {
  runtimeProvider: RuntimeProvider;
  dokployBaseUrl: string;
  dokployApiKey: string;
  dokployServerId?: string;
  sessionIdleMinutes: number;
  heartbeatSeconds: number;
  tokenSecret: string;
  cleanupSecret?: string;
}

const normalizeProvider = (value: string | undefined | null): RuntimeProvider => {
  if ((value || '').toLowerCase() === 'dokploy') {
    return 'dokploy';
  }

  return 'webcontainer';
};

const readEnv = (key: string, env?: Record<string, unknown>) => {
  const value = env?.[key];

  if (typeof value === 'string') {
    return value;
  }

  return process.env[key];
};

const parseNumber = (value: string | undefined, fallback: number, min: number) => {
  const parsed = Number.parseInt(value || '', 10);

  if (Number.isFinite(parsed) && parsed >= min) {
    return parsed;
  }

  return fallback;
};

export const getRuntimeServerConfig = (env?: Record<string, unknown>): RuntimeServerConfig => {
  const runtimeProvider = normalizeProvider(readEnv('RUNTIME_PROVIDER', env) || readEnv('VITE_RUNTIME_PROVIDER', env));
  const dokployBaseUrl = (readEnv('DOKPLOY_BASE_URL', env) || '').trim();
  const dokployApiKey = (readEnv('DOKPLOY_API_KEY', env) || '').trim();
  const dokployServerId = (readEnv('DOKPLOY_SERVER_ID', env) || '').trim() || undefined;
  const tokenSecret = (readEnv('RUNTIME_TOKEN_SECRET', env) || '').trim();
  const cleanupSecret = (readEnv('RUNTIME_CLEANUP_SECRET', env) || '').trim() || undefined;
  const sessionIdleMinutes = parseNumber(readEnv('RUNTIME_SESSION_IDLE_MIN', env), 15, 1);
  const heartbeatSeconds = parseNumber(readEnv('RUNTIME_HEARTBEAT_SEC', env), 30, 5);

  if (runtimeProvider === 'dokploy') {
    if (!dokployBaseUrl) {
      throw new Error('Missing DOKPLOY_BASE_URL');
    }

    if (!dokployApiKey) {
      throw new Error('Missing DOKPLOY_API_KEY');
    }

    if (!tokenSecret) {
      throw new Error('Missing RUNTIME_TOKEN_SECRET');
    }
  }

  return {
    runtimeProvider,
    dokployBaseUrl,
    dokployApiKey,
    dokployServerId,
    sessionIdleMinutes,
    heartbeatSeconds,
    tokenSecret,
    cleanupSecret,
  };
};
