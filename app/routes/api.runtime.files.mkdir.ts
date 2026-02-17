import type { ActionFunctionArgs } from '@remix-run/cloudflare';
import { DokployClient } from '~/lib/.server/runtime/dokploy-client';
import { toRuntimePath } from '~/lib/.server/runtime/path-mapper';
import { mapRuntimeRouteError, withRuntimeClaims } from '~/lib/.server/runtime/session-orchestrator';
import {
  getRuntimeConfigFromContext,
  getRuntimeRequestId,
  getRuntimeTokenFromRequest,
  jsonResponse,
} from '~/lib/.server/runtime/route-utils';

export const action = async (args: ActionFunctionArgs) => {
  try {
    const config = getRuntimeConfigFromContext(args);

    if (config.runtimeProvider !== 'dokploy') {
      return jsonResponse({ error: 'Runtime provider is not dokploy' }, 400);
    }

    if (args.request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const runtimeToken = await getRuntimeTokenFromRequest(args.request);

    if (!runtimeToken) {
      return jsonResponse({ error: 'Missing runtime token' }, 401);
    }

    const body = (await args.request.json()) as any;
    const path = toRuntimePath(typeof body?.path === 'string' ? body.path : '');

    if (!path) {
      return jsonResponse({ error: 'Missing path' }, 400);
    }

    const claims = await withRuntimeClaims({ config, runtimeToken });
    const requestId = getRuntimeRequestId(args.request);
    const client = new DokployClient({
      baseUrl: config.dokployBaseUrl,
      apiKey: config.dokployApiKey,
    });

    await client.fileMkdir(
      {
        serviceId: claims.composeId,
        serviceType: 'compose',
        path,
      },
      requestId,
    );

    return jsonResponse({ ok: true });
  } catch (error) {
    return mapRuntimeRouteError(error);
  }
};
