import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import { filesSearchQuerySchema } from '~/lib/.server/runtime/route-schemas';
import { DokployClient } from '~/lib/.server/runtime/dokploy-client';
import { toRuntimePath, toVirtualPath } from '~/lib/.server/runtime/path-mapper';
import { mapRuntimeRouteError, withRuntimeClaims } from '~/lib/.server/runtime/session-orchestrator';
import {
  assertMethod,
  getRuntimeConfigFromContext,
  getRuntimeRequestId,
  jsonResponse,
  parseQuery,
  requireRuntimeToken,
  runtimeErrorResponse,
} from '~/lib/.server/runtime/route-utils';

export const loader = async (args: LoaderFunctionArgs) => {
  try {
    assertMethod(args.request, 'GET');

    const config = getRuntimeConfigFromContext(args);

    if (config.runtimeProvider !== 'dokploy') {
      return runtimeErrorResponse('Runtime provider is not dokploy', 400, 'BAD_REQUEST');
    }

    const runtimeToken = requireRuntimeToken(args.request);
    const queryParams = parseQuery(args.request, filesSearchQuerySchema);
    const query = queryParams.query;
    const path = queryParams.path;

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
