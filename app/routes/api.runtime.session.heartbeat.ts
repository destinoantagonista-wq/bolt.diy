import type { ActionFunctionArgs } from '@remix-run/cloudflare';
import { heartbeatBodySchema } from '~/lib/.server/runtime/route-schemas';
import { heartbeatRuntimeSession, mapRuntimeRouteError } from '~/lib/.server/runtime/session-orchestrator';
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

    const body = await parseJsonBody(args.request, heartbeatBodySchema);
    const runtimeToken = requireRuntimeToken(args.request, {
      bodyRuntimeToken: body.runtimeToken,
    });

    const requestId = getRuntimeRequestId(args.request);
    const result = await heartbeatRuntimeSession({
      config,
      runtimeToken,
      requestId,
    });

    return jsonResponse(result);
  } catch (error) {
    return mapRuntimeRouteError(error);
  }
};
