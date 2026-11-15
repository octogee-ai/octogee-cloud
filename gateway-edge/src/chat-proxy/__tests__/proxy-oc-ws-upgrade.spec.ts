import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket as WsClient } from 'ws';
import type { OpenClawRuntimeBroker } from '../openclaw/runtime-broker.js';

process.env.NODE_ENV = 'test';
process.env.GATEWAY_ID = 'gw-1';
process.env.MM_INTERNAL_URL = 'http://mattermost.octogee-test.svc.cluster.local:8065';

const TICKET = '11111111-2222-3333-4444-555555555555';

const h = vi.hoisted(() => {
  class OpenclawWireError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  class GatewayResolveError extends Error {
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
  class ExpectedAgentIdError extends Error {}

const ctl: {
    originAllowed: boolean;
    resolve: () => { url: string; gatewayId: string; userData: Record<string, unknown> };
    deriveAgentId: () => string;
    fetchToken: (skipCache: boolean) => string;
    openUpstream: (token: string) => unknown;
    inboundAccept: boolean;
    forwardOutbound: boolean;
    invalidatedGateways: string[];
    userGatewayId: string | null;
    lastUpstream: { close: ReturnType<typeof vi.fn> } | null;
  } = {
    originAllowed: true,
    resolve: () => ({ url: 'ws://gw.internal:18789', gatewayId: 'gw-1', userData: {} }),
    deriveAgentId: () => 'agent-1',
    fetchToken: () => 'tok-1',
    openUpstream: () => makeFakeUpstream(),
    inboundAccept: true,
    forwardOutbound: true,
    invalidatedGateways: [],
    userGatewayId: 'gw-1',
    lastUpstream: null,
  };

function makeFakeUpstream() {
    const ee = new EventEmitter() as EventEmitter & {
      readyState: number;
      send: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    ee.readyState = 1;
    ee.send = vi.fn();
    ee.close = vi.fn(() => ee.emit('close'));
    ctl.lastUpstream = ee; 
    return ee;
  }

  return {
    ctl,
    makeFakeUpstream,
    OpenclawWireError,
    GatewayResolveError,
    GatewayTokenError,
    ExpectedAgentIdError,
  };
});

vi.mock('../openclaw/ws-origin.js', () => ({
  isAllowedWsOrigin: () => h.ctl.originAllowed,
  warnIfWsOriginsMisconfigured: () => {},
  _resetWsOriginWarningForTests: () => {},
}));

vi.mock('../../../../platform-api/src/chat-proxy/openclaw/gateway-resolver.js', () => ({
  GatewayResolveError: h.GatewayResolveError,
  resolveGatewayUrl: async () => h.ctl.resolve(),
}));

vi.mock('../openclaw/frame-filter.js', () => ({
  ExpectedAgentIdError: h.ExpectedAgentIdError,
  deriveExpectedAgentId: () => h.ctl.deriveAgentId(),
  shouldForwardFrame: () => ({
    forward: h.ctl.forwardOutbound,
    reason: h.ctl.forwardOutbound ? 'agent-match' : 'agent-mismatch',
  }),
  PER_USER_EVENTS: new Set<string>(),
}));

vi.mock('@octogee/core/http-candidates/chat-proxy/openclaw/gateway-token', () => ({
  GatewayTokenError: h.GatewayTokenError,
  fetchGatewayAuth: async ({ skipCache }: { skipCache?: boolean }) => ({
    source: 'legacy-token',
    token: h.ctl.fetchToken(!!skipCache),
  }),
  invalidateGatewayToken: (gatewayId: string) => {
    h.ctl.invalidatedGateways.push(gatewayId);
  },
  persistGatewayDeviceToken: async () => {},
  clearGatewayDeviceToken: async () => {},
}));

vi.mock('@octogee/core/http-candidates/chat-proxy/openclaw/upstream', () => ({
  OpenclawWireError: h.OpenclawWireError,
  openUpstream: async ({
    token,
    bootstrapToken,
    deviceToken,
    onDeviceToken,
  }: {
    token?: string;
    bootstrapToken?: string;
    deviceToken?: string;
    onDeviceToken?: (auth: { deviceToken: string }) => void | Promise<void>;
  }) => {
    const upstream = h.ctl.openUpstream(deviceToken ?? bootstrapToken ?? token ?? '');
    await onDeviceToken?.({ deviceToken: 'test-device-token' });
    return upstream;
  },
  requestDevicePairBootstrapToken: vi.fn(async () => 'test-bootstrap-token'),
}));

vi.mock('../openclaw/inbound-gate.js', () => ({
  createGateState: () => ({}),
  evaluateInboundFrame: () => ({
    accept: h.ctl.inboundAccept,
    reason: h.ctl.inboundAccept ? 'allowed' : 'blocked',
  }),
  observeOutboundForState: () => {},
}));

const {
  attachChatProxyWsUpgrade,
  chatProxyHandleRequest,
  chatProxyMetricsRegistry,
} = await import('../proxy');

const tickets = new Map<string, Record<string, unknown>>();

const runtimeBroker = {
  async redeemOpenClawWs(ticketId: string) {
    const data = tickets.get(ticketId);
    if (data === undefined || typeof data.uid !== 'string' || Number(data.expiresAt) <= Date.now()) {
      return { kind: 'unauthorized' as const };
    }
    tickets.delete(ticketId);
    try {
      const resolved = h.ctl.resolve();
      return {
        kind: 'redeemed' as const,
        redeemed: {
          uid: data.uid,
          gatewayId: resolved.gatewayId,
          gatewayUrl: resolved.url,
          expectedAgentId: h.ctl.deriveAgentId(),
        },
      };
    } catch (error) {
      if (error instanceof h.GatewayResolveError) {
        return { kind: 'revision-unavailable' as const, reason: error.code };
      }
      throw error;
    }
  },
  async getUserGatewayId() {
    return h.ctl.userGatewayId;
  },
} as unknown as OpenClawRuntimeBroker;

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    void chatProxyHandleRequest(req, res);
  });
  attachChatProxyWsUpgrade(server, {
    runtimeBroker,
    gatewayWatchIntervalMs: 10,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function seedTicket(opts: { expiresAt?: number; uid?: string | null } = {}): void {
  const data: Record<string, unknown> = {
    expiresAt: opts.expiresAt ?? Date.now() + 60_000,
    purpose: "openclaw-ws",
    gatewayId: "",
  };
  if (opts.uid !== undefined && opts.uid !== null) data.uid = opts.uid;
  tickets.set(TICKET, data);
}

function ticketExists(): boolean {
  return tickets.has(TICKET);
}

beforeEach(async () => {
  tickets.clear();
  seedTicket({ uid: 'uid-1' });
  h.ctl.originAllowed = true;
  h.ctl.resolve = () => ({
    url: 'ws://gw.internal:18789',
    gatewayId: 'gw-1',
    userData: {},
  });
  h.ctl.deriveAgentId = () => 'agent-1';
  h.ctl.fetchToken = () => 'tok-1';
  h.ctl.openUpstream = () => h.makeFakeUpstream();
  h.ctl.inboundAccept = true;
  h.ctl.forwardOutbound = true;
  h.ctl.invalidatedGateways = [];
  h.ctl.userGatewayId = 'gw-1';
  h.ctl.lastUpstream = null;
});

function connect(opts: { ticketPath?: string; origin?: string } = {}): Promise<
  | { kind: 'rejected'; status: number }
  | { kind: 'open'; ws: WsClient }
> {
  const path = opts.ticketPath ?? `/api/openclaw/ws/${TICKET}`;
  return new Promise((resolve, reject) => {
    const ws = new WsClient(`ws://127.0.0.1:${port}${path}`, {
      headers: { origin: opts.origin ?? 'https://app.octogee.com' },
    });
    const timer = setTimeout(() => reject(new Error('handshake timed out')), 4_000);
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.resume();
      ws.terminate();
      resolve({ kind: 'rejected', status: res.statusCode ?? 0 });
    });
    ws.on('open', () => {
      clearTimeout(timer);
      resolve({ kind: 'open', ws });
    });
    ws.on('error', () => {
      /* settled by unexpected-response / open */
    });
  });
}

async function readMetrics(): Promise<string> {
  return chatProxyMetricsRegistry.metrics();
}
function metricValue(text: string, linePrefix: string): number {
  const line = text.split('\n').find((l) => l.startsWith(linePrefix));
  if (!line) return 0;
  const n = Number(line.slice(linePrefix.length).trim());
  return Number.isFinite(n) ? n : 0;
}

async function settle(
  r: { kind: 'open'; ws: WsClient } | { kind: 'rejected'; status: number },
): Promise<void> {
  if (r.kind !== 'open') return;
  r.ws.close();
  await vi.waitFor(() => expect(h.ctl.lastUpstream?.close).toHaveBeenCalled());
}

describe('OC WS upgrade — refusal decision table (security boundary)', () => {
  it('rejects a disallowed WebSocket origin with 403 and opens no upstream', async () => {
    h.ctl.originAllowed = false;
    const openSpy = vi.fn(h.makeFakeUpstream);
    h.ctl.openUpstream = openSpy;

    const r = await connect({ origin: 'https://evil.example' });
    expect(r).toEqual({ kind: 'rejected', status: 403 });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed ticket path (not a 36-char uuid) with 401', async () => {
    const r = await connect({ ticketPath: '/api/openclaw/ws/not-a-real-ticket' });
    expect(r).toEqual({ kind: 'rejected', status: 401 });
  });

  it('rejects a ticket that does not exist with 401', async () => {
    tickets.delete(TICKET);
    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 401 });
  });

  it('rejects an expired ticket with 401', async () => {
    seedTicket({ expiresAt: Date.now() - 1, uid: 'uid-1' });
    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 401 });
  });

  it('rejects a ticket with no claimant uid with 401', async () => {
    seedTicket({ uid: null });
    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 401 });
  });

  it('maps an unprovisioned gateway to a retryable 503', async () => {
    h.ctl.resolve = () => {
      throw new h.GatewayResolveError('not-provisioned');
    };
    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 503 });
  });

  it('fails closed when the broker returns malformed agent identity data', async () => {
    h.ctl.deriveAgentId = () => {
      throw new h.ExpectedAgentIdError('no agent');
    };
    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 500 });
  });

  it('maps a gateway-token fetch failure to 503', async () => {
    h.ctl.fetchToken = () => {
      throw new h.GatewayTokenError('token-source-down');
    };
    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 503 });
  });

  it('maps a non-auth upstream handshake failure to 502 without rotating the token', async () => {
    h.ctl.openUpstream = () => {
      throw new h.OpenclawWireError('handshake-timeout');
    };
    const label = 'chat_proxy_openclaw_ws_handshakes_total{outcome="fail:handshake-timeout"}';
    const before = metricValue(await readMetrics(), label);

    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 502 });
    expect(h.ctl.invalidatedGateways).toEqual([]);

expect(metricValue(await readMetrics(), label)).toBe(before + 1);
  });
});

describe('OC WS upgrade — auth-failed token rotation recovery', () => {
  it('on auth-failed, invalidates the cached token, re-fetches skip-cache, retries, and upgrades', async () => {
    const tokens: string[] = [];
    let attempt = 0;
    h.ctl.fetchToken = (skipCache) => {
      tokens.push(skipCache ? 'fresh' : 'cached');
      return skipCache ? 'fresh-tok' : 'stale-tok';
    };
    h.ctl.openUpstream = (token: string) => {
      attempt += 1;
      if (attempt === 1) throw new h.OpenclawWireError('auth-failed');
      expect(token).toBe('fresh-tok');
      return h.makeFakeUpstream();
    };

    const recoveredLabel = 'chat_proxy_openclaw_ws_rotation_recovered_total';
    const before = metricValue(await readMetrics(), recoveredLabel);

    const r = await connect();
    expect(r.kind).toBe('open');

    expect(h.ctl.invalidatedGateways).toEqual(['gw-1']);
    expect(tokens).toEqual(['cached', 'fresh']);

expect(metricValue(await readMetrics(), recoveredLabel)).toBe(before + 1);
    await settle(r);
  });

  it('on auth-failed where the rotation retry also fails, refuses with 502', async () => {
    h.ctl.openUpstream = () => {
      throw new h.OpenclawWireError('auth-failed');
    };
    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 502 });
    expect(h.ctl.invalidatedGateways).toEqual(['gw-1']);
  });

  it('on auth-failed where the token re-fetch itself fails, refuses with 503', async () => {
    let calls = 0;
    h.ctl.fetchToken = () => {
      calls += 1;
      if (calls === 1) return 'stale-tok';
      throw new h.GatewayTokenError('token-source-down');
    };
    h.ctl.openUpstream = () => {
      throw new h.OpenclawWireError('auth-failed');
    };
    const label =
      'chat_proxy_openclaw_ws_handshakes_total{outcome="fail:refetch:token-source-down"}';
    const before = metricValue(await readMetrics(), label);

    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 503 });
    expect(metricValue(await readMetrics(), label)).toBe(before + 1);
  });
});

describe('OC WS upgrade — happy path frame proxying & teardown', () => {
  it('consumes the ticket exactly once and upgrades the connection', async () => {
    const r = await connect();
    expect(r.kind).toBe('open');
    expect(ticketExists()).toBe(false);
    await settle(r);
  });

  it('forwards an accepted browser frame to the upstream gateway', async () => {
    const up = h.makeFakeUpstream();
    h.ctl.openUpstream = () => up;
    h.ctl.inboundAccept = true;

    const r = await connect();
    expect(r.kind).toBe('open');
    if (r.kind !== 'open') return;
    r.ws.send('hello-gateway');
    await vi.waitFor(() => expect(up.send).toHaveBeenCalled());
    await settle(r);
  });

  it('drops a browser frame the inbound gate rejects (never reaches upstream)', async () => {
    const up = h.makeFakeUpstream();
    h.ctl.openUpstream = () => up;
    h.ctl.inboundAccept = false;

    const r = await connect();
    expect(r.kind).toBe('open');
    if (r.kind !== 'open') return;
    r.ws.send('blocked-frame');
    await new Promise((res) => setTimeout(res, 50));
    expect(up.send).not.toHaveBeenCalled();
    await settle(r);
  });

  it('delivers an upstream frame the per-user filter forwards to the browser', async () => {
    const up = h.makeFakeUpstream();
    h.ctl.openUpstream = () => up;
    h.ctl.forwardOutbound = true;

    const r = await connect();
    expect(r.kind).toBe('open');
    if (r.kind !== 'open') return;
    const got = new Promise<string>((res) => r.ws.once('message', (d) => res(d.toString())));
    up.emit('message', Buffer.from('agent-event'), false);
    expect(await got).toBe('agent-event');
    await settle(r);
  });

  it('withholds an upstream frame the per-user filter drops (cross-user isolation)', async () => {
    const up = h.makeFakeUpstream();
    h.ctl.openUpstream = () => up;
    h.ctl.forwardOutbound = false;

    const r = await connect();
    expect(r.kind).toBe('open');
    if (r.kind !== 'open') return;
    let leaked = false;
    r.ws.on('message', () => {
      leaked = true;
    });
    up.emit('message', Buffer.from('other-users-event'), false);
    await new Promise((res) => setTimeout(res, 50));
    expect(leaked).toBe(false);
    await settle(r);
  });

  it('closes the browser socket when the gateway id migrates mid-session', async () => {
    const r = await connect();
    expect(r.kind).toBe('open');
    if (r.kind !== 'open') return;
    const closed = new Promise<number>((res) => r.ws.once('close', (code) => res(code)));
    h.ctl.userGatewayId = 'gw-2';
    expect(await closed).toBe(1001); 
    await settle(r);
  });

  it('tears down the upstream when the browser disconnects', async () => {
    const up = h.makeFakeUpstream();
    h.ctl.openUpstream = () => up;

    const r = await connect();
    expect(r.kind).toBe('open');
    if (r.kind !== 'open') return;
    r.ws.close();
    await vi.waitFor(() => expect(up.close).toHaveBeenCalled());
  });
});
