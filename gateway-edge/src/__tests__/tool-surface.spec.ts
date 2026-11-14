import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { WebSocket, WebSocketServer } from 'ws';
import { WsUpgradeRouter } from '@octogee/core/ws/upgrade-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ uidFor: vi.fn(async (token: string) => (token === 'other' ? 'other' : 'owner')) }));
vi.mock('../lib/db.js', () => ({ db: {} }));
vi.mock('../middleware/logging.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
import { createToolSurface } from '../routes/tool-surface.js';
import { applyGatewayPrefixStripInPlace } from '../chat-proxy/gateway-prefix.js';
import type { NativeAdminAccessOutcome } from '../lib/native-admin-access.js';
import { installBearerUids } from './helpers/user-bearer.js';
installBearerUids(h.uidFor);
const channelId = 'a'.repeat(26);
const threadRootPostId = 'r'.repeat(26);
const desktopPublicKey = Buffer.alloc(32, 1).toString('base64url');
const desktopNodeId = createHash('sha256').update(Buffer.from(desktopPublicKey, 'base64url')).digest('hex');
const context = { uid: 'owner', gatewayId: 'b-alice', workspaceSlug: 'alice', channelId, agentId: 'octogee-alice-coach', sessionKey: `agent:octogee-alice-coach:mattermost:group:${channelId}`, callerMmUserId: 'u'.repeat(26) };
describe('hosted native Browser surface', () => {
  let app: express.Express; let server: http.Server; let native: WebSocketServer; let base: string; let desktopIdentityRoot: string;
  let scopes: Set<string>; const clients: WebSocket[] = []; const received: Array<Record<string, any>> = []; const history: unknown[] = [];
  let browserTabs: unknown; let failBrowserTabs: boolean; let holdBrowserTabs: boolean;
  const resolveAccess = vi.fn<() => Promise<NativeAdminAccessOutcome>>();
  const resolveControl = vi.fn(async () => ({ uid: context.uid, gatewayId: context.gatewayId, workspaceSlug: context.workspaceSlug, channelId, callerMmUserId: context.callerMmUserId }));
  const resolveChannel = vi.fn(async () => context);
  const fetchImpl = vi.fn(async () => new Response('image-data', { headers: { 'content-type': 'image/png' } }));
  beforeEach(async () => {
    scopes = new Set(['operator.admin']); received.length = 0; history.length = 0;
    browserTabs = { running: true, tabs: [] }; failBrowserTabs = false; holdBrowserTabs = false;
    desktopIdentityRoot = await mkdtemp(join(tmpdir(), 'tool-surface-desktop-'));
    const desktopIdentityPath = join(desktopIdentityRoot, 'identity.json');
    await writeFile(desktopIdentityPath, JSON.stringify({ deviceId: desktopNodeId, publicKey: desktopPublicKey }));
    resolveAccess.mockReset().mockResolvedValue({ kind: 'allowed', gatewayId: 'b-alice', workspaceSlug: 'alice', canControl: true });
    resolveChannel.mockClear(); resolveControl.mockClear(); fetchImpl.mockClear();
    native = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(resolve => native.once('listening', resolve));
    native.on('connection', (socket, req) => {
      if (req.url?.startsWith('/desktop/observe?')) { socket.send(Buffer.from('RFB 003.008\n'), { binary: true }); return; }
      if (req.url?.startsWith('/browser/screencast?')) { socket.send(Buffer.from([0, 0, 0, 0, 1]), { binary: true }); return; }
      socket.on('message', raw => {
        const frame = JSON.parse(raw.toString()); received.push(frame);
        const path = frame.params.path;
        if (path === '/tabs' && holdBrowserTabs) return;
        const payload = frame.method === 'sessions.messages.subscribe' ? { subscribed: true, key: context.sessionKey }
          : frame.method === 'chat.history' ? { messages: history }
          : frame.method === 'themes.list' ? { themes: [] }
          : frame.method === 'themes.get' ? { theme: { id: frame.params.id ?? 'claw' } }
          : frame.method === 'node.list' ? {nodes:[{nodeId:desktopNodeId,displayName:'octogee-desktop',remoteIp:'127.0.0.1',paired:true,connected:true,commands:['desktop.stream']}]}
          : frame.method === 'environments.status' ? { id: frame.params.environmentId, type: 'node', status: 'available', desktop: true, desktopAvailability: { available: true } }
          : frame.method === 'desktop.observe' ? { transport: 'rfb', wsPath: '/desktop/observe?token=desktop-native', control: frame.params.control, audio: { wsPath: '/desktop/audio?token=audio-native', encoding: 'pcm-s16le', sampleRate: 48000, channels: 2 } }
          : frame.method === 'desktop.release' ? { released: true }
          : path === '/' ? { profile: 'computer', enabled: true }
          : path === '/tabs' ? browserTabs
          : path === '/screenshot' ? { path: '/tmp/native-shot.png', targetId: 't1' }
          : path === '/screencast' ? { token: 'native-token', wsPath: '/browser/screencast?token=native-token', targetId: 't1' }
          : { tabs: [] };
        const failed = path === '/tabs' && failBrowserTabs;
        socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: !failed, ...(failed ? { error: { code: 'UNAVAILABLE', message: 'Tabs unavailable' } } : { payload }) }));
      });
    });
    const nativeBase = `http://127.0.0.1:${(native.address() as AddressInfo).port}`;
    const surface = createToolSurface({ env: { GATEWAY_ID: 'b-alice', GATEWAY_CLASS: 'isolated', OPENCLAW_CONTROL_IDENTITY: 'per-user', OCTOGEE_DESKTOP_NODE_IDENTITY_PATH: desktopIdentityPath, OPENCLAW_GATEWAY_URL: nativeBase, API_PUBLIC_URL: 'https://api.example' }, resolveAccess, resolveChannel, resolveControl, fetchImpl, authorizationIntervalMs: 25, log: vi.fn(), openUpstream: async () => {
      const ws = new WebSocket(nativeBase.replace('http:', 'ws:')); await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); return { ws, scopes };
    } });
    app = express(); app.use(express.json()); app.use('/api/g/:gatewayId/tools', surface.router);
    server = http.createServer(app); const upgrades = new WsUpgradeRouter(); surface.attachWs(upgrades, origin => origin === 'https://app.example');
    server.on('upgrade', (req, socket, head) => { applyGatewayPrefixStripInPlace(req); if (!upgrades.dispatch(req, socket, head)) socket.destroy(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    clients.splice(0).forEach(client => client.terminate());
    native.clients.forEach(client => client.terminate());
    await new Promise<void>(resolve => native.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(desktopIdentityRoot, { recursive: true, force: true });
  });
  const ticket = (body: unknown = { channelId, surface: 'browser' }) => request(app).post('/api/g/b-alice/tools/ticket').set('Authorization', 'Bearer owner').send(body);
  async function connect(surface: 'browser' | 'computer' | 'themes' = 'browser') {
    const minted = await ticket({channelId, surface}); expect(minted.status).toBe(200);
    const ws = new WebSocket(`${base}/api/g/b-alice/tools/ws/${minted.body.ticket}`, { headers: { origin: 'https://app.example' } }); clients.push(ws);
    const frames: Array<Record<string, any>> = []; ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
    const closed = new Promise<number>(resolve => ws.once('close', resolve));
    await vi.waitFor(() => expect(frames[0]?.event).toBe('tools.ready'));
    return { ws, frames, closed, minted };
  }
  async function call(connection: Awaited<ReturnType<typeof connect>>, id: string, params: unknown) {
    connection.ws.send(JSON.stringify({ type: 'req', id, method: 'browser.request', params }));
    await vi.waitFor(() => expect(connection.frames.some(frame => frame.id === id)).toBe(true));
    return connection.frames.find(frame => frame.id === id)!;
  }
  it('requires a verified user, native role, and server conversation resolution', async () => {
    expect((await request(app).post('/api/g/b-alice/tools/ticket').send({ channelId })).status).toBe(401);
    expect((await ticket({ channelId, surface: 'browser', sessionKey: 'foreign' })).status).toBe(400);
    resolveAccess.mockResolvedValue({ kind: 'forbidden' }); expect((await ticket()).status).toBe(403); expect(resolveChannel).not.toHaveBeenCalled();
  });
  it('opens a channel-bound Browser without accepting a reply root or an unbound session', async () => {
    expect((await ticket({ channelId, surface: 'browser' })).status).toBe(200);
    expect(resolveChannel).toHaveBeenCalledWith(expect.objectContaining({ uid: context.uid, gatewayId: context.gatewayId, channelId }));
    expect(resolveChannel).toHaveBeenLastCalledWith(expect.not.objectContaining({ threadRootPostId: expect.anything() }));
    expect((await ticket({ channelId, surface: 'browser', threadRootPostId: 'bad' })).status).toBe(400);
    expect((await ticket({ channelId, surface: 'browser', threadRootPostId })).status).toBe(400);
    expect(resolveChannel).toHaveBeenCalledOnce();
  });
  it.each(['computer', 'themes'] as const)('keeps %s controls unbound and denies all conversation methods', async surface => {
    const connection = await connect(surface);
    expect(connection.frames[0].payload).not.toHaveProperty('sessionKey');
    expect(resolveChannel).not.toHaveBeenCalled();
    expect(received.some(frame => ['chat.history', 'sessions.messages.subscribe'].includes(frame.method))).toBe(false);
    for (const method of ['chat.history', 'sessions.messages.subscribe', 'talk.session.steer']) {
      connection.ws.send(JSON.stringify({ type: 'req', id: method, method, params: { sessionKey: context.sessionKey } }));
      await vi.waitFor(() => expect(connection.frames.find(frame => frame.id === method)?.ok).toBe(false));
    }
    expect((await ticket({ channelId, surface, threadRootPostId })).status).toBe(400);
  });
  it('preserves one native connection and forces the configured host profile', async () => {
    const connection = await connect(); expect(connection.frames[0].payload).toMatchObject({ sessionKey: context.sessionKey, profile: 'computer', canControl: true });
    expect((await call(connection, 'tabs', { method: 'GET', path: '/tabs' })).ok).toBe(true);
    expect(received.at(-1)?.params).toEqual({ method: 'GET', path: '/tabs', target: 'host', query: { profile: 'computer' }, tabScope: { sessionKey: context.sessionKey, referencedTabs: [] } });
    expect(native.clients.size).toBe(1);
    expect((await call(connection, 'foreign', { method: 'GET', path: '/tabs', query: { profile: 'other' } })).ok).toBe(false);
    expect(received.filter(frame => frame.method === 'browser.request')).toHaveLength(2);
  });
  it('accepts the native renderer tab scope and binds every operation to the admitted conversation', async () => {
    const connection = await connect();
    const tabScope = { sessionKey: context.sessionKey, referencedTabs: [] };
    expect((await call(connection, 'native-tabs', { target: 'host', method: 'GET', path: '/tabs', tabScope })).ok).toBe(true);
    expect(received.at(-1)?.params).toEqual({ method: 'GET', path: '/tabs', target: 'host', query: { profile: 'computer' }, tabScope });
    expect((await call(connection, 'native-open', { method: 'POST', path: '/tabs/open', body: { url: 'https://example.com' }, tabScope: { sessionKey: context.sessionKey } })).ok).toBe(true);
    expect(received.at(-1)?.params.tabScope).toEqual({ sessionKey: context.sessionKey });
    const count = received.length;
    for (const [index, scope] of [
      { sessionKey: 'foreign', referencedTabs: [] },
      { sessionKey: context.sessionKey, referencedTabs: [{ target: 'host', profile: 'computer', targetId: 'foreign' }] },
      { sessionKey: context.sessionKey, referencedTabs: [{ target: 'node', node: 'foreign', targetId: 't1' }] },
    ].entries()) {
      expect((await call(connection, `untrusted-${index}`, { method: 'GET', path: '/tabs', tabScope: scope })).ok).toBe(false);
    }
    expect(received).toHaveLength(count);
  });
  it.each([
    { name: 'replaced browser', running: true, tabs: [{ targetId: 'new-tab' }], available: false },
    { name: 'stopped browser', running: false, tabs: [], available: false },
    { name: 'current raw target', running: true, tabs: [{ targetId: 'historical-tab' }], available: true },
    { name: 'current stable alias', running: true, tabs: [{ targetId: 'current-target', tabId: 'historical-tab' }], available: true },
  ])('validates a historical Browser selection against a $name', async ({ running, tabs, available }) => {
    const tab = { target: 'host', profile: 'computer', targetId: 'historical-tab' };
    history.push({ role: 'toolResult', toolName: 'browser', toolCallId: 'prior-call',
      content: [{ type: 'text', text: 'ok' }], details: { browserTab: tab } });
    browserTabs = { running, tabs };

    const connection = await connect();

    if (available) expect(connection.frames[0].payload.browserTab).toEqual({ tab, revision: 'prior-call' });
    else expect(connection.frames[0].payload).not.toHaveProperty('browserTab');
    expect(received.filter(frame => frame.method === 'browser.request' && frame.params.path === '/tabs'))
      .toEqual([expect.objectContaining({ params: { method: 'GET', path: '/tabs', target: 'host',
        query: { profile: 'computer' }, tabScope: { sessionKey: context.sessionKey, referencedTabs: [tab] } } })]);
    expect(received.filter(frame => frame.method === 'browser.request' && frame.params.method !== 'GET')).toEqual([]);
  });

  it.each(['failed', 'malformed', 'malformed-tab'])('surfaces a %s native tab observation instead of treating it as an absent historical tab', async failure => {
    history.push({ role: 'toolResult', toolName: 'browser', toolCallId: 'prior-call',
      content: [{ type: 'text', text: 'ok' }], details: { browserTab: { target: 'host', profile: 'computer', targetId: 'historical-tab' } } });
    failBrowserTabs = failure === 'failed';
    browserTabs = failure === 'malformed-tab' ? { running: true, tabs: [{ tabId: 'historical-tab' }] } : { running: true };
    const minted = await ticket();
    const ws = new WebSocket(`${base}/api/g/b-alice/tools/ws/${minted.body.ticket}`, { headers: { origin: 'https://app.example' } }); clients.push(ws);
    const frames: unknown[] = []; ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
    const closed = new Promise<number>(resolve => ws.once('close', resolve));

    expect(await closed).toBe(1011);
    expect(frames).toEqual([]);
  });

  it('closes the existing native connection when the Browser disconnects during historical tab observation', async () => {
    history.push({ role: 'toolResult', toolName: 'browser', toolCallId: 'prior-call',
      content: [{ type: 'text', text: 'ok' }], details: { browserTab: { target: 'host', profile: 'computer', targetId: 'historical-tab' } } });
    holdBrowserTabs = true;
    const minted = await ticket();
    const ws = new WebSocket(`${base}/api/g/b-alice/tools/ws/${minted.body.ticket}`, { headers: { origin: 'https://app.example' } }); clients.push(ws);
    const frames: unknown[] = []; ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
    const closed = new Promise<number>(resolve => ws.once('close', resolve));
    await vi.waitFor(() => expect(received.filter(frame => frame.method === 'browser.request' && frame.params.path === '/tabs')).toHaveLength(1));

    ws.close();
    await closed;

    await vi.waitFor(() => expect(native.clients.size).toBe(0));
    expect(frames).toEqual([]);
  });

  it('admits reference hints only from this native session history and scoped live resources', async () => {
    const tab = { target: 'host', profile: 'computer', targetId: 't1' };
    const message = { role: 'toolResult', toolName: 'browser', toolCallId: 'call', content: [{ type: 'text', text: 'ok' }], details: { browserTab: tab } };
    history.push(message);
    const connection = await connect();
    expect((await call(connection, 'history-ref', { method: 'GET', path: '/tabs', tabScope: { sessionKey: context.sessionKey, referencedTabs: [tab] } })).ok).toBe(true);
    expect(received.at(-1)?.params.tabScope).toEqual({ sessionKey: context.sessionKey, referencedTabs: [tab] });
    const liveTab = { ...tab, targetId: 't2' };
    const payload = { agentId: context.agentId, sessionKey: context.sessionKey, messageId: 'live', message: { ...message, details: { browserTab: liveTab } } };
    for (const ws of native.clients) {
      ws.send(JSON.stringify({ type: 'event', event: 'session.message', payload: { ...payload, sessionKey: 'foreign', message: { ...message, details: { browserTab: { ...tab, targetId: 'foreign' } } } } }));
      ws.send(JSON.stringify({ type: 'event', event: 'session.message', payload }));
    }
    await vi.waitFor(() => expect(connection.frames.some(frame => frame.event === 'tools.browser-tab')).toBe(true));
    expect((await call(connection, 'live-ref', { method: 'GET', path: '/tabs', tabScope: { sessionKey: context.sessionKey, referencedTabs: [liveTab] } })).ok).toBe(true);
    expect(received.at(-1)?.params.tabScope.referencedTabs).toEqual([liveTab]);
    const count = received.length;
    expect((await call(connection, 'foreign-event-ref', { method: 'GET', path: '/tabs', tabScope: { sessionKey: context.sessionKey, referencedTabs: [{ ...tab, targetId: 'foreign' }] } })).ok).toBe(false);
    expect(received).toHaveLength(count);
  });
  it('only serves issued media to its authenticated owner and revokes it on disconnect', async () => {
    const connection = await connect(); const shot = await call(connection, 'shot', { method: 'POST', path: '/screenshot', body: { targetId: 't1', type: 'png' } });
    expect(shot.payload.path).not.toBe('/tmp/native-shot.png');
    const url = `/api/g/b-alice/tools/__openclaw__/assistant-media?source=${shot.payload.path}`;
    expect((await request(app).get(url).set('Authorization', 'Bearer other')).status).toBe(404);
    expect((await request(app).get(url).set('Authorization', 'Bearer owner')).status).toBe(200);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('source=%2Ftmp%2Fnative-shot.png');
    expect(new URL(String(fetchImpl.mock.calls[0][0])).pathname).toBe('/g/b-alice/openclaw/__openclaw__/assistant-media');
    connection.ws.close(); await connection.closed;
    expect((await request(app).get(url).set('Authorization', 'Bearer owner')).status).toBe(404);
    expect((await request(app).get('/api/g/b-alice/tools/__openclaw__/assistant-media?source=/etc/passwd').set('Authorization', 'Bearer owner')).status).toBe(404);
  });
  it('rewrites native screencast authority and relays bounded binary frames', async () => {
    const connection = await connect(); const result = await call(connection, 'stream', { method: 'POST', path: '/screencast', body: { targetId: 't1', maxWidth: 800, maxHeight: 600 } });
    expect(result.payload.wsPath).toMatch(/^\/g\/b-alice\/tools\/stream\/[a-f0-9-]+$/u);
    const stream = new WebSocket(`${base}${result.payload.wsPath.replace(/^\/g\//u, "/api/g/")}`, { headers: { origin: 'https://app.example' } }); clients.push(stream);
    const data = await new Promise<Buffer>((resolve, reject) => { stream.once('message', data => resolve(data as Buffer)); stream.once('error', reject); });
    expect(data).toEqual(Buffer.from([0, 0, 0, 0, 1]));
    const closed = new Promise<void>(resolve => stream.once('close', () => resolve())); connection.ws.close(); await closed;
  });
  it('closes active transports when role authority is revoked', async () => {
    const connection = await connect(); resolveAccess.mockResolvedValue({ kind: 'forbidden' }); expect(await connection.closed).toBe(1008);
    await vi.waitFor(() => expect(native.clients.size).toBe(0));
  });
  it('hosts the native paired gateway desktop and only releases its own observation', async () => {
    const connection = await connect('computer');
    expect(connection.frames[0].payload.desktopSource).toBe(`node:${desktopNodeId}`);
    expect(connection.frames[0].payload.environments).toEqual([{ id: `node:${desktopNodeId}`, type: 'node', status: 'available', desktop: true, desktopAvailability: { available: true } }]);
    connection.ws.send(JSON.stringify({ type: 'req', id: 'observe', method: 'desktop.observe', params: { source: {kind: 'node',nodeId:desktopNodeId}, control: true } }));
    await vi.waitFor(() => expect(connection.frames.some(frame => frame.id === 'observe')).toBe(true));
    const observation = connection.frames.find(frame => frame.id === 'observe')!.payload;
    expect(observation.wsPath).toMatch(/^\/g\/b-alice\/tools\/stream\//u);
    expect(observation.audio.wsPath).not.toContain('audio-native');
    connection.ws.send(JSON.stringify({ type: 'req', id: 'release', method: 'desktop.release', params: { wsPath: observation.wsPath } }));
    await vi.waitFor(() => expect(connection.frames.some(frame => frame.id === 'release')).toBe(true));
    expect(received.at(-1)).toMatchObject({ method: 'desktop.release', params: { wsPath: '/desktop/observe?token=desktop-native' } });
    connection.ws.send(JSON.stringify({ type: 'req', id: 'foreign', method: 'desktop.release', params: { wsPath: '/desktop/observe?token=foreign' } }));
    await vi.waitFor(() => expect(connection.frames.find(frame => frame.id === 'foreign')?.ok).toBe(false));
  });

  it('preserves the native release association when the desktop stream disconnects first', async () => {
    const connection = await connect('computer');
    connection.ws.send(JSON.stringify({ type: 'req', id: 'observe-close', method: 'desktop.observe', params: {source: {kind: 'node',nodeId:desktopNodeId}, control: true} }));
    await vi.waitFor(() => expect(connection.frames.some(frame => frame.id === 'observe-close')).toBe(true));
    const observation = connection.frames.find(frame => frame.id === 'observe-close')!.payload;
    const stream = new WebSocket(`${base}${observation.wsPath.replace(/^\/g\//u, '/api/g/')}`, { headers: { origin: 'https://app.example' } }); clients.push(stream);
    await new Promise<void>((resolve, reject) => { stream.once('message', () => resolve()); stream.once('error', reject); });
    const closed = new Promise<void>(resolve => stream.once('close', () => resolve())); stream.close(); await closed;
    connection.ws.send(JSON.stringify({ type: 'req', id: 'release-close', method: 'desktop.release', params: {wsPath: observation.wsPath} }));
    await vi.waitFor(() => expect(connection.frames.find(frame => frame.id === 'release-close')?.ok).toBe(true));
    expect(received.at(-1)).toMatchObject({ method: 'desktop.release', params: {wsPath: '/desktop/observe?token=desktop-native'} });
  });

  it('retires paired desktop audio grants across repeated control changes', async () => {
    const connection = await connect('computer');
    const rpc = (id: string, method: string, params: unknown) => new Promise<Record<string, any>>((resolve) => {
      const listener = (data: WebSocket.RawData) => {
        const frame = JSON.parse(data.toString());
        if (frame.id !== id) return;
        connection.ws.off('message', listener);
        resolve(frame);
      };
      connection.ws.on('message', listener);
      connection.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
    for (let index = 0; index < 40; index++) {
      const observation = await rpc(`observe-${index}`, 'desktop.observe', {source: {kind: 'node',nodeId:desktopNodeId}, control: index % 2 === 0});
      expect(observation.ok).toBe(true);
      const released = await rpc(`release-${index}`, 'desktop.release', {wsPath: observation.payload.wsPath});
      expect(released.ok).toBe(true);
    }
  });

  it('reads the native user theme catalog without admitting profile mutations', async () => {
    const connection = await connect('themes');
    connection.ws.send(JSON.stringify({ type: 'req', id: 'list', method: 'themes.list', params: {} }));
    await vi.waitFor(() => expect(connection.frames.find(frame => frame.id === 'list')?.payload).toEqual({ themes: [] }));
    connection.ws.send(JSON.stringify({ type: 'req', id: 'mutate', method: 'users.prefs.set', params: { theme: 'x' } }));
    await vi.waitFor(() => expect(connection.frames.find(frame => frame.id === 'mutate')?.ok).toBe(false));
  });
  it('projects only typed Browser resources from the bound native session', async () => {
    const connection = await connect();
    const payload = { agentId: context.agentId, sessionKey: context.sessionKey, messageId: 'msg', message: { role: 'toolResult', toolName: 'browser', toolCallId: 'call', content: [{type: 'text', text: 'ok'}], details: { browserTab: { target: 'host', profile: 'computer', targetId: 't2' } } } };
    for (const ws of native.clients) { ws.send(JSON.stringify({ type: 'event', event: 'session.message', payload: { ...payload, sessionKey: 'foreign' } })); ws.send(JSON.stringify({ type: 'event', event: 'session.message', payload })); }
    await vi.waitFor(() => expect(connection.frames.filter(frame => frame.event === 'tools.browser-tab')).toHaveLength(1));
    expect(connection.frames.find(frame => frame.event === 'tools.browser-tab')?.payload).toEqual({tab: {target: 'host', profile: 'computer', targetId: 't2'}, revision: 'call'});
    expect(connection.frames.some(frame => frame.event === 'session.message')).toBe(false);
  });

});
