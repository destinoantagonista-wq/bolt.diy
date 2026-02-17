import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { useLoaderData } from '@remix-run/react';
import { getRuntimeServerConfig } from '~/lib/.server/runtime/config';
import { LegacyWebcontainerPreview } from '~/lib/legacy/webcontainer/preview';

export async function loader({ params, context }: LoaderFunctionArgs) {
  const env = (context as any)?.cloudflare?.env as Record<string, unknown> | undefined;
  const config = getRuntimeServerConfig(env);

  if (config.runtimeProvider === 'dokploy' || !config.enableWebcontainerLegacy) {
    throw new Response('Not Found', { status: 404 });
  }

  const previewId = params.id;

  if (!previewId) {
    throw new Response('Preview ID is required', { status: 400 });
  }

  console.info('[runtime.legacy.webcontainer.preview]', {
    runtimeProvider: config.runtimeProvider,
    legacyEnabled: config.enableWebcontainerLegacy,
    previewId,
  });

  return json({ previewId });
}

export default function WebContainerPreview() {
  const { previewId } = useLoaderData<typeof loader>();
  return <LegacyWebcontainerPreview previewId={previewId} />;
}
