import type { ActionFunctionArgs } from '@remix-run/cloudflare';
import { filesWriteBodySchema } from '~/lib/.server/runtime/route-schemas';
import { DokployClient } from '~/lib/.server/runtime/dokploy-client';
import { isRedeployTriggerPath, toRuntimePath, toVirtualPath } from '~/lib/.server/runtime/path-mapper';
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
    assertMethod(args.request, ['PUT', 'POST']);

    const config = getRuntimeConfigFromContext(args);

    if (config.runtimeProvider !== 'dokploy') {
      return runtimeErrorResponse('Runtime provider is not dokploy', 400, 'BAD_REQUEST');
    }

    const body = await parseJsonBody(args.request, filesWriteBodySchema);
    const runtimeToken = requireRuntimeToken(args.request, {
      bodyRuntimeToken: body.runtimeToken,
    });
    const path = toRuntimePath(body.path);
    const content = body.content;
    const encoding = body.encoding === 'base64' ? 'base64' : 'utf8';

    if (!path) {
      return runtimeErrorResponse('Missing path', 400, 'BAD_REQUEST');
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
