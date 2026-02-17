import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import { filesListQuerySchema } from '~/lib/.server/runtime/route-schemas';
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

    const claims = await withRuntimeClaims({ config, runtimeToken });
    const requestId = getRuntimeRequestId(args.request);
    const query = parseQuery(args.request, filesListQuerySchema);
    const path = query.path ? toRuntimePath(query.path) : undefined;
    const client = new DokployClient({
      baseUrl: config.dokployBaseUrl,
      apiKey: config.dokployApiKey,
    });
    const entries = await client.fileList(
      {
        serviceId: claims.composeId,
        serviceType: 'compose',
        path,
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
