import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Router, type Request } from 'express';
import { WebSocket } from 'ws';
import { WsUpgradeAuthorizationError, type WsUpgradeRouter } from '@octogee/core/ws/upgrade-router';
import { openClawProxyIdentityHeaders, openClawProxyOrigin } from '@octogee/shared/types/openclaw-proxy-identity';
import { requireAuthenticatedUid } from '@octogee/core/http/auth';
import { authenticatedRequestLimit, authenticationFailureLimit } from '@octogee/core/http/authenticated-request-limit';
import { logger } from '@octogee/core/http/logging';
import { resolveNativeAdminAccess } from '../lib/native-admin-access.js';
import { resolveToolChannelForUid, resolveToolControlForUid, type ToolChannel, type ToolControl } from '../lib/tool-conversation.js';
import { isMattermostPostId } from '@octogee/shared/types/mattermost-session-route';
import { WorkspaceNativeAccessError } from '../lib/workspace-native-access.js';
import { createWsTicketStore, wsTicketFromPath } from '../lib/ws-ticket-store.js';
import { authorizeSession, monitorSessionAuthorization } from '../lib/ws-session-authorization.js';
import { openNativeUserSocket } from '../openclaw-control/native-user-client.js';
import { openClawControlUpstreamBase } from '../openclaw-control/surface.js';
import { podClientAddress } from '../openclaw-control/proxy-identity.js';
import { terminalAvailable } from './terminal.js';
import { browserRecord, browserRequestParams, browserStreamPath } from './browser-policy.js';
import { latestNativeBrowserTab } from '../vendor/openclaw-browser-resources/index.js';
import { containsAsciiControlCharacter } from '@octogee/shared/types/text-validation';
import { nativeBrowserResource, type NativeBrowserTab } from './tool-resources.js';
import { desktopObserveParams, desktopStreamPath, desktopEnvironment, desktopNodeIdentity, readDesktopNodeIdentity, type DesktopEgressReport } from './tool-desktop.js';
import { browserRpc, NativeBrowserError } from './browser-rpc.js';

interface ToolSession {
  surface: 'browser' | 'computer' | 'themes';
  canControl: boolean;
  context: ToolChannel | (ToolControl & { sessionKey?: never; agentId?: never });
  reauthorize(): Promise<boolean>;
}
interface LiveToolSession extends ToolSession {
  active: boolean;
  streams: Set<WebSocket>;
  media: Map<string, { source: string; expiresAt: number }>;
  grants: Map<string, StreamGrant>;
  observations: Map<string, { path: string; expiresAt: number }>;
}
interface StreamGrant { live: LiveToolSession; path: string; publicPath: string; ticket: string; kind: 'browser' | 'rfb' | 'audio'; active: boolean; audio?: StreamGrant; timer?: NodeJS.Timeout }
interface ToolSurfaceOptions {
  env?: NodeJS.ProcessEnv;
  resolveAccess?: typeof resolveNativeAdminAccess;
  resolveChannel?: typeof resolveToolChannelForUid;
  resolveControl?: typeof resolveToolControlForUid;
  openUpstream?: typeof openNativeUserSocket;
  fetchImpl?: typeof fetch;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  authorizationIntervalMs?: number;
  egressReport?: () => DesktopEgressReport | null;
}
const RPC_PREFIX = '/tools/ws/';
const STREAM_PREFIX = '/tools/stream/';
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_MEDIA = 32 * 1024 * 1024;

interface ToolRequest { type: 'req'; id: string; method: string; params?: unknown }
interface ToolRequests {
  live: LiveToolSession;
  rpc: ReturnType<typeof browserRpc>;
  profile?: string;
  browserReferences: ReadonlyMap<string, NativeBrowserTab['tab']>;
  desktopNodeId(): string | undefined;
  readEnvironment(): Promise<Record<string, unknown>>;
  mintStream(path: string, kind: StreamGrant['kind']): { wsPath: string; grant: StreamGrant };
  registerMedia(live: LiveToolSession, source: unknown): string;
  retireGrant(grant: StreamGrant): void;
}
function toolRequest(data: string, binary: boolean, pending: Set<string>): ToolRequest | null {
  let frame: Record<string, unknown> | null;
  try { frame = binary ? null : browserRecord(JSON.parse(data)); } catch { return null; }
  if (!frame || frame.type !== 'req' || typeof frame.id !== 'string' || frame.id.length > 256 || typeof frame.method !== 'string' || pending.has(frame.id) || pending.size >= 16) return null;
  return frame as unknown as ToolRequest;
}
async function requestBrowser(frame: ToolRequest, owner: ToolRequests): Promise<unknown> {
  if (owner.live.surface !== 'browser' || !owner.live.context.sessionKey) throw new Error('Browser conversation unavailable');
  const params = browserRequestParams(frame.params, owner.profile!, { sessionKey: owner.live.context.sessionKey, referencedTabs: owner.browserReferences });
  const result = await owner.rpc.call('browser.request', params, params.path === '/download' ? 155000 : 35000);
  const payload = browserRecord(result);
  if (payload && params.path === '/screencast') {
    const stream = owner.mintStream(browserStreamPath(payload), 'browser');
    payload.token = stream.wsPath.split('/').at(-1);
    payload.wsPath = stream.wsPath;
  }
  if (payload && params.path === '/screenshot') payload.path = owner.registerMedia(owner.live, payload.path);
  const download = browserRecord(payload?.download);
  if (download && params.path === '/download') download.path = owner.registerMedia(owner.live, download.path);
  return result;
}
async function observeDesktop(params: unknown, owner: ToolRequests): Promise<unknown> {
  const { live } = owner;
  for (const [key, observation] of live.observations) {
    if (observation.expiresAt <= Date.now()) live.observations.delete(key);
  }
  if (live.observations.size >= 64 || live.grants.size > 62) throw new Error('Too many desktop observations');
  await owner.readEnvironment();
  const result = await owner.rpc.call('desktop.observe', desktopObserveParams(params, live.canControl, owner.desktopNodeId()!));
  const observed = browserRecord(result);
  if (!observed || observed.transport !== 'rfb' || typeof observed.control !== 'boolean') throw new Error('Invalid native desktop observation');
  const stream = owner.mintStream(desktopStreamPath(observed.wsPath, 'rfb'), 'rfb');
  live.observations.set(stream.wsPath, { path: stream.grant.path, expiresAt: Number.POSITIVE_INFINITY });
  observed.wsPath = stream.wsPath;
  const audio = browserRecord(observed.audio);
  if (audio) {
    const audioStream = owner.mintStream(desktopStreamPath(audio.wsPath, 'audio'), 'audio');
    audio.wsPath = audioStream.wsPath;
    stream.grant.audio = audioStream.grant;
  }
  return result;
}
async function releaseDesktop(value: unknown, owner: ToolRequests): Promise<unknown> {
  const params = browserRecord(value);
  if (!params || Object.keys(params).join(',') !== 'wsPath' || typeof params.wsPath !== 'string') throw new Error('Desktop observation is unavailable');
  const observation = owner.live.observations.get(params.wsPath);
  if (!observation || observation.expiresAt <= Date.now()) throw new Error('Desktop observation is unavailable');
  const result = await owner.rpc.call('desktop.release', { wsPath: observation.path });
  const grant = owner.live.grants.get(params.wsPath);
  if (grant) owner.retireGrant(grant);
  owner.live.observations.delete(params.wsPath);
  return result;
}
function desktopInventoryParams(frame: ToolRequest, nodeId: string | undefined): void {
  const params = browserRecord(frame.params);
  if (!params) throw new Error('Desktop inventory is unavailable');
  const valid = frame.method === 'environments.status'
    ? Object.keys(params).join(',') === 'environmentId' && params.environmentId === `node:${nodeId}`
    : Object.keys(params).length === 0;
  if (!valid) throw new Error('Desktop inventory is unavailable');
}
async function requestVm(frame: ToolRequest, owner: ToolRequests): Promise<unknown> {
  if (frame.method === 'desktop.observe') return observeDesktop(frame.params, owner);
  if (frame.method === 'desktop.release') return releaseDesktop(frame.params, owner);
  if (frame.method !== 'environments.status' && frame.method !== 'environments.list') throw new Error('Tool operation is unavailable');
  desktopInventoryParams(frame, owner.desktopNodeId());
  const environment = await owner.readEnvironment();
  return frame.method === 'environments.status' ? environment : { environments: [environment] };
}
function themeRequestParams(frame: ToolRequest): Record<string, unknown> {
  const params = browserRecord(frame.params);
  if (!params) throw new Error('Theme operation is unavailable');
  const valid = frame.method === 'themes.list' ? Object.keys(params).length === 0
    : Object.keys(params).every(key => key === 'id') && (params.id === undefined || (typeof params.id === 'string' && params.id.length >= 1 && params.id.length <= 256));
  if (!valid) throw new Error('Theme operation is unavailable');
  return params;
}
async function toolOperation(frame: ToolRequest, owner: ToolRequests): Promise<unknown> {
  if (owner.live.surface === 'browser' && frame.method === 'browser.request') return requestBrowser(frame, owner);
  if (owner.live.surface === 'computer') return requestVm(frame, owner);
  if (owner.live.surface === 'themes' && (frame.method === 'themes.list' || frame.method === 'themes.get')) return owner.rpc.call(frame.method, themeRequestParams(frame));
  throw new Error('Tool operation is unavailable');
}
function serveToolRequests(browser: WebSocket, owner: ToolRequests, send: (frame: unknown) => void, close: (code: number, reason: string) => void): void {
  const pending = new Set<string>();
  browser.on('message', (data, binary) => {
    const frame = toolRequest(data.toString(), binary, pending);
    if (!frame) { close(1008, 'Invalid tool request'); return; }
    pending.add(frame.id);
    void toolOperation(frame, owner).then(result => {
      send({ type: 'res', id: frame.id, ok: true, payload: result });
    }).catch(error => {
      send({ type: 'res', id: frame.id, ok: false, error: error instanceof NativeBrowserError ? error.details : { code: 'TOOL_UNAVAILABLE', message: error instanceof Error ? error.message : 'Tool operation failed' } });
    }).finally(() => pending.delete(frame.id));
  });
}
function ticketClaim(req: Request): { channelId: string; surface: ToolSession['surface'] } | null {
  const channelId = req.body?.channelId;
  const surface = req.body?.surface;
  if (!isMattermostPostId(channelId) || !['browser', 'computer', 'themes'].includes(surface) || Object.keys(req.body).some(key => !['channelId', 'surface'].includes(key))) return null;
  return { channelId, surface };
}
function accessDeniedStatus(kind: string): number {
  if (kind === 'unauthenticated') return 401;
  return kind === 'not_found' ? 404 : 403;
}
function requestedMedia(req: Request, mediaOwners: Map<string, LiveToolSession>) {
  const ref = typeof req.query.source === 'string' ? req.query.source : '';
  const live = mediaOwners.get(ref);
  const media = live?.media.get(ref);
  if (!live?.active || !media || media.expiresAt <= Date.now() || live.context.uid !== req.uid || live.context.gatewayId !== (req.params as { gatewayId?: string }).gatewayId ||
    Object.keys(req.query).some(key => key !== 'source')) return null;
  return { live, media };
}
async function readMedia(body: ReadableStream<Uint8Array>, live: LiveToolSession): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_MEDIA || !live.active) throw new Error('Browser media limit exceeded');
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  return Buffer.concat(chunks);
}
async function nativeBrowserProfile(rpc: ReturnType<typeof browserRpc>): Promise<string> {
  const status = browserRecord(await rpc.call('browser.request', { method: 'GET', path: '/', target: 'host' }));
  if (typeof status?.profile !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(status.profile)) throw new Error('Native Browser profile unavailable');
  return status.profile;
}
function browserTabIsCurrent(value: unknown, targetId: string): boolean {
  const current = browserRecord(value);
  if (typeof current?.running !== 'boolean' || !Array.isArray(current.tabs)) throw new Error('Native Browser tab list unavailable');
  const tabs = current.tabs.map(value => {
    const tab = browserRecord(value);
    if (typeof tab?.targetId !== 'string' || !tab.targetId) throw new Error('Native Browser tab list unavailable');
    return tab;
  });
  return current.running && tabs.some(tab => tab.targetId === targetId || tab.tabId === targetId);
}
async function subscribeBrowserResources(rpc: ReturnType<typeof browserRpc>, session: ToolSession, profile: string, rememberTab: (resource: NativeBrowserTab) => void): Promise<NativeBrowserTab | null> {
  if (session.surface !== 'browser' || !session.context.sessionKey) throw new Error('Browser conversation unavailable');
  const subscribed = browserRecord(await rpc.call('sessions.messages.subscribe', { key: session.context.sessionKey, agentId: session.context.agentId }));
  if (subscribed?.subscribed !== true || subscribed.key !== session.context.sessionKey) throw new Error('Native session resource subscription unavailable');
  const history = browserRecord(await rpc.call('chat.history', { sessionKey: session.context.sessionKey, agentId: session.context.agentId, limit: 50, maxBytes: 262144 }));
  if (!history || !Array.isArray(history.messages)) throw new Error('Native session resource history unavailable');
  for (const message of history.messages) {
    const resource = latestNativeBrowserTab([message], profile);
    if (resource) rememberTab(resource);
  }
  const historicalTab = latestNativeBrowserTab(history.messages, profile);
  if (!historicalTab) return null;
  const current = await rpc.call('browser.request', {
    method: 'GET', path: '/tabs', target: 'host', query: { profile },
    tabScope: { sessionKey: session.context.sessionKey, referencedTabs: [historicalTab.tab] },
  });
  return browserTabIsCurrent(current, historicalTab.tab.targetId) ? historicalTab : null;
}

function toolReadyPayload(session: ToolSession, resources: {
  browserTab: NativeBrowserTab | null;
  profile?: string;
  environments?: Array<Record<string, unknown>>;
  desktopNodeId?: string;
}) {
  const { browserTab, profile, environments, desktopNodeId } = resources;
  return { sessionKey: session.context.sessionKey, userId: session.context.uid, canControl: session.canControl,
    ...(browserTab ? { browserTab } : {}), ...(profile ? { profile } : {}),
    ...(environments ? { environments, desktopSource: `node:${desktopNodeId}` } : {}) };
}

export function createToolSurface(options: ToolSurfaceOptions = {}) {
  const env = options.env ?? process.env;
  const resolveAccess = options.resolveAccess ?? resolveNativeAdminAccess;
  const resolveChannel = options.resolveChannel ?? resolveToolChannelForUid;
  const resolveControl = options.resolveControl ?? resolveToolControlForUid;
  const openUpstream = options.openUpstream ?? openNativeUserSocket;
  const log = options.log ?? ((message, meta) => logger.warn(message, meta));
  const tickets = createWsTicketStore<ToolSession>();
  const streamTickets = new Map<string, StreamGrant>();
  const mediaOwners = new Map<string, LiveToolSession>();
  const router: Router = Router({ mergeParams: true });
  const headers = (uid: string) => ({ ...openClawProxyIdentityHeaders({ user: uid, clientAddress: podClientAddress() }), origin: openClawProxyOrigin(env) });

  function retireGrant(grant: StreamGrant): void {
    if (!grant.active) return;
    if (grant.kind === 'rfb') {
      const observation = grant.live.observations.get(grant.publicPath);
      if (observation) observation.expiresAt = Date.now() + 30000;
    }
    grant.active = false;
    clearTimeout(grant.timer);
    streamTickets.delete(grant.ticket);
    grant.live.grants.delete(grant.publicPath);
    if (grant.audio) retireGrant(grant.audio);
  }

  router.post('/ticket', authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(60), async (req, res) => {
    try {
      const gatewayId = (req.params as { gatewayId?: string }).gatewayId;
      if (!terminalAvailable(env) || typeof gatewayId !== 'string' || gatewayId !== env.GATEWAY_ID) { res.status(404).json({ error: 'tool_unavailable' }); return; }
      const claim = ticketClaim(req);
      if (!claim) { res.status(400).json({ error: 'invalid_conversation' }); return; }
      const { channelId, surface } = claim;
      const authorization = req.headers.authorization;
      const access = await resolveAccess({ gatewayId, authorization, env });
      if (access.kind !== 'allowed') { res.status(accessDeniedStatus(access.kind)).json({ error: 'tool_unavailable' }); return; }
      const resolve = () => surface === 'browser' ? resolveChannel({ uid: req.uid!, gatewayId, channelId, env }) : resolveControl({ uid: req.uid!, gatewayId, channelId, env });
      const context = await resolve();
      if (context.workspaceSlug !== access.workspaceSlug) { res.status(403).json({ error: 'forbidden' }); return; }
      const ticket = tickets.issue({ context, surface, canControl: access.canControl, reauthorize: async () => {
        const current = await resolveAccess({ gatewayId, authorization, env });
        if (current.kind !== 'allowed' || current.workspaceSlug !== context.workspaceSlug || current.canControl !== access.canControl) return false;
        try {
          const next = await resolve();
          return next.workspaceSlug === context.workspaceSlug && ('sessionKey' in next ? 'sessionKey' in context && next.sessionKey === context.sessionKey : !('sessionKey' in context));
        } catch (error) {
          if (error instanceof WorkspaceNativeAccessError && error.status < 500) return false;
          throw error;
        }
      } });
      res.set('cache-control', 'no-store').json({ ticket: ticket.ticket, expiresAt: new Date(ticket.expiresAt).toISOString() });
    } catch (error) {
      log('Tool ticket failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(error instanceof WorkspaceNativeAccessError ? error.status : 503).json({ error: 'tool_unavailable' });
    }
  });

  router.get('/__openclaw__/assistant-media', authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(360), async (req, res) => {
    const owned = requestedMedia(req, mediaOwners);
    if (!owned) { res.status(404).json({ error: 'media_unavailable' }); return; }
    const { live, media } = owned;
    try {
      if (await authorizeSession(live, 5000) !== 'allowed') { res.status(403).json({ error: 'forbidden' }); return; }
      const url = new URL(`/g/${encodeURIComponent(live.context.gatewayId)}/openclaw/__openclaw__/assistant-media`, openClawControlUpstreamBase(env)); url.searchParams.set('source', media.source);
      const response = await (options.fetchImpl ?? fetch)(url, { headers: headers(live.context.uid), redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok || !response.body) { await response.body?.cancel(); res.status(502).json({ error: 'media_unavailable' }); return; }
      const body = await readMedia(response.body, live);
      res.set('cache-control', 'no-store').set('content-type', response.headers.get('content-type') ?? 'application/octet-stream').set('x-content-type-options', 'nosniff').send(body);
    } catch (error) { log('Browser media failed', { error: error instanceof Error ? error.message : String(error) }); res.status(502).json({ error: 'media_unavailable' }); }
  });

  function registerMedia(live: LiveToolSession, source: unknown): string {
    if (!live.active || typeof source !== 'string' || !source || source.length > 4096 || containsAsciiControlCharacter(source)) throw new Error('Invalid Browser media path');
    if (live.media.size >= 64) { const oldest = live.media.keys().next().value!; live.media.delete(oldest); mediaOwners.delete(oldest); }
    const ref = randomUUID(); live.media.set(ref, { source, expiresAt: Date.now() + 120000 }); mediaOwners.set(ref, live); return ref;
  }

  async function bridge(browser: WebSocket, session: ToolSession) {
    const live: LiveToolSession = { ...session, active: true, streams: new Set(), media: new Map(), grants: new Map(), observations: new Map() };
    let upstream: WebSocket | undefined;
    let stopAuthorization = () => {};
    const close = (code = 1000, reason = 'Tool disconnected') => {
      if (!live.active) return;
      live.active = false;
      stopAuthorization();
      for (const ref of live.media.keys()) mediaOwners.delete(ref);
      live.media.clear();
      for (const grant of live.grants.values()) retireGrant(grant);
      live.grants.clear();
      live.observations.clear();
      for (const stream of live.streams) stream.close(1000, reason);
      browser.close(code, reason); upstream?.close(1000, reason);
    };
    browser.on('close', () => close()); browser.on('error', () => close(1011, 'Tool socket failed'));
    try {
      const native = await openUpstream(session.context.uid, session.context.gatewayId, env, { caps: session.surface === 'browser' ? ['session-scoped-events'] : [], ...(session.surface === 'browser' ? { channelSessionKey: session.context.sessionKey } : {}) }); upstream = native.ws;
      if (!live.active) { upstream.close(); return; }
      if (!native.scopes.has('operator.admin')) { close(1008, 'Tool access changed'); return; }
      upstream.on('close', () => close(1011, 'Native Tool disconnected')); upstream.on('error', () => close(1011, 'Native Tool failed'));
      let onNativeEvent = (_frame: Record<string, unknown>) => {};
      const rpc = browserRpc(upstream, frame => onNativeEvent(frame));
      let profile: string | undefined;
      let environments: Array<Record<string, unknown>> | undefined;
      let desktopNodeId: string | undefined;
      const readEnvironment = async () => {
        const expectedNodeId = await readDesktopNodeIdentity(env.OCTOGEE_DESKTOP_NODE_IDENTITY_PATH);
        const nodeId = desktopNodeIdentity(await rpc.call('node.list', {}), expectedNodeId, env.OCTOGEE_DESKTOP_NODE_NAME);
        if (desktopNodeId && desktopNodeId !== nodeId) throw new Error('The shared desktop identity changed. Reconnect to continue.');
        desktopNodeId = nodeId;
        return desktopEnvironment(await rpc.call('environments.status', { environmentId: `node:${nodeId}` }), nodeId, options.egressReport?.() ?? null);
      };
      if (session.surface === 'browser') {
        profile = await nativeBrowserProfile(rpc);
      } else if (session.surface === 'computer') environments = [await readEnvironment()];
      if (!live.active) { rpc.close(); return; }
      const mintStream = (path: string, kind: StreamGrant['kind']): { wsPath: string; grant: StreamGrant } => {
        if (!live.active || live.grants.size >= 64) throw new Error('Too many tool streams');
        const ticket = randomUUID();
        const wsPath = `/g/${encodeURIComponent(session.context.gatewayId)}${STREAM_PREFIX}${ticket}`;
        const grant: StreamGrant = { live, path, kind, active: true, ticket, publicPath: wsPath };
        grant.timer = setTimeout(() => retireGrant(grant), 30000); grant.timer.unref();
        streamTickets.set(ticket, grant);
        live.grants.set(wsPath, grant);
        return { wsPath, grant };
      };
      stopAuthorization = monitorSessionAuthorization(live, { intervalMs: options.authorizationIntervalMs ?? 10000, timeoutMs: 5000, onEnded: result => close(result === 'revoked' ? 1008 : 1011, 'Tool authorization ended') });
      const send = (frame: unknown) => {
        if (!live.active) return;
        if (browser.bufferedAmount > MAX_BUFFER) { close(1013, 'Tool backpressure'); return; }
        browser.send(JSON.stringify(frame));
      };
      let browserTab: NativeBrowserTab | null = null;
      const browserReferences = new Map<string, NativeBrowserTab['tab']>();
      const rememberTab = (resource: NativeBrowserTab) => {
        browserReferences.delete(resource.tab.targetId);
        browserReferences.set(resource.tab.targetId, resource.tab);
        if (browserReferences.size > 64) browserReferences.delete(browserReferences.keys().next().value!);
      };
      onNativeEvent = frame => {
        if (session.surface === 'themes' && ['plugins.changed', 'users.prefs.changed'].includes(String(frame.event))) {
          send({ type: 'event', event: frame.event, payload: frame.payload });
        } else if (profile && session.context.sessionKey && session.context.agentId) {
          const resource = nativeBrowserResource(frame, { sessionKey: session.context.sessionKey, agentId: session.context.agentId }, profile);
          if (resource) { rememberTab(resource); browserTab = resource; send({ type: 'event', event: 'tools.browser-tab', payload: resource }); }
        }
      };
      if (profile) {
        const historicalTab = await subscribeBrowserResources(rpc, session, profile, rememberTab);
        browserTab ??= historicalTab;
      }
      serveToolRequests(browser, { live, rpc, profile, browserReferences, desktopNodeId: () => desktopNodeId, readEnvironment, mintStream, registerMedia, retireGrant }, send, close);
      send({ type: 'event', event: 'tools.ready', payload: toolReadyPayload(session, { browserTab, profile, environments, desktopNodeId }) });
    } catch (error) { log('Tool upstream failed', { error: error instanceof Error ? error.message : String(error) }); close(1011, 'Tool unavailable'); }
  }

  function attachWs(upgradeRouter: WsUpgradeRouter, isAllowedOrigin: (origin: string | undefined) => boolean) {
    const redeemed = new WeakMap<IncomingMessage, ToolSession>();
    upgradeRouter.add({ match: path => path.startsWith(RPC_PREFIX), extractTicket: path => wsTicketFromPath(path, RPC_PREFIX), allowedOrigins: isAllowedOrigin, maxPayloadBytes: 256 * 1024,
      authorize: async req => {
        const ticket = wsTicketFromPath((req.url ?? '').split('?')[0], RPC_PREFIX); const session = ticket ? tickets.redeem(ticket) : null;
        if (!session || await authorizeSession(session, 5000) !== 'allowed') throw new WsUpgradeAuthorizationError(401, 'TOOL_ACCESS_DENIED');
        redeemed.set(req, session); return true;
      },
      onUpgrade: ({ req, ws }) => { const session = redeemed.get(req); redeemed.delete(req); if (!session) { ws.close(1008, 'Tool session missing'); return; } void bridge(ws, session); },
    });
    const streams = new WeakMap<IncomingMessage, StreamGrant>();
    upgradeRouter.add({ match: path => path.startsWith(STREAM_PREFIX), extractTicket: path => wsTicketFromPath(path, STREAM_PREFIX), allowedOrigins: isAllowedOrigin, maxPayloadBytes: 1024 * 1024,
      authorize: async req => {
        const ticket = wsTicketFromPath((req.url ?? '').split('?')[0], STREAM_PREFIX); const stream = ticket ? streamTickets.get(ticket) : null;
        if (ticket) streamTickets.delete(ticket);
        if (!stream?.active || !stream.live.active || stream.live.streams.size >= 8 || await authorizeSession(stream.live, 5000) !== 'allowed') throw new WsUpgradeAuthorizationError(401, 'TOOL_STREAM_DENIED');
        clearTimeout(stream.timer);
        streams.set(req, stream); return true;
      },
      onUpgrade: ({ req, ws }) => {
        const stream = streams.get(req); streams.delete(req); if (!stream?.active || !stream.live.active || stream.live.streams.size >= 8) { ws.close(1008, 'Tool stream ended'); return; }
        const url = new URL(stream.path, openClawControlUpstreamBase(env)); url.protocol = 'ws:';
        const native = new WebSocket(url, { headers: headers(stream.live.context.uid), maxPayload: MAX_BUFFER, handshakeTimeout: 5000 });
        stream.live.streams.add(ws); stream.live.streams.add(native);
        const queued: Array<{ data: Buffer; binary: boolean }> = []; let queuedBytes = 0;
        const close = () => { retireGrant(stream); stream.live.streams.delete(ws); stream.live.streams.delete(native); ws.close(); native.close(); };
        native.on('open', () => {
          for (const frame of queued) native.send(frame.data, { binary: frame.binary });
          queued.length = 0;
          queuedBytes = 0;
        });
        native.on('message', (data, binary) => { if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFER) { close(); return; } ws.send(data, { binary }); });
        ws.on('message', (data, binary) => {
          const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          let permitted = stream.kind === 'rfb' && binary;
          if (stream.kind === 'audio' && !binary) {
            try { const command = JSON.parse(bytes.toString()); permitted = command && Object.keys(command).join(',') === 'action' && ['start', 'stop'].includes(command.action); } catch { permitted = false; }
          }
          if (!permitted || native.bufferedAmount > MAX_BUFFER) { ws.close(1008, 'Tool stream input is unavailable'); native.close(); return; }
          if (native.readyState === WebSocket.OPEN) native.send(bytes, { binary });
          else if (native.readyState === WebSocket.CONNECTING && queuedBytes + bytes.length <= 1024 * 1024) { queued.push({ data: bytes, binary }); queuedBytes += bytes.length; }
          else close();
        });
        ws.on('close', close); native.on('close', close); ws.on('error', close); native.on('error', error => { log('Tool stream failed', { error: error.message }); close(); });
      },
    });
  }
  return { router, attachWs };
}
