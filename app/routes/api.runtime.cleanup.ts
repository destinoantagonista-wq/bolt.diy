import type { ActionFunctionArgs } from '@remix-run/cloudflare';
import { cleanupExpiredActorSessions } from '~/lib/.server/runtime/cleanup';
import { getRuntimeServerConfig } from '~/lib/.server/runtime/config';
import { DokployClient } from '~/lib/.server/runtime/dokploy-client';
import { parseRuntimeMetadata } from '~/lib/.server/runtime/metadata';
import { jsonResponse } from '~/lib/.server/runtime/route-utils';

export const action = async ({ context, request }: ActionFunctionArgs) => {
  try {
    const env = (context as any)?.cloudflare?.env as Record<string, unknown> | undefined;
    const config = getRuntimeServerConfig(env);

    if (config.runtimeProvider !== 'dokploy') {
      return jsonResponse({ error: 'Runtime provider is not dokploy' }, 400);
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    if (config.cleanupSecret) {
      const token = request.headers.get('x-runtime-cleanup-secret');

      if (token !== config.cleanupSecret) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
    }

    const payload = ((await request.json().catch(() => ({}))) as any) || {};
    const actorId = typeof payload?.actorId === 'string' ? payload.actorId : '';

    const client = new DokployClient({
      baseUrl: config.dokployBaseUrl,
      apiKey: config.dokployApiKey,
    });

    if (actorId) {
      await cleanupExpiredActorSessions(client, actorId);
      return jsonResponse({ ok: true, actorCount: 1 });
    }

    const projects = await client.projectAll();
    const actorIds = new Set<string>();

    for (const project of projects || []) {
      for (const environment of project?.environments || []) {
        for (const compose of environment?.compose || []) {
          const metadata = parseRuntimeMetadata(compose?.description);

          if (metadata?.actorId) {
            actorIds.add(metadata.actorId);
          }
        }
      }
    }

    for (const id of actorIds) {
      await cleanupExpiredActorSessions(client, id);
    }

    return jsonResponse({ ok: true, actorCount: actorIds.size });
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : 'Cleanup failed',
      },
      500,
    );
  }
};
