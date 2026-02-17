import type { ActionFunctionArgs } from '@remix-run/cloudflare';
import { filesDeleteBodySchema } from '~/lib/.server/runtime/route-schemas';
import { DokployClient } from '~/lib/.server/runtime/dokploy-client';
import { toRuntimePath } from '~/lib/.server/runtime/path-mapper';
import { mapRuntimeRouteError, withRuntimeClaims } from '~/lib/.server/runtime/session-orchestrator';
import {
  assertMethod,
  getRuntimeConfigFromContext,
  getRuntimeRequestId,
  jsonResponse,
  parseJsonBody,
  requireRuntimeToken,
  runtimeErrorResponse,
} from '~/lib/.server/runtime/route-utils';

export const action = async (args: ActionFunctionArgs) => {
  try {
    assertMethod(args.request, 'DELETE');

    const config = getRuntimeConfigFromContext(args);

    if (config.runtimeProvider !== 'dokploy') {
      return runtimeErrorResponse('Runtime provider is not dokploy', 400, 'BAD_REQUEST');
    }

    const body = await parseJsonBody(args.request, filesDeleteBodySchema);
    const runtimeToken = requireRuntimeToken(args.request, {
      bodyRuntimeToken: body.runtimeToken,
    });
    const path = toRuntimePath(body.path);
    const recursive = Boolean(body.recursive);

    if (!path) {
      return runtimeErrorResponse('Missing path', 400, 'BAD_REQUEST');
    }

    const claims = await withRuntimeClaims({ config, runtimeToken });
    const requestId = getRuntimeRequestId(args.request);
    const client = new DokployClient({
      baseUrl: config.dokployBaseUrl,
      apiKey: config.dokployApiKey,
    });

    await client.fileDelete(
      {
        serviceId: claims.composeId,
        serviceType: 'compose',
        path,
        recursive,
      },
      requestId,
    );

    return jsonResponse({ ok: true });
  } catch (error) {
    return mapRuntimeRouteError(error);
  }
};
