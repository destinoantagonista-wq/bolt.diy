import type { ActionFunctionArgs } from '@remix-run/cloudflare';
import { heartbeatRuntimeSession, mapRuntimeRouteError } from '~/lib/.server/runtime/session-orchestrator';
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
