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
    const path = toRuntimePath(url.searchParams.get('path') || '');

    if (!path) {
      return jsonResponse({ error: 'Missing path' }, 400);
    }

    const claims = await withRuntimeClaims({ config, runtimeToken });
    const requestId = getRuntimeRequestId(args.request);
    const client = new DokployClient({
      baseUrl: config.dokployBaseUrl,
      apiKey: config.dokployApiKey,
    });
    const file = await client.fileRead(
      {
        serviceId: claims.composeId,
        serviceType: 'compose',
        path,
      },
      requestId,
    );

    return jsonResponse({
      file: {
        ...file,
        virtualPath: toVirtualPath(file.path),
      },
    });
  } catch (error) {
    return mapRuntimeRouteError(error);
  }
};
