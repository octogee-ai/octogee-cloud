import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { generateIdentity, signConnectDevice } from '@octogee/shared/types/device-identity';
import { WsUpgradeRouter } from '@octogee/core/ws/upgrade-router';
import type { NativeMobileBinding } from '@octogee/shared/types/native-mobile';
import { createMobileGateway } from './mobile.js';
import { mobileDigest } from './mobile-proof.js';
import { installTestUserIdentity } from '../__tests__/helpers/user-identity.js';

const ID = '2b7d671e-180d-4dab-a486-5224ad783155';
const MOUNT = `/api/g/walter/openclaw/mobile/${ID}`;
const NATIVE_MOUNT = '/g/walter/openclaw';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  installTestUserIdentity(null);
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}
async function harness() {
  installTestUserIdentity({
    gatewayId: 'walter',
    state: 'claimed',
    ownerUid: 'owner',
    builderSlug: 'alice',
    leaseId: null,
    generation: null,
  });
  let binding: NativeMobileBinding = {
    id: ID,
    gatewayId: 'walter',
    uid: 'owner',
    workspaceSlug: 'alice',
    allocation: 'allocation',
    state: 'pending',
    setupExpiresAt: Date.now() + 300000,
    bootstrapHash: mobileDigest('bootstrap-credential'),
    httpTokens: [],
  };
  let paired: unknown[] = [],
    omitHandoff = false;
  const expiresAtMs = Date.now() + 300000;
  const setupPayload = {
    url: `wss://api.octogee.com/g/walter/openclaw/mobile/${ID}`,
    bootstrapToken: 'native-setup-bootstrap',
    expiresAtMs,
  };
  const setupReply = {
    setupCode: Buffer.from(JSON.stringify(setupPayload)).toString('base64url'),
    qrDataUrl: 'data:image/png;base64,AAAA',
    expiresAtMs,
    access: 'full',
  };
  const frames: Record<string, any>[] = [],
    headers: http.IncomingHttpHeaders[] = [];
  const paths: string[] = [];
  const conversation = `agent:octogee-alice-coach:mattermost:group:${'c'.repeat(26)}`;
  const prepareChat = vi.fn(async (frame: Record<string, any>) =>
    frame.method === 'chat.send'
      ? {
          kind: 'response' as const,
          frame: {
            type: 'res',
            id: frame.id,
            ok: true,
            payload: {
              sessionKey: frame.params.sessionKey,
              runId: frame.params.idempotencyKey,
              status: 'ok',
            },
          },
        }
      : null,
  );
  const native = http.createServer((req, res) => {
    headers.push(req.headers);
    paths.push(req.url ?? '');
    if (req.url === `${NATIVE_MOUNT}/control-ui-config.json`) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ basePath: '', assistantName: 'Coach' }));
      return;
    }
    res.setHeader('content-type', 'image/png');
    res.end(Buffer.from([0, 1, 2, 255]));
  });
  const nativeWs = new WebSocketServer({ server: native });
  cleanup.push(async () => {
    for (const s of nativeWs.clients) s.terminate();
  });
  nativeWs.on('connection', (ws, req) => {
    headers.push(req.headers);
    ws.send(
      JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'native-nonce' } }),
    );
    ws.send(
      JSON.stringify({ type: 'event', event: 'private-before-auth', payload: { secret: 'must-not-leak' } }),
    );
    ws.on('message', (bytes) => {
      const frame = JSON.parse(bytes.toString());
      frames.push(frame);
      if (frame.method === 'connect') {
        const p = frame.params;
        if (p.role === 'node')
          paired = [
            {
              deviceId: p.device.id,
              publicKey: p.device.publicKey,
              roles: ['node', 'operator'],
              tokens: [
                { role: 'node', createdAtMs: 1 },
                { role: 'operator', createdAtMs: 1 },
              ],
            },
          ];
        ws.send(
          JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: true,
            payload: {
              type: 'hello-ok',
              protocol: 4,
              features: {
                methods: [
                  'health',
                  'chat.send',
                  'chat.abort',
                  'sessions.patch',
                  'config.get',
                  'config.patch',
                  'device.token.rotate',
                  'device.token.revoke',
                ],
              },
              auth: {
                role: p.role,
                issuedAtMs: 1,
                scopes: p.role === 'operator' ? ['operator.admin', 'operator.read', 'operator.write'] : [],
                ...(p.role === 'node'
                  ? {
                      deviceToken: 'node-token',
                      ...(!omitHandoff
                        ? {
                            deviceTokens: [
                              {
                                role: 'operator',
                                deviceToken: 'operator-token',
                                issuedAtMs: 1,
                                scopes: ['operator.admin', 'operator.read', 'operator.write'],
                              },
                            ],
                          }
                        : {}),
                    }
                  : {}),
              },
            },
          }),
        );
      } else {
        if (frame.method === 'device.token.rotate')
          for (const device of paired as Array<{ tokens: Array<{ role: string; rotatedAtMs?: number }> }>) {
            const token = device.tokens.find((t) => t.role === frame.params.role);
            if (token) token.rotatedAtMs = 2;
          }
        ws.send(
          JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: true,
            payload:
              frame.method === 'device.token.rotate'
                ? {
                    token: `rotated-${frame.params.role}`,
                    role: frame.params.role,
                    rotatedAtMs: 2,
                    scopes: frame.params.role === 'operator' ? ['operator.admin'] : [],
                  }
                : { ok: true },
          }),
        );
      }
    });
  });
  const nativePort = await listen(native);
  const broker = vi.fn(async (operation: string, _id: string, fields: Record<string, unknown> = {}) => {
    if (binding.state === 'revoked') throw Error('revoked');
    if (operation === 'reserve')
      binding = { ...binding, ...fields, state: 'reserved' } as NativeMobileBinding;
    if (operation === 'commit')
      binding = { ...binding, ...fields, state: 'awaiting-operator' } as NativeMobileBinding;
    if (operation === 'active') binding = { ...binding, state: 'active' };
    if (operation === 'issued') binding = { ...binding, ...fields } as NativeMobileBinding;
    if (operation === 'tokens') binding = { ...binding, ...fields } as NativeMobileBinding;
    if (
      operation === 'http' &&
      (binding.state !== 'active' || !binding.httpTokens.some((t) => t.hash === fields.tokenHash))
    )
      throw Error('bad bearer');
    if (operation === 'revoke') binding = { ...binding, state: 'revoked', httpTokens: [] };
    if (operation === 'session') return { ...structuredClone(binding), resolvedSessionKey: conversation };
    return structuredClone(binding);
  });
  const identity = generateIdentity();
  const gateway = createMobileGateway({
    env: {
      GATEWAY_ID: 'walter',
      GATEWAY_REVISION_ID: 'walter',
      GATEWAY_CLASS: 'isolated',
      GATEWAY_PROFILE: 'isolated',
      OPENCLAW_CONTROL_IDENTITY: 'per-user',
      OPENCLAW_GATEWAY_URL: `http://127.0.0.1:${nativePort}`,
      API_PUBLIC_URL: 'https://api.octogee.com',
      OPENCLAW_DIR: '/private/tmp/mobile-test',
    },
    broker,
    rpc: async (method) => {
      if (method === 'device.pair.list') return { paired };
      if (method === 'device.pair.setupCode') return setupReply;
      throw Error(method);
    },
    identity: {
      enabled: true,
      userHeaders: () => ({ 'x-octogee-user': 'owner', 'x-octogee-proxy': '1' }),
      serviceHeaders: () => ({}),
      deviceIdentity: () => identity,
      connectScopes: () => ['operator.admin'],
      syncProfile: async () => {},
      syncChannelMemberships: async () => {},
      resolveChatProfile: async () => null,
    },
    authorizationIntervalMs: 100,
    auth: (req, _res, next) => {
      req.uid = 'owner';
      next();
    },
    mattermostChat: { prepare: prepareChat },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/g/:gatewayId/openclaw/mobile', gateway.router);
  app.use(((error, _req, res, _next) =>
    res.status(401).json({ error: error.message })) as express.ErrorRequestHandler);
  const server = http.createServer(app),
    upgrades = new WsUpgradeRouter();
  gateway.attach(upgrades);
  upgrades.attach(server);
  const port = await listen(server);
  const sockets: WebSocket[] = [];
  cleanup.push(async () => {
    sockets.forEach((s) => s.terminate());
  });
  const phone = generateIdentity();
  async function connect(
    role: 'node' | 'operator',
    options: { token?: string; bootstrap?: string; wrongKey?: boolean } = {},
  ) {
    const key = options.wrongKey ? generateIdentity() : phone;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${MOUNT}`);
    sockets.push(ws);
    const seen: Record<string, any>[] = [];
    let signed: Record<string, unknown>;
    const hello = await new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('test handshake timeout')), 5000);
      ws.once('error', reject);
      ws.once('close', () => {
        clearTimeout(timer);
        resolve({ closed: true });
      });
      ws.on('message', (bytes) => {
        const frame = JSON.parse(bytes.toString());
        seen.push(frame);
        if (frame.event === 'connect.challenge') {
          const scopes = role === 'operator' ? ['operator.admin', 'operator.read', 'operator.write'] : [];
          const client = {
            id: 'openclaw-ios',
            mode: role === 'node' ? 'node' : 'ui',
            version: 'test',
            platform: 'ios',
            deviceFamily: 'iPhone',
          };
          signed = {
            type: 'req',
            id: 'connect',
            method: 'connect',
            params: {
              minProtocol: 4,
              maxProtocol: 4,
              client,
              role,
              scopes,
              auth: options.bootstrap
                ? { bootstrapToken: options.bootstrap }
                : { deviceToken: options.token },
              device: signConnectDevice({
                identity: key,
                clientId: client.id,
                clientMode: client.mode,
                role,
                scopes,
                nonce: frame.payload.nonce,
                token: options.bootstrap ?? options.token,
                platform: client.platform,
                deviceFamily: client.deviceFamily,
              }),
            },
          };
          ws.send(JSON.stringify(signed));
        } else if (frame.id === 'connect') {
          clearTimeout(timer);
          resolve(frame);
        }
      });
    });
    return { ws, hello, seen, signed: signed! };
  }
  return {
    connect,
    frames,
    paths,
    headers,
    port,
    broker,
    prepareChat,
    conversation,
    setupReply,
    binding: () => binding,
    nativeRemoved: () => {
      paired = [];
    },
    nativeTokenRevoked: () => {
      for (const device of paired as Array<{ tokens: Array<{ role: string; revokedAtMs?: number }> }>) {
        const token = device.tokens.find((t) => t.role === 'operator');
        if (token) token.revokedAtMs = Date.now();
      }
    },
    nativeNodeTokenRotated: () => {
      for (const device of paired as Array<{ tokens: Array<{ role: string; rotatedAtMs?: number }> }>) {
        const token = device.tokens.find((t) => t.role === 'node');
        if (token) token.rotatedAtMs = 2;
      }
    },
    omitHandoff: () => {
      omitHandoff = true;
    },
  };
}

it('preserves native device proofs and credentials, withholds preauth events, and activates only after operator connect', async () => {
  const h = await harness();
  const node = await h.connect('node', { bootstrap: 'bootstrap-credential' });
  expect(node.hello.ok).toBe(true);
  expect(node.hello.payload.auth.deviceTokens[0].deviceToken).toBe('operator-token');
  expect(node.seen.some((f) => f.event === 'private-before-auth')).toBe(false);
  expect(h.frames[0]).toEqual(node.signed);
  expect(h.binding().state).toBe('awaiting-operator');
  const operator = await h.connect('operator', { token: 'operator-token' });
  expect(operator.hello.ok).toBe(true);
  expect(h.binding().state).toBe('active');
  expect(operator.hello.payload.controlUiBasePath).toBe(MOUNT.replace('/api/g/', '/g/'));
  expect(h.headers.some((headers) => headers['x-octogee-user'] === 'owner')).toBe(true);
  const reply = new Promise((resolve) =>
    operator.ws.once('message', (data) => resolve(JSON.parse(data.toString()))),
  );
  operator.ws.send(JSON.stringify({ type: 'req', id: 'health', method: 'health' }));
  expect(await reply).toMatchObject({ id: 'health', ok: true });
});

it.each(['full', 'limited', 'expired', 'mismatched-expiry'])(
  'accepts only complete, live native QR setup (%s)',
  async (kind) => {
    const h = await harness();
    delete h.binding().bootstrapHash;
    if (kind === 'limited') h.setupReply.access = 'limited';
    if (kind === 'expired') h.setupReply.expiresAtMs = 1;
    if (kind === 'mismatched-expiry') h.setupReply.expiresAtMs += 1;
    const response = await request(`http://127.0.0.1:${h.port}`).post(`${MOUNT}/setup`).send({});
    expect(response.status).toBe(kind === 'full' ? 200 : 401);
    if (kind !== 'full')
      expect(h.broker.mock.calls.some(([operation]) => operation === 'issued')).toBe(false);
  },
);

it('rejects an unrelated key carrying a copied token before forwarding its handshake', async () => {
  const h = await harness();
  await h.connect('node', { bootstrap: 'bootstrap-credential' });
  const prior = h.frames.length;
  const stranger = await h.connect('operator', { token: 'operator-token', wrongKey: true });
  expect(stranger.hello.ok).not.toBe(true);
  expect(h.frames).toHaveLength(prior);
});

it.each([
  ['chat.abort', 'sessionKey'],
  ['sessions.patch', 'key'],
])('forwards the resolved conversation for native %s', async (method, field) => {
  const h = await harness();
  await h.connect('node', { bootstrap: 'bootstrap-credential' });
  const operator = await h.connect('operator', { token: 'operator-token' });
  const reply = new Promise((resolve) => operator.ws.once('message', resolve));
  operator.ws.send(
    JSON.stringify({
      type: 'req',
      id: method,
      method,
      params: { [field]: 'agent:octogee-alice-coach:main' },
    }),
  );
  await reply;
  expect(h.frames.find((frame) => frame.method === method)?.params[field]).toBe(h.conversation);
});

it('rejects sensitive HTTP query credentials while retaining native media selectors', async () => {
  const h = await harness();
  await h.connect('node', { bootstrap: 'bootstrap-credential' });
  await h.connect('operator', { token: 'operator-token' });
  const api = request(`http://127.0.0.1:${h.port}`);
  for (const key of ['token', 'auth', 'secret', 'key']) {
    expect(
      (
        await api
          .get(`${MOUNT}/control-ui-config.json?${key}=private`)
          .set('Authorization', 'Bearer operator-token')
      ).status,
    ).toBe(404);
  }
  expect(
    (
      await api
        .get(`${MOUNT}/__openclaw__/assistant-media?source=photo.png&meta=1&sessionKey=main`)
        .set('Authorization', 'Bearer operator-token')
    ).status,
  ).toBe(200);
});

it('preserves native HEAD metadata without trying to parse an absent response body', async () => {
  const h = await harness();
  const response = await request(`http://127.0.0.1:${h.port}`).head(`${MOUNT}/control-ui-config.json`);
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toContain('application/json');
  expect(response.text).toBeUndefined();
});

it('uses the configured native Control UI mount while retaining root native HTTP endpoints', async () => {
  const h = await harness();
  await h.connect('node', { bootstrap: 'bootstrap-credential' });
  await h.connect('operator', { token: 'operator-token' });
  const api = request(`http://127.0.0.1:${h.port}`);
  await api.get(`${MOUNT}/assets/app.js`);
  await api
    .get(`${MOUNT}/__openclaw__/assistant-media?source=photo.png`)
    .set('Authorization', 'Bearer operator-token');
  await api.get(`${MOUNT}/api/artifacts/download/opaque`).set('Authorization', 'Bearer operator-token');
  expect(h.paths).toContain(`${NATIVE_MOUNT}/assets/app.js`);
  expect(h.paths).toContain(`${NATIVE_MOUNT}/__openclaw__/assistant-media?source=photo.png`);
  expect(h.paths).toContain('/api/artifacts/download/opaque');
});

it('rejects authority-bearing resource paths before forwarding credentials to another server', async () => {
  const received = vi.fn();
  const outside = http.createServer((req, res) => {
    received(req.headers);
    res.end('outside');
  });
  const outsidePort = await listen(outside);
  const h = await harness();
  await h.connect('node', { bootstrap: 'bootstrap-credential' });
  await h.connect('operator', { token: 'operator-token' });
  const response = await request(`http://127.0.0.1:${h.port}`)
    .get(`${MOUNT}//127.0.0.1:${outsidePort}/assets/probe.js`)
    .set('Authorization', 'Bearer operator-token');
  expect(response.status).toBe(404);
  expect(received).not.toHaveBeenCalled();
});

it.each(['main', 'android', 'canonical'])(
  'routes a phone send from %s to the existing conversation and preserves the phone reply key',
  async (kind) => {
    const h = await harness();
    await h.connect('node', { bootstrap: 'bootstrap-credential' });
    const operator = await h.connect('operator', { token: 'operator-token' });
    const key =
      kind === 'main'
        ? 'agent:octogee-alice-coach:main'
        : kind === 'android'
          ? `agent:main:node-${h.binding().deviceId!.slice(0, 12)}`
          : h.conversation;
    const reply = new Promise<Record<string, any>>((resolve) =>
      operator.ws.once('message', (bytes) => resolve(JSON.parse(bytes.toString()))),
    );
    operator.ws.send(
      JSON.stringify({
        type: 'req',
        id: 'send',
        method: 'chat.send',
        params: { sessionKey: key, message: 'Hello Agent', idempotencyKey: 'phone-send' },
      }),
    );
    expect(await reply).toMatchObject({ id: 'send', ok: true, payload: { sessionKey: key } });
    expect(h.prepareChat).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ sessionKey: h.conversation, message: 'Hello Agent' }),
      }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
    expect(h.frames.some((frame) => frame.method === 'chat.send')).toBe(false);
  },
);

it('rejects incomplete native bootstrap handoff instead of reporting node-only setup success', async () => {
  const h = await harness();
  h.omitHandoff();
  const node = await h.connect('node', { bootstrap: 'bootstrap-credential' });
  expect(node.hello).toMatchObject({
    ok: false,
    error: { details: { code: 'AUTH_BOOTSTRAP_TOKEN_INVALID' } },
  });
  expect(h.binding().state).toBe('reserved');
});

it('withholds native credentials when durable handoff commitment fails and keeps the exact-key reservation', async () => {
  const h = await harness();
  const broker = h.broker.getMockImplementation()!;
  h.broker.mockImplementation(async (operation, id, fields) => {
    if (operation === 'commit') throw new Error('broker unavailable');
    return broker(operation, id, fields);
  });
  const node = await h.connect('node', { bootstrap: 'bootstrap-credential' });
  expect(node.hello).toMatchObject({ closed: true });
  expect(node.seen.some((frame) => frame.payload?.auth?.deviceToken)).toBe(false);
  expect(h.binding().state).toBe('reserved');
  expect(h.binding().deviceId).toBeDefined();
  expect(h.binding().httpTokens).toEqual([]);
});

it('retries operator activation without disclosing success when the platform was temporarily unavailable', async () => {
  const h = await harness();
  await h.connect('node', { bootstrap: 'bootstrap-credential' });
  const broker = h.broker.getMockImplementation()!;
  let failActivation = true;
  h.broker.mockImplementation(async (operation, id, fields) => {
    if (operation === 'active' && failActivation) {
      failActivation = false;
      throw new Error('activation unavailable');
    }
    return broker(operation, id, fields);
  });
  expect((await h.connect('operator', { token: 'operator-token' })).hello).toMatchObject({ closed: true });
  expect(h.binding().state).toBe('awaiting-operator');
  expect((await h.connect('operator', { token: 'operator-token' })).hello.ok).toBe(true);
  expect(h.binding().state).toBe('active');
});

it('authenticates binary HTTP resources with operator credentials and projects native UI metadata', async () => {
  const h = await harness();
  await h.connect('node', { bootstrap: 'bootstrap-credential' });
  await h.connect('operator', { token: 'operator-token' });
  const app = `http://127.0.0.1:${h.port}`;
  const resource = `${MOUNT}/__openclaw__/assistant-media?source=test`;
  expect((await request(app).get(resource)).status).toBe(401);
  expect((await request(app).get(resource).set('Authorization', 'Bearer node-token')).status).toBe(401);
  const binary = await request(app).get(resource).set('Authorization', 'Bearer operator-token');
  expect(binary.status).toBe(200);
  expect(binary.body).toEqual(Buffer.from([0, 1, 2, 255]));
  const config = await request(app).get(`${MOUNT}/control-ui-config.json`);
  expect(config.body.basePath).toBe(MOUNT.replace('/api/g/', '/g/'));
  expect(
    (await request(app).get(`${MOUNT}/tools/invoke`).set('Authorization', 'Bearer operator-token')).status,
  ).toBe(404);
});

it('closes existing connections when native pairing is removed and denies reconnection', async () => {
  const h = await harness();
  const node = await h.connect('node', { bootstrap: 'bootstrap-credential' });
  await h.connect('operator', { token: 'operator-token' });
  const closed = new Promise((resolve) => node.ws.once('close', resolve));
  h.nativeRemoved();
  await closed;
  expect(h.binding().state).toBe('revoked');
  expect(
    (await h.connect('operator', { token: 'operator-token' }).catch(() => ({ hello: {} }))).hello,
  ).not.toMatchObject({ ok: true });
});

it('commits a self-rotated native operator credential before disclosing the response', async () => {
  const h = await harness();
  await h.connect('node', { bootstrap: 'bootstrap-credential' });
  const operator = await h.connect('operator', { token: 'operator-token' });
  const reply = new Promise<Record<string, any>>((resolve) =>
    operator.ws.once('message', (bytes) => resolve(JSON.parse(bytes.toString()))),
  );
  operator.ws.send(
    JSON.stringify({
      type: 'req',
      id: 'rotate',
      method: 'device.token.rotate',
      params: { deviceId: h.binding().deviceId, role: 'operator' },
    }),
  );
  expect(await reply).toMatchObject({ id: 'rotate', ok: true, payload: { token: 'rotated-operator' } });
  expect(h.binding().httpTokens).toEqual([
    { hash: mobileDigest('rotated-operator'), scopes: ['operator.admin'], issuedAtMs: 2 },
  ]);
  const url = `http://127.0.0.1:${h.port}`;
  const resource = `${MOUNT}/__openclaw__/assistant-media?source=test`;
  expect((await request(url).get(resource).set('Authorization', 'Bearer operator-token')).status).toBe(401);
  expect((await request(url).get(resource).set('Authorization', 'Bearer rotated-operator')).status).toBe(200);
});

it.each(['native', 'platform'])('closes a live phone when %s access is revoked', async (kind) => {
  const h = await harness();
  const node = await h.connect('node', { bootstrap: 'bootstrap-credential' });
  await h.connect('operator', { token: 'operator-token' });
  const closed = new Promise((resolve) => node.ws.once('close', resolve));
  if (kind === 'native') h.nativeTokenRevoked();
  else await h.broker('revoke', ID);
  await closed;
  expect(h.binding().state).toBe('revoked');
});

it('closes the enrollment when the native node credential is externally rotated', async () => {
  const h = await harness();
  const node = await h.connect('node', { bootstrap: 'bootstrap-credential' });
  await h.connect('operator', { token: 'operator-token' });
  const closed = vi.fn();
  node.ws.once('close', closed);
  h.nativeNodeTokenRotated();
  await vi.waitFor(() => expect(closed).toHaveBeenCalled(), { timeout: 1000 });
  expect(h.binding().state).toBe('revoked');
});

it('persists a self-rotated node generation while retaining the operator HTTP grant', async () => {
  const h = await harness();
  await h.connect('node', { bootstrap: 'bootstrap-credential' });
  const operator = await h.connect('operator', { token: 'operator-token' });
  const response = new Promise<Record<string, any>>((resolve) =>
    operator.ws.once('message', (bytes) => resolve(JSON.parse(bytes.toString()))),
  );
  operator.ws.send(
    JSON.stringify({
      type: 'req',
      id: 'rotate-node',
      method: 'device.token.rotate',
      params: { deviceId: h.binding().deviceId, role: 'node' },
    }),
  );
  expect(await response).toMatchObject({ ok: true, payload: { token: 'rotated-node' } });
  expect(h.binding().nodeTokenIssuedAtMs).toBe(2);
  const resource = `${MOUNT}/__openclaw__/assistant-media?source=test`;
  expect(
    (await request(`http://127.0.0.1:${h.port}`).get(resource).set('Authorization', 'Bearer operator-token'))
      .status,
  ).toBe(200);
  expect(h.binding().state).toBe('active');
});

it('does not revoke a live enrollment while its self-rotated token is being committed', async () => {
  const h = await harness();
  await h.connect('node', { bootstrap: 'bootstrap-credential' });
  const operator = await h.connect('operator', { token: 'operator-token' });
  let finish!: () => void;
  const committing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const broker = h.broker.getMockImplementation()!;
  h.broker.mockImplementation(async (operation, id, fields) => {
    if (operation === 'tokens') await committing;
    return broker(operation, id, fields);
  });
  const response = new Promise<Record<string, any>>((resolve) =>
    operator.ws.once('message', (bytes) => resolve(JSON.parse(bytes.toString()))),
  );
  operator.ws.send(
    JSON.stringify({
      type: 'req',
      id: 'slow-rotate',
      method: 'device.token.rotate',
      params: { deviceId: h.binding().deviceId, role: 'operator' },
    }),
  );
  await vi.waitFor(() => expect(h.broker).toHaveBeenCalledWith('tokens', ID, expect.any(Object)));
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(h.binding().state).toBe('active');
  } finally {
    finish();
  }
  expect(await response).toMatchObject({ id: 'slow-rotate', ok: true });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(h.binding().state).toBe('active');
});
