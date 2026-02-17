import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DokployClient, DokployClientError } from './dokploy-client';

const DOKPLOY_BASE_URL = 'https://dokploy.local';
const DOKPLOY_API_KEY = 'smoke-api-key';

const toJsonResponse = (payload: unknown, status = 200) => {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
};

describe('DokployClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends query request with expected tRPC batch envelope', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      toJsonResponse([
        {
          result: {
            data: {
              json: [{ projectId: 'p1', name: 'Project 1' }],
            },
          },
        },
      ]),
    );

    const client = new DokployClient({
      baseUrl: DOKPLOY_BASE_URL,
      apiKey: DOKPLOY_API_KEY,
    });
    const projects = await client.projectAll('req-1');

    expect(projects).toHaveLength(1);
    expect(projects[0].projectId).toBe('p1');

    const [rawUrl, init] = fetchMock.mock.calls[0];
    const url = new URL(rawUrl as string);
    const headers = (init as RequestInit).headers as Record<string, string>;

    expect(url.pathname).toBe('/api/trpc/project.all');
    expect(url.searchParams.get('batch')).toBe('1');
    expect(url.searchParams.get('input')).toContain('"json":null');
    expect((init as RequestInit).method).toBe('GET');
    expect(headers['x-request-id']).toBe('req-1');
  });

  it('generates x-request-id when requestId is missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      toJsonResponse([
        {
          result: {
            data: {
              json: [{ projectId: 'p1', name: 'Project 1' }],
            },
          },
        },
      ]),
    );

    const client = new DokployClient({
      baseUrl: DOKPLOY_BASE_URL,
      apiKey: DOKPLOY_API_KEY,
    });
    await client.projectAll();

    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;

    expect(typeof headers['x-request-id']).toBe('string');
    expect(headers['x-request-id'].length).toBeGreaterThan(0);
  });

  it('supports single-object mutation envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      toJsonResponse({
        result: {
          data: {
            json: {
              success: true,
              message: 'Deployment queued',
            },
          },
        },
      }),
    );

    const client = new DokployClient({
      baseUrl: DOKPLOY_BASE_URL,
      apiKey: DOKPLOY_API_KEY,
    });
    const result = await client.composeDeploy('compose-1', 'req-2');

    expect(result).toEqual({
      success: true,
      message: 'Deployment queued',
    });
  });

  it('rejects empty batch envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(toJsonResponse([]));

    const client = new DokployClient({
      baseUrl: DOKPLOY_BASE_URL,
      apiKey: DOKPLOY_API_KEY,
      maxRetries: 0,
    });

    await expect(client.projectAll()).rejects.toMatchObject({
      code: 'INVALID_TRPC_RESPONSE',
      status: 502,
    });
  });

  it('rejects envelope without result when request succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      toJsonResponse([
        {
          foo: 'bar',
        },
      ]),
    );

    const client = new DokployClient({
      baseUrl: DOKPLOY_BASE_URL,
      apiKey: DOKPLOY_API_KEY,
      maxRetries: 0,
    });

    await expect(client.projectAll()).rejects.toMatchObject({
      code: 'INVALID_TRPC_RESPONSE',
      status: 502,
    });
  });

  it('maps additional tRPC codes to enterprise HTTP statuses', async () => {
    const scenarios = [
      { code: 'PAYLOAD_TOO_LARGE', expectedStatus: 413 },
      { code: 'TOO_MANY_REQUESTS', expectedStatus: 429 },
      { code: 'NOT_IMPLEMENTED', expectedStatus: 501 },
    ];

    for (const scenario of scenarios) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        toJsonResponse([
          {
            error: {
              message: `Error ${scenario.code}`,
              data: {
                code: scenario.code,
              },
            },
          },
        ]),
      );

      const client = new DokployClient({
        baseUrl: DOKPLOY_BASE_URL,
        apiKey: DOKPLOY_API_KEY,
        maxRetries: 0,
      });

      await expect(client.composeDeploy('compose-1')).rejects.toMatchObject({
        status: scenario.expectedStatus,
        code: scenario.code,
      });

      vi.restoreAllMocks();
    }
  });

  it('retries transient 429 and succeeds', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        toJsonResponse([
          {
            error: {
              message: 'rate limited',
              data: {
                code: 'TOO_MANY_REQUESTS',
              },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        toJsonResponse([
          {
            result: {
              data: {
                json: [{ projectId: 'p1', name: 'Project 1' }],
              },
            },
          },
        ]),
      );

    const client = new DokployClient({
      baseUrl: DOKPLOY_BASE_URL,
      apiKey: DOKPLOY_API_KEY,
      maxRetries: 2,
    });

    const result = await client.projectAll();

    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries transient network failure and succeeds', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(
        toJsonResponse([
          {
            result: {
              data: {
                json: [{ projectId: 'p1', name: 'Project 1' }],
              },
            },
          },
        ]),
      );

    const client = new DokployClient({
      baseUrl: DOKPLOY_BASE_URL,
      apiKey: DOKPLOY_API_KEY,
      maxRetries: 2,
    });

    const result = await client.projectAll();

    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry BAD_REQUEST', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      toJsonResponse([
        {
          error: {
            message: 'Invalid composeId',
            data: {
              code: 'BAD_REQUEST',
            },
          },
        },
      ]),
    );

    const client = new DokployClient({
      baseUrl: DOKPLOY_BASE_URL,
      apiKey: DOKPLOY_API_KEY,
      maxRetries: 2,
    });

    await expect(client.composeDeploy('bad-id')).rejects.toBeInstanceOf(DokployClientError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry NOT_IMPLEMENTED', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      toJsonResponse([
        {
          error: {
            message: 'Tool missing',
            data: {
              code: 'NOT_IMPLEMENTED',
            },
          },
        },
      ]),
    );

    const client = new DokployClient({
      baseUrl: DOKPLOY_BASE_URL,
      apiKey: DOKPLOY_API_KEY,
      maxRetries: 2,
    });

    await expect(client.composeDeploy('compose-1')).rejects.toMatchObject({
      status: 501,
      code: 'NOT_IMPLEMENTED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns parse error on invalid JSON payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not-json-response', {
        status: 200,
      }),
    );

    const client = new DokployClient({
      baseUrl: DOKPLOY_BASE_URL,
      apiKey: DOKPLOY_API_KEY,
      maxRetries: 0,
    });

    await expect(client.projectAll()).rejects.toMatchObject({
      code: 'INVALID_JSON_RESPONSE',
      status: 502,
    });
  });
});
