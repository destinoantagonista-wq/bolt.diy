import type { RuntimeProvider } from '~/lib/.server/runtime/types';

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

const parseBoolean = (value: string | undefined | null, key: string) => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

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

export const runtimeProvider = normalizeProvider(
  import.meta.env.VITE_RUNTIME_PROVIDER || import.meta.env.RUNTIME_PROVIDER || undefined,
);

export const isDokployRuntime = runtimeProvider === 'dokploy';

const legacyOverride = parseBoolean(
  import.meta.env.VITE_ENABLE_WEBCONTAINER_LEGACY || import.meta.env.ENABLE_WEBCONTAINER_LEGACY || undefined,
  'VITE_ENABLE_WEBCONTAINER_LEGACY',
);

export const isWebcontainerLegacyEnabled = legacyOverride ?? runtimeProvider === 'webcontainer';
