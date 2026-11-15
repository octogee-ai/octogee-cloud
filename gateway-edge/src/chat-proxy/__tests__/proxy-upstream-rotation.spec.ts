import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.MM_INTERNAL_URL = 'http://mattermost.octogee-test.svc.cluster.local:8065';

const h = vi.hoisted(() => {
  class OpenclawWireError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }

  class GatewayTokenError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }

  const ctl: {
    fetchAuth: ReturnType<typeof vi.fn>;
    openUpstream: ReturnType<typeof vi.fn>;
    requestBootstrap: ReturnType<typeof vi.fn>;
    invalidatedGateways: string[];
    clearedDeviceToken: number;
  } = {
    fetchAuth: vi.fn(),
    openUpstream: vi.fn(),
    requestBootstrap: vi.fn(),
    invalidatedGateways: [],
    clearedDeviceToken: 0,
  };

  return { ctl, OpenclawWireError, GatewayTokenError };
});

vi.mock('@octogee/core/http-candidates/chat-proxy/openclaw/gateway-token', () => ({
  GatewayTokenError: h.GatewayTokenError,
  fetchGatewayAuth: h.ctl.fetchAuth,
  invalidateGatewayToken: (gatewayId: string) => {
    h.ctl.invalidatedGateways.push(gatewayId);
  },
  clearGatewayDeviceToken: async () => {
    h.ctl.clearedDeviceToken += 1;
  },
  persistGatewayDeviceToken: async () => {},
}));

vi.mock('@octogee/core/http-candidates/chat-proxy/openclaw/upstream', () => ({
  OpenclawWireError: h.OpenclawWireError,
  openUpstream: h.ctl.openUpstream,
  requestDevicePairBootstrapToken: h.ctl.requestBootstrap,
}));

const { establishUpstreamWithRotation } = await import('../proxy.js');

function fakeUpstream(label: string) {
  return { label, terminate: vi.fn() };
}

describe('establishUpstreamWithRotation', () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.stubEnv('GATEWAY_ID', 'gw-1');
    h.ctl.fetchAuth.mockReset();
    h.ctl.openUpstream.mockReset();
    h.ctl.requestBootstrap.mockReset().mockResolvedValue('one-time-bootstrap-token');
    h.ctl.invalidatedGateways = [];
    h.ctl.clearedDeviceToken = 0;
  });

  it.each(['gw-2', ''])('rejects a ticket when the local gateway is %j before reading credentials', async (localGatewayId) => {
    vi.stubEnv('GATEWAY_ID', localGatewayId);
    const result = await establishUpstreamWithRotation('gw-1');
    expect(result).toEqual({ ok: false, httpStatus: '403 Forbidden' });
    expect(h.ctl.fetchAuth).not.toHaveBeenCalled();
    expect(h.ctl.openUpstream).not.toHaveBeenCalled();
  });

  it('connects the event socket to the local OpenClaw runtime', async () => {
    vi.stubEnv('OPENCLAW_GATEWAY_URL', 'http://127.0.0.1:18789');
    const upstream = fakeUpstream('local-runtime');
    h.ctl.fetchAuth.mockResolvedValueOnce({ source: 'device-token-file', deviceToken: 'device' });
    h.ctl.openUpstream.mockResolvedValueOnce(upstream);
    try {
      expect(await establishUpstreamWithRotation('gw-1')).toEqual({ ok: true, upstream });
      expect(h.ctl.openUpstream.mock.calls[0]?.[0]?.url).toBe('http://127.0.0.1:18789');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('maps gateway-token source failures to 503 without opening upstream', async () => {
    h.ctl.fetchAuth.mockRejectedValueOnce(new h.GatewayTokenError('token-source-down'));

    const result = await establishUpstreamWithRotation('gw-1');

    expect(result).toEqual({ ok: false, httpStatus: '503 Service Unavailable' });
    expect(h.ctl.openUpstream).not.toHaveBeenCalled();
  });

  it('maps non-auth upstream handshake failures to 502 without token rotation', async () => {
    h.ctl.fetchAuth.mockResolvedValueOnce({ source: 'legacy-token', token: 'cached-token' });
    h.ctl.openUpstream.mockRejectedValueOnce(new h.OpenclawWireError('handshake-timeout'));

    const result = await establishUpstreamWithRotation('gw-1');

    expect(result).toEqual({ ok: false, httpStatus: '502 Bad Gateway' });
    expect(h.ctl.invalidatedGateways).toEqual([]);
    expect(h.ctl.fetchAuth).toHaveBeenCalledTimes(1);
  });

  it('invalidates legacy auth, refetches skip-cache, and returns the retry upstream after auth-failed', async () => {
    const enrollment = fakeUpstream('shared-token-enrollment');
    const recovered = fakeUpstream('recovered');
    h.ctl.fetchAuth
      .mockResolvedValueOnce({ source: 'legacy-token', token: 'stale-token' })
      .mockResolvedValueOnce({ source: 'legacy-token', token: 'fresh-token' });
    h.ctl.openUpstream
      .mockRejectedValueOnce(new h.OpenclawWireError('auth-failed'))
      .mockResolvedValueOnce(enrollment)
      .mockImplementationOnce(async (params: { onDeviceToken?: (auth: { deviceToken: string }) => Promise<void> }) => {
        await params.onDeviceToken?.({ deviceToken: 'issued-device-token' });
        return recovered;
      });

    const result = await establishUpstreamWithRotation('gw-1');

    expect(result).toEqual({ ok: true, upstream: recovered });
    expect(h.ctl.invalidatedGateways).toEqual(['gw-1']);
    expect(h.ctl.fetchAuth).toHaveBeenNthCalledWith(2, {
      gatewayId: 'gw-1',
      skipCache: true,
      allowLegacyFallback: true,
    });
  });

  it('clears device-token auth before retrying an auth-failed device-token handshake', async () => {
    const recovered = fakeUpstream('device-token-recovered');
    h.ctl.fetchAuth
      .mockResolvedValueOnce({ source: 'device-token', token: 'gateway-token', deviceToken: 'stale-device' })
      .mockResolvedValueOnce({ source: 'device-token', token: 'gateway-token', deviceToken: 'fresh-device' });
    h.ctl.openUpstream
      .mockRejectedValueOnce(new h.OpenclawWireError('auth-failed'))
      .mockResolvedValueOnce(recovered);

    const result = await establishUpstreamWithRotation('gw-1');

    expect(result).toEqual({ ok: true, upstream: recovered });
    expect(h.ctl.invalidatedGateways).toEqual([]);
    expect(h.ctl.clearedDeviceToken).toBe(1);
  });

  it('maps auth refetch failures during rotation to 503', async () => {
    h.ctl.fetchAuth
      .mockResolvedValueOnce({ source: 'legacy-token', token: 'stale-token' })
      .mockRejectedValueOnce(new h.GatewayTokenError('token-source-down'));
    h.ctl.openUpstream.mockRejectedValueOnce(new h.OpenclawWireError('auth-failed'));

    const result = await establishUpstreamWithRotation('gw-1');

    expect(result).toEqual({ ok: false, httpStatus: '503 Service Unavailable' });
    expect(h.ctl.invalidatedGateways).toEqual(['gw-1']);
  });
});
