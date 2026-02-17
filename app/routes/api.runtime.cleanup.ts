import type { ActionFunctionArgs } from '@remix-run/cloudflare';
import { cleanupBodySchema } from '~/lib/.server/runtime/route-schemas';
import { cleanupExpiredActorSessions } from '~/lib/.server/runtime/cleanup';
import { getRuntimeServerConfig } from '~/lib/.server/runtime/config';
import { DokployClient } from '~/lib/.server/runtime/dokploy-client';
import { parseRuntimeMetadata } from '~/lib/.server/runtime/metadata';
import { mapRuntimeRouteError } from '~/lib/.server/runtime/session-orchestrator';
import {
  assertMethod,
  getRuntimeRequestId,
  jsonResponse,
  parseJsonBody,
  runtimeErrorResponse,
} from '~/lib/.server/runtime/route-utils';

export const action = async ({ context, request }: ActionFunctionArgs) => {
  try {
    assertMethod(request, 'POST');

    const requestId = getRuntimeRequestId(request);
    const env = (context as any)?.cloudflare?.env as Record<string, unknown> | undefined;
    const config = getRuntimeServerConfig(env);

    if (config.runtimeProvider !== 'dokploy') {
      return runtimeErrorResponse('Runtime provider is not dokploy', 400, 'BAD_REQUEST');
    }

    if (config.cleanupSecret) {
      const token = request.headers.get('x-runtime-cleanup-secret');

      if (token !== config.cleanupSecret) {
        return runtimeErrorResponse('Unauthorized', 401, 'UNAUTHORIZED');
      }
    }

    const payload = await parseJsonBody(request, cleanupBodySchema);
    const actorId = payload.actorId || '';

    const client = new DokployClient({
      baseUrl: config.dokployBaseUrl,
      apiKey: config.dokployApiKey,
    });

    if (actorId) {
      await cleanupExpiredActorSessions(client, actorId, requestId);
      return jsonResponse({ ok: true, actorCount: 1 });
    }

    const projects = await client.projectAll(requestId);
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
      await cleanupExpiredActorSessions(client, id, requestId);
    }

    return jsonResponse({ ok: true, actorCount: actorIds.size });
  } catch (error) {
    return mapRuntimeRouteError(error);
  }
};
