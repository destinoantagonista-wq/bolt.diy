import type { ActionFunctionArgs } from '@remix-run/cloudflare';
import { redeployBodySchema } from '~/lib/.server/runtime/route-schemas';
import { DokployClient } from '~/lib/.server/runtime/dokploy-client';
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
    assertMethod(args.request, 'POST');

    const config = getRuntimeConfigFromContext(args);

    if (config.runtimeProvider !== 'dokploy') {
      return runtimeErrorResponse('Runtime provider is not dokploy', 400, 'BAD_REQUEST');
    }

    const body = await parseJsonBody(args.request, redeployBodySchema);
    const runtimeToken = requireRuntimeToken(args.request, {
      bodyRuntimeToken: body.runtimeToken,
    });
    const reason = body.reason;
    const claims = await withRuntimeClaims({ config, runtimeToken });
    const requestId = getRuntimeRequestId(args.request);
    const client = new DokployClient({
      baseUrl: config.dokployBaseUrl,
      apiKey: config.dokployApiKey,
    });

    await client.composeRedeploy(claims.composeId, reason, requestId);

    return jsonResponse({ queued: true });
  } catch (error) {
    return mapRuntimeRouteError(error);
  }
};
