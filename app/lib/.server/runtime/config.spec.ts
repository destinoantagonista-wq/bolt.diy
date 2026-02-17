import { describe, expect, it } from 'vitest';
import { getRuntimeServerConfig } from './config';

describe('getRuntimeServerConfig', () => {
  it('uses webcontainer defaults when provider is not set', () => {
    const config = getRuntimeServerConfig({});

    expect(config.runtimeProvider).toBe('webcontainer');
    expect(config.enableWebcontainerLegacy).toBe(true);
    expect(config.sessionIdleMinutes).toBe(15);
    expect(config.heartbeatSeconds).toBe(30);
    expect(config.dokployCanaryRolloutPercent).toBe(0);
    expect(config.dokployCanaryServerId).toBeUndefined();
  });

  it('uses dokploy defaults and disables legacy by default', () => {
    const config = getRuntimeServerConfig({
      RUNTIME_PROVIDER: 'dokploy',
      DOKPLOY_BASE_URL: 'https://dokploy.local',
      DOKPLOY_API_KEY: 'secret',
      RUNTIME_TOKEN_SECRET: 'token-secret',
    });

    expect(config.runtimeProvider).toBe('dokploy');
    expect(config.enableWebcontainerLegacy).toBe(false);
    expect(config.dokployCanaryRolloutPercent).toBe(0);
  });

  it('allows explicit legacy override', () => {
    const config = getRuntimeServerConfig({
      RUNTIME_PROVIDER: 'dokploy',
      ENABLE_WEBCONTAINER_LEGACY: 'true',
      DOKPLOY_BASE_URL: 'https://dokploy.local',
      DOKPLOY_API_KEY: 'secret',
      RUNTIME_TOKEN_SECRET: 'token-secret',
    });

    expect(config.enableWebcontainerLegacy).toBe(true);
  });

  it('fails fast when dokploy provider misses required env', () => {
    expect(() =>
      getRuntimeServerConfig({
        RUNTIME_PROVIDER: 'dokploy',
      }),
    ).toThrow(/Missing DOKPLOY_BASE_URL/);
  });

  it('throws on invalid provider value', () => {
    expect(() =>
      getRuntimeServerConfig({
        RUNTIME_PROVIDER: 'invalid-runtime',
      }),
    ).toThrow(/Invalid runtime provider/);
  });

  it('throws on invalid boolean override', () => {
    expect(() =>
      getRuntimeServerConfig({
        ENABLE_WEBCONTAINER_LEGACY: 'maybe',
      }),
    ).toThrow(/Invalid ENABLE_WEBCONTAINER_LEGACY/);
  });

  it('throws on invalid numeric values', () => {
    expect(() =>
      getRuntimeServerConfig({
        RUNTIME_SESSION_IDLE_MIN: '0',
      }),
    ).toThrow(/RUNTIME_SESSION_IDLE_MIN/);

    expect(() =>
      getRuntimeServerConfig({
        RUNTIME_HEARTBEAT_SEC: 'abc',
      }),
    ).toThrow(/RUNTIME_HEARTBEAT_SEC/);
  });

  it('parses canary rollout percent boundaries', () => {
    const onePercent = getRuntimeServerConfig({
      RUNTIME_PROVIDER: 'dokploy',
      DOKPLOY_BASE_URL: 'https://dokploy.local',
      DOKPLOY_API_KEY: 'secret',
      RUNTIME_TOKEN_SECRET: 'token-secret',
      DOKPLOY_CANARY_ROLLOUT_PERCENT: '1',
      DOKPLOY_CANARY_SERVER_ID: 'server-canary',
    });
    const hundredPercent = getRuntimeServerConfig({
      RUNTIME_PROVIDER: 'dokploy',
      DOKPLOY_BASE_URL: 'https://dokploy.local',
      DOKPLOY_API_KEY: 'secret',
      RUNTIME_TOKEN_SECRET: 'token-secret',
      DOKPLOY_CANARY_ROLLOUT_PERCENT: '100',
      DOKPLOY_CANARY_SERVER_ID: 'server-canary',
    });

    expect(onePercent.dokployCanaryRolloutPercent).toBe(1);
    expect(onePercent.dokployCanaryServerId).toBe('server-canary');
    expect(hundredPercent.dokployCanaryRolloutPercent).toBe(100);
  });

  it('throws when canary rollout percent is out of range', () => {
    expect(() =>
      getRuntimeServerConfig({
        RUNTIME_PROVIDER: 'dokploy',
        DOKPLOY_BASE_URL: 'https://dokploy.local',
        DOKPLOY_API_KEY: 'secret',
        RUNTIME_TOKEN_SECRET: 'token-secret',
        DOKPLOY_CANARY_ROLLOUT_PERCENT: '101',
      }),
    ).toThrow(/DOKPLOY_CANARY_ROLLOUT_PERCENT/);
  });

  it('requires canary server id when canary rollout percent is enabled', () => {
    expect(() =>
      getRuntimeServerConfig({
        RUNTIME_PROVIDER: 'dokploy',
        DOKPLOY_BASE_URL: 'https://dokploy.local',
        DOKPLOY_API_KEY: 'secret',
        RUNTIME_TOKEN_SECRET: 'token-secret',
        DOKPLOY_CANARY_ROLLOUT_PERCENT: '5',
      }),
    ).toThrow(/Missing DOKPLOY_CANARY_SERVER_ID/);
  });
});
