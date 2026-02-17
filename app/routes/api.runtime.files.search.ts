import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import { DokployClient } from '~/lib/.server/runtime/dokploy-client';
import { toRuntimePath, toVirtualPath } from '~/lib/.server/runtime/path-mapper';
import { mapRuntimeRouteError, withRuntimeClaims } from '~/lib/.server/runtime/session-orchestrator';
import {
  getRuntimeConfigFromContext,
  getRuntimeRequestId,
  getRuntimeTokenFromRequest,
  jsonResponse,
} from '~/lib/.server/runtime/route-utils';

export const loader = async (args: LoaderFunctionArgs) => {
  try {
    const config = getRuntimeConfigFromContext(args);

    if (config.runtimeProvider !== 'dokploy') {
      return jsonResponse({ error: 'Runtime provider is not dokploy' }, 400);
    }

    const runtimeToken = await getRuntimeTokenFromRequest(args.request);

    if (!runtimeToken) {
      return jsonResponse({ error: 'Missing runtime token' }, 401);
    }

    const url = new URL(args.request.url);
    const query = (url.searchParams.get('query') || '').trim();
    const path = url.searchParams.get('path');

    if (!query) {
      return jsonResponse({ entries: [] });
    }

    const claims = await withRuntimeClaims({ config, runtimeToken });
    const requestId = getRuntimeRequestId(args.request);
    const client = new DokployClient({
      baseUrl: config.dokployBaseUrl,
      apiKey: config.dokployApiKey,
    });
    const entries = await client.fileSearch(
      {
        serviceId: claims.composeId,
        serviceType: 'compose',
        query,
        path: path ? toRuntimePath(path) : undefined,
        limit: 250,
      },
      requestId,
    );

    return jsonResponse({
      entries: (entries || []).map((entry) => ({
        ...entry,
        virtualPath: toVirtualPath(entry.path),
      })),
    });
  } catch (error) {
    return mapRuntimeRouteError(error);
  }
};
