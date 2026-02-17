import type { RuntimeProvider } from './types';

export interface RuntimeServerConfig {
  runtimeProvider: RuntimeProvider;
  enableWebcontainerLegacy: boolean;
  dokployBaseUrl: string;
  dokployApiKey: string;
  dokployServerId?: string;
  dokployCanaryServerId?: string;
  dokployCanaryRolloutPercent: number;
  sessionIdleMinutes: number;
  heartbeatSeconds: number;
  tokenSecret: string;
  cleanupSecret?: string;
}

const normalizeProvider = (value: string | undefined | null): RuntimeProvider => {
  const normalized = (value || '').trim().toLowerCase();

  if (!normalized || normalized === 'webcontainer') {
    return 'webcontainer';
  }

  if (normalized === 'dokploy') {
    return 'dokploy';
  }

  throw new Error(`Invalid runtime provider "${value}". Use "webcontainer" or "dokploy".`);
};

const readEnv = (key: string, env?: Record<string, unknown>) => {
  const value = env?.[key];

  if (typeof value === 'string') {
    return value;
  }

  return process.env[key];
};

const parseNumber = (value: string | undefined, fallback: number, min: number, key: string, max?: number) => {
  const normalized = (value || '').trim();

  if (!normalized) {
    return fallback;
  }

  const parsed = Number.parseInt(normalized, 10);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${key}. Expected an integer >= ${min}.`);
  }

  if (parsed < min) {
    throw new Error(`Invalid ${key}. Expected a value >= ${min}.`);
  }

  if (typeof max === 'number' && parsed > max) {
    throw new Error(`Invalid ${key}. Expected a value <= ${max}.`);
  }

  return parsed;
};

const parseBoolean = (value: string | undefined, key: string) => {
  const normalized = (value || '').trim().toLowerCase();

  if (!normalized) {
    return undefined;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid ${key}. Use one of: 1,true,yes,on,0,false,no,off.`);
};

export const getRuntimeServerConfig = (env?: Record<string, unknown>): RuntimeServerConfig => {
  const runtimeProvider = normalizeProvider(readEnv('RUNTIME_PROVIDER', env) || readEnv('VITE_RUNTIME_PROVIDER', env));
  const legacyOverride = parseBoolean(
    readEnv('ENABLE_WEBCONTAINER_LEGACY', env) || readEnv('VITE_ENABLE_WEBCONTAINER_LEGACY', env),
    'ENABLE_WEBCONTAINER_LEGACY',
  );
  const enableWebcontainerLegacy = legacyOverride ?? runtimeProvider === 'webcontainer';
  const dokployBaseUrl = (readEnv('DOKPLOY_BASE_URL', env) || '').trim();
  const dokployApiKey = (readEnv('DOKPLOY_API_KEY', env) || '').trim();
  const dokployServerId = (readEnv('DOKPLOY_SERVER_ID', env) || '').trim() || undefined;
  const dokployCanaryServerId = (readEnv('DOKPLOY_CANARY_SERVER_ID', env) || '').trim() || undefined;
  const dokployCanaryRolloutPercent = parseNumber(
    readEnv('DOKPLOY_CANARY_ROLLOUT_PERCENT', env),
    0,
    0,
    'DOKPLOY_CANARY_ROLLOUT_PERCENT',
    100,
  );
  const tokenSecret = (readEnv('RUNTIME_TOKEN_SECRET', env) || '').trim();
  const cleanupSecret = (readEnv('RUNTIME_CLEANUP_SECRET', env) || '').trim() || undefined;
  const sessionIdleMinutes = parseNumber(readEnv('RUNTIME_SESSION_IDLE_MIN', env), 15, 1, 'RUNTIME_SESSION_IDLE_MIN');
  const heartbeatSeconds = parseNumber(readEnv('RUNTIME_HEARTBEAT_SEC', env), 30, 5, 'RUNTIME_HEARTBEAT_SEC');

  if (runtimeProvider === 'dokploy') {
    if (!dokployBaseUrl) {
      throw new Error('Missing DOKPLOY_BASE_URL for dokploy runtime.');
    }

    if (!dokployApiKey) {
      throw new Error('Missing DOKPLOY_API_KEY for dokploy runtime.');
    }

    if (!tokenSecret) {
      throw new Error('Missing RUNTIME_TOKEN_SECRET for dokploy runtime.');
    }

    if (dokployCanaryRolloutPercent > 0 && !dokployCanaryServerId) {
      throw new Error('Missing DOKPLOY_CANARY_SERVER_ID when DOKPLOY_CANARY_ROLLOUT_PERCENT is greater than 0.');
    }
  }

  return {
    runtimeProvider,
    enableWebcontainerLegacy,
    dokployBaseUrl,
    dokployApiKey,
    dokployServerId,
    dokployCanaryServerId,
    dokployCanaryRolloutPercent,
    sessionIdleMinutes,
    heartbeatSeconds,
    tokenSecret,
    cleanupSecret,
  };
};
