import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import { getRuntimeServerConfig } from '~/lib/.server/runtime/config';
import { buildWebcontainerConnectHtml, getWebcontainerEditorOrigin } from '~/lib/legacy/webcontainer/connect';

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const env = (context as any)?.cloudflare?.env as Record<string, unknown> | undefined;
  const config = getRuntimeServerConfig(env);

  if (config.runtimeProvider === 'dokploy' || !config.enableWebcontainerLegacy) {
    throw new Response('Not Found', { status: 404 });
  }

  const editorOrigin = getWebcontainerEditorOrigin(request);
  console.info('[runtime.legacy.webcontainer.connect]', {
    runtimeProvider: config.runtimeProvider,
    legacyEnabled: config.enableWebcontainerLegacy,
    editorOrigin,
  });

  return new Response(buildWebcontainerConnectHtml(editorOrigin), {
    headers: { 'Content-Type': 'text/html' },
  });
};
