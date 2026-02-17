import type { ActionFunctionArgs } from '@remix-run/cloudflare';
import { DokployClient } from '~/lib/.server/runtime/dokploy-client';
import { isRedeployTriggerPath, toRuntimePath, toVirtualPath } from '~/lib/.server/runtime/path-mapper';
import { mapRuntimeRouteError, withRuntimeClaims } from '~/lib/.server/runtime/session-orchestrator';
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

    if (!['PUT', 'POST'].includes(args.request.method)) {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const runtimeToken = await getRuntimeTokenFromRequest(args.request);

    if (!runtimeToken) {
      return jsonResponse({ error: 'Missing runtime token' }, 401);
    }

    const body = (await args.request.json()) as any;
    const rawPath = typeof body?.path === 'string' ? body.path : '';
    const path = toRuntimePath(rawPath);
    const content = typeof body?.content === 'string' ? body.content : '';
    const encoding = body?.encoding === 'base64' ? 'base64' : 'utf8';

    if (!path) {
      return jsonResponse({ error: 'Missing path' }, 400);
    }

    const claims = await withRuntimeClaims({ config, runtimeToken });
    const requestId = getRuntimeRequestId(args.request);
    const client = new DokployClient({
      baseUrl: config.dokployBaseUrl,
      apiKey: config.dokployApiKey,
    });

    await client.fileWrite(
      {
        serviceId: claims.composeId,
        serviceType: 'compose',
        path,
        content,
        encoding,
        overwrite: true,
      },
      requestId,
    );

    if (isRedeployTriggerPath(toVirtualPath(path))) {
      await client.composeRedeploy(claims.composeId, `File change: ${path}`, requestId);
    }

    return jsonResponse({ ok: true });
  } catch (error) {
    return mapRuntimeRouteError(error);
  }
};
