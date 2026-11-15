import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import {
  WsUpgradeAuthorizationError,
  type WsUpgradeRouter,
  type WsUpgradeContext,
} from '@octogee/core/ws/upgrade-router';
import type { NativeMobileBinding } from '@octogee/shared/types/native-mobile';
import { logger } from '@octogee/core/http/logging';
import { fetchGatewayToken } from '../chat-proxy/openclaw/gateway-token.js';
import { createOpenClawControlAuthorizationCache } from './broker.js';
import { bridgeControlSocket, openClawControlUpstreamBase } from './surface.js';
import { OpenClawControlSessionManager } from './session.js';
import { OpenClawControlResourceLimiter, type OpenClawControlLease } from './limits.js';
import { DesktopObserverTickets, bridgeDesktopObserver } from './desktop-stream.js';
import { mobileRoute } from './mobile-proof.js';
import { MobileGatewayAuthority, mobileSession } from './mobile-authority.js';
import { MobileSocketTransport } from './mobile-transport.js';
import { createMattermostControlChat } from './mattermost-chat.js';

class MobileCandidates {
  private readonly enrollments = new Map<string, number>();
  private readonly ips = new Map<string, number>();

  acquire(req: IncomingMessage, id: string): () => void {
    const ip = req.socket.remoteAddress ?? 'unknown';
    if ((this.ips.get(ip) ?? 0) >= 12 || (this.enrollments.get(id) ?? 0) >= 6)
      throw new WsUpgradeAuthorizationError(401, 'MOBILE_LIMITED');
    this.enrollments.set(id, (this.enrollments.get(id) ?? 0) + 1);
    this.ips.set(ip, (this.ips.get(ip) ?? 0) + 1);
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      req.socket.off('close', release);
      this.decrement(this.enrollments, id);
      this.decrement(this.ips, ip);
    };
    req.socket.once('close', release);
    return release;
  }

  private decrement(counts: Map<string, number>, key: string): void {
    const count = (counts.get(key) ?? 1) - 1;
    if (count) counts.set(key, count);
    else counts.delete(key);
  }
}

function attachDesktop(
  ws: WebSocket,
  binding: NativeMobileBinding,
  url: URL,
  shared: { authority: MobileGatewayAuthority; tickets: DesktopObserverTickets },
  lease: OpenClawControlLease,
): void {
  const { authority, tickets } = shared;
  const upstreamPath = tickets.redeem(url.searchParams.get('token') ?? '', mobileSession(binding));
  if (!upstreamPath) {
    lease.release();
    ws.close(1008, 'invalid-mobile-auxiliary');
    return;
  }
  const upstreamUrl = new URL(upstreamPath, openClawControlUpstreamBase(authority.env));
  upstreamUrl.protocol = 'ws:';
  bridgeDesktopObserver({
    browser: ws,
    upstreamUrl,
    release: () => lease.release(),
    touch: () => true,
    authorize: async () => {
      await authority.checkNative(await authority.broker('authorize', binding.id), 'operator');
      return true;
    },
    authorizationIntervalMs: authority.options.authorizationIntervalMs ?? 10_000,
    log: (message) => logger.warn(message),
  });
}

function attachOperator(
  context: WsUpgradeContext,
  binding: NativeMobileBinding,
  shared: {
    authority: MobileGatewayAuthority;
    tickets: DesktopObserverTickets;
    limiter: OpenClawControlResourceLimiter;
  },
  lease: OpenClawControlLease,
): void {
  const { authority, tickets, limiter } = shared;
  const { ws, req } = context;
  const { identity, options } = authority;
  const transport = new MobileSocketTransport(binding, ws, authority, tickets);
  void bridgeControlSocket({
    browser: ws,
    request: req,
    requestPath: '/',
    session: mobileSession(binding),
    sessions: new OpenClawControlSessionManager(),
    env: authority.env,
    mobile: transport,
    authorizationCache: createOpenClawControlAuthorizationCache(),
    loadGatewayToken: fetchGatewayToken,
    proxyIdentity: identity,
    limiter,
    socketLease: lease,
    desktopTickets: tickets,
    mattermostChat:
      options.mattermostChat ??
      createMattermostControlChat({
        perUserIdentity: identity.enabled,
        allowAttachments: true,
        resolveChatProfile: (session, source) => identity.resolveChatProfile(session, source),
      }),
    workspaceServing: options.workspaceServing ?? (() => 'serving'),
    authorizationIntervalMs: options.authorizationIntervalMs ?? 10_000,
    retainMutationLeaseUntilProcessReplacement: (_lease, reason) => {
      logger.error('Mobile config mutation outcome unknown; restarting sidecar', { reason });
      process.kill(process.pid, 'SIGTERM');
    },
  }).catch((error) => {
    logger.warn('Mobile gateway transport failed', {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    lease.release();
    ws.close(1011, 'mobile-unavailable');
  });
}

export function attachMobileWs(
  upgrades: WsUpgradeRouter,
  authority: MobileGatewayAuthority,
  limiter: OpenClawControlResourceLimiter,
): void {
  const candidates = new MobileCandidates();
  const authorizations = new WeakMap<
    IncomingMessage,
    { binding: NativeMobileBinding; release: () => void }
  >();
  const tickets = new DesktopObserverTickets();
  const routeFor = (url: string) =>
    mobileRoute(
      url.startsWith('/openclaw/mobile/') ? `/g/${authority.gatewayId}${url}` : url,
      authority.gatewayId,
    );
  upgrades.add({
    match: (pathname) => routeFor(pathname) !== null,
    allowedOrigins: 'check-in-handler',
    maxPayloadBytes: 25 * 1024 * 1024,
    authorize: async (req) => {
      const route = routeFor(req.url ?? '');
      if (!authority.enabled() || !route || (req.headers.origin && req.headers.origin !== authority.origin()))
        throw new WsUpgradeAuthorizationError(401, 'MOBILE_FORBIDDEN');
      const release = candidates.acquire(req, route.enrollmentId);
      try {
        authorizations.set(req, { binding: await authority.broker('inspect', route.enrollmentId), release });
      } catch {
        release();
        throw new WsUpgradeAuthorizationError(401, 'MOBILE_UNAUTHORIZED');
      }
      return true;
    },
    onUpgrade: (context) => {
      const { ws, req } = context;
      const route = routeFor(req.url ?? '');
      const authorization = authorizations.get(req);
      ws.once('close', () => authorization?.release());
      if (!route || !authorization) {
        ws.close(1008, 'mobile-unauthorized');
        return;
      }
      const { binding } = authorization;
      authority.register(binding.id, ws);
      const lease = limiter.acquireSocket(mobileSession(binding));
      if (!lease) {
        ws.close(1008, 'mobile-limited');
        return;
      }
      const url = new URL(route.upstreamPath, 'http://localhost');
      if (url.pathname === '/desktop/observe') {
        attachDesktop(ws, binding, url, { authority, tickets }, lease);
        return;
      }
      if (url.pathname !== '/' || url.search) {
        lease.release();
        ws.close(1008, 'invalid-mobile-path');
        return;
      }
      attachOperator(context, binding, { authority, tickets, limiter }, lease);
    },
  });
}
