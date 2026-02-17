import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/cloudflare';
import {
  createRuntimeSession,
  deleteRuntimeSession,
  getRuntimeSession,
  mapRuntimeRouteError,
} from '~/lib/.server/runtime/session-orchestrator';
import {
  buildActorCookieHeader,
  getOrCreateActorId,
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
    const config = getRuntimeConfigFromContext(args);

    if (config.runtimeProvider !== 'dokploy') {
      return jsonResponse({ error: 'Runtime provider is not dokploy' }, 400);
    }

    const requestId = getRuntimeRequestId(args.request);

    if (args.request.method === 'POST') {
      const payload = ((await args.request.json().catch(() => ({}))) as any) || {};
      const chatId = typeof payload?.chatId === 'string' ? payload.chatId : '';
      const templateId = typeof payload?.templateId === 'string' ? payload.templateId : undefined;
      const bodyRuntimeToken = typeof payload?.runtimeToken === 'string' ? payload.runtimeToken : '';
      const intent = new URL(args.request.url).searchParams.get('intent');

      if (intent === 'delete' || (!chatId && bodyRuntimeToken)) {
        const runtimeToken = bodyRuntimeToken || (await getRuntimeTokenFromRequest(args.request));

        if (!runtimeToken) {
          return jsonResponse({ error: 'Missing runtime token' }, 401);
        }

        const result = await deleteRuntimeSession({
          config,
          runtimeToken,
          requestId,
        });

        return jsonResponse(result);
      }

      if (!chatId) {
        return jsonResponse({ error: 'chatId is required' }, 400);
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
      const runtimeToken = await getRuntimeTokenFromRequest(args.request);

      if (!runtimeToken) {
        return jsonResponse({ error: 'Missing runtime token' }, 401);
      }

      const result = await deleteRuntimeSession({
        config,
        runtimeToken,
        requestId,
      });

      return jsonResponse(result);
    }

    return jsonResponse({ error: 'Method not allowed' }, 405);
  } catch (error) {
    return mapRuntimeRouteError(error);
  }
};
