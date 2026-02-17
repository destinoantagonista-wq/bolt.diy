import type { RuntimeProvider } from '~/lib/.server/runtime/types';

const normalizeProvider = (value: string | undefined | null): RuntimeProvider => {
  if ((value || '').toLowerCase() === 'dokploy') {
    return 'dokploy';
  }

  return 'webcontainer';
};

export const runtimeProvider = normalizeProvider(
  import.meta.env.VITE_RUNTIME_PROVIDER || import.meta.env.RUNTIME_PROVIDER || undefined,
);

export const isDokployRuntime = runtimeProvider === 'dokploy';
