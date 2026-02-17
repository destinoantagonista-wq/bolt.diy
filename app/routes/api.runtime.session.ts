import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/cloudflare';
import { sessionActionQuerySchema, sessionCreateBodySchema } from '~/lib/.server/runtime/route-schemas';
import {
  createRuntimeSession,
  deleteRuntimeSession,
  getRuntimeSession,
  mapRuntimeRouteError,
} from '~/lib/.server/runtime/session-orchestrator';
import {
  assertMethod,
  buildActorCookieHeader,
  getOrCreateActorId,
  getRuntimeConfigFromContext,
  getRuntimeRequestId,
  jsonResponse,
  parseJsonBody,
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

    const query = parseQuery(args.request, sessionActionQuerySchema);
    const runtimeToken = requireRuntimeToken(args.request, {
      queryRuntimeToken: query.runtimeToken,
    });

    const requestId = getRuntimeRequestId(args.request);
    const result = await getRuntimeSession({
      config,
      runtimeToken,
      requestId,
    });

    return jsonResponse({
      sessionStatus: result.session.status,
      previewUrl: result.session.previewUrl,
      deploymentStatus: result.deploymentStatus,
      session: result.session,
    });
  } catch (error) {
    return mapRuntimeRouteError(error);
  }
};

export const action = async (args: ActionFunctionArgs) => {
  try {
    assertMethod(args.request, ['POST', 'DELETE']);

    const config = getRuntimeConfigFromContext(args);

    if (config.runtimeProvider !== 'dokploy') {
      return runtimeErrorResponse('Runtime provider is not dokploy', 400, 'BAD_REQUEST');
    }

    const requestId = getRuntimeRequestId(args.request);
    const query = parseQuery(args.request, sessionActionQuerySchema);

    if (args.request.method === 'POST') {
      const body = await parseJsonBody(args.request, sessionCreateBodySchema);
      const chatId = body.chatId;
      const templateId = body.templateId;
      const bodyRuntimeToken = body.runtimeToken;
      const intent = query.intent;

      if (intent === 'delete' || (!chatId && bodyRuntimeToken)) {
        const runtimeToken = requireRuntimeToken(args.request, {
          bodyRuntimeToken,
          queryRuntimeToken: query.runtimeToken,
        });

        const result = await deleteRuntimeSession({
          config,
          runtimeToken,
          requestId,
        });

        return jsonResponse(result);
      }

      if (!chatId) {
        return runtimeErrorResponse('chatId is required', 400, 'BAD_REQUEST');
      }

      const actorId = getOrCreateActorId(args.request);
      const result = await createRuntimeSession({
        config,
        chatId,
        templateId,
        actorId,
        requestId,
      });

      return jsonResponse(
        {
          runtimeToken: result.runtimeToken,
          session: result.session,
          deploymentStatus: result.deploymentStatus,
        },
        200,
        {
          'set-cookie': buildActorCookieHeader(actorId),
        },
      );
    }

    if (args.request.method === 'DELETE') {
      const body = await parseJsonBody(args.request, sessionCreateBodySchema);
      const runtimeToken = requireRuntimeToken(args.request, {
        bodyRuntimeToken: body.runtimeToken,
        queryRuntimeToken: query.runtimeToken,
      });

      const result = await deleteRuntimeSession({
        config,
        runtimeToken,
        requestId,
      });

      return jsonResponse(result);
    }

    return runtimeErrorResponse('Method not allowed', 405, 'METHOD_NOT_ALLOWED');
  } catch (error) {
    return mapRuntimeRouteError(error);
  }
};
