import { authenticationFailureLimit, authenticatedRequestLimit } from "@octogee/core/http/authenticated-request-limit";
import http from 'node:http';
import { Router, type Request, type Response } from 'express';
import type { NativeMobileBinding } from '@octogee/shared/types/native-mobile';
import { requireAuth } from '@octogee/core/http/auth';
import { logger } from '@octogee/core/http/logging';
import {
  isOpenClawControlHttpResource,
  openClawControlUpstreamBase,
  openClawControlUpstreamPath,
} from './surface.js';
import { OpenClawControlResourceLimiter } from './limits.js';
import { MobileGatewayAuthority, mobileSession } from './mobile-authority.js';
import {
  mobileDigest,
  mobileRecord,
  mobileRoute,
  isMobileMediaResource,
  projectMobileDocument,
} from '@octogee/core/identity/mobile-proof';

export function createMobileHttpRouter(
  authority: MobileGatewayAuthority,
  limiter: OpenClawControlResourceLimiter,
): Router {
  const gatewayId = authority.gatewayId;
  const router = Router({ mergeParams: true });
  router.post('/:id/setup', authenticationFailureLimit, authority.options.auth ?? requireAuth, authenticatedRequestLimit(30), async (req, res, next) => {
    try {
      const route = mobileRoute(req.originalUrl.replace(/\/setup$/u, ''), gatewayId);
      if (!authority.enabled() || !route) {
        res.status(404).json({ error: 'mobile-unavailable' });
        return;
      }
      const binding = await authority.broker('inspect', route.enrollmentId);
      if (req.uid !== binding.uid || binding.state !== 'pending' || binding.bootstrapHash) {
        res.status(403).json({ error: 'mobile-setup-forbidden' });
        return;
      }
      await authority.identity.syncProfile(mobileSession(binding));
      const native = mobileRecord(
        await authority.rpc('device.pair.setupCode', {
          publicUrl: `${authority.origin().replace(/^https:/u, 'wss:')}${authority.basePath(binding.id)}`,
          includeQr: true,
        }),
      );
      const { payload, result } = nativeSetup(
        native,
        `${authority.origin().replace(/^https:/u, 'wss:')}${authority.basePath(binding.id)}`,
      );
      const issued = await authority.broker('issued', binding.id, {
        bootstrapHash: mobileDigest(payload.bootstrapToken as string),
        setupExpiresAt: result.expiresAtMs,
      });
      res.set('cache-control', 'no-store').json({
        id: binding.id,
        gatewayId,
        setupCode: result.setupCode,
        qrDataUrl: result.qrDataUrl,
        expiresAt: issued.setupExpiresAt,
      });
    } catch (error) {
      next(error);
    }
  });

  router.use(async (req, res, next) => {
    try {
      const route = mobileRoute(req.originalUrl, gatewayId);
      if (!authority.enabled() || !route || !['GET', 'HEAD', 'POST', 'PUT'].includes(req.method)) {
        res.status(404).end();
        return;
      }
      const { parsed, navigation, publicAsset, allowed, upstreamPath } = httpResource(
        route.upstreamPath,
        authority,
      );
      if (!allowed) {
        res.status(404).end();
        return;
      }
      const grant = await httpAccess(req, res, { id: route.enrollmentId, parsed, publicAsset }, authority);
      if (!grant) return;
      const { binding, token, readCookies } = grant;
      const headers = httpHeaders(req, binding, token, readCookies, authority);
      const upstreamOrigin = openClawControlUpstreamBase(authority.env);
      const lease = limiter.acquireRequest({ uid: binding.uid, gatewayId, sessionId: binding.id });
      if (!lease) {
        res.status(429).end();
        return;
      }
      const upstream = http.request(
        upstreamOrigin,
        { path: upstreamPath, method: req.method, headers },
        (response) => {
          relayResponse(response, res, { parsed, navigation, binding, method: req.method }, authority);
        },
      );
      const authorizationTimer = !publicAsset
        ? setInterval(() => {
            void authority
              .broker(
                token ? 'http' : 'authorize',
                binding.id,
                token ? { tokenHash: mobileDigest(token) } : {},
              )
              .then((current) => {
                if (current.state !== 'active') throw new Error('Mobile enrollment inactive');
                return authority.checkNative(current, 'operator');
              })
              .catch(() => {
                upstream.destroy();
                res.destroy();
              });
          }, authority.options.authorizationIntervalMs ?? 10_000)
        : undefined;
      authorizationTimer?.unref();
      const release = () => {
        res.off('close', release);
        res.off('finish', release);
        if (authorizationTimer) clearInterval(authorizationTimer);
        lease.release();
      };
      res.once('close', release);
      res.once('finish', release);
      upstream.setTimeout(30_000, () => upstream.destroy(new Error('Mobile HTTP timeout')));
      upstream.on('error', () => {
        logger.warn('Mobile HTTP upstream failed');
        if (!res.headersSent) res.status(502).end();
        else res.destroy();
      });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      if (req.body !== undefined && !['GET', 'HEAD'].includes(req.method)) {
        const body = JSON.stringify(req.body);
        upstream.setHeader('content-length', Buffer.byteLength(body));
        upstream.end(body);
      } else req.pipe(upstream);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function httpResource(path: string, authority: MobileGatewayAuthority) {
  const gatewayId = authority.gatewayId;
  const parsed = new URL(path, 'http://localhost');
  if (!validHttpQuery(path, parsed, gatewayId))
    return { parsed, navigation: false, publicAsset: false, allowed: false, upstreamPath: path };
  const controlResource = isOpenClawControlHttpResource(`/openclaw${parsed.pathname}`, gatewayId);
  const navigation =
    (controlResource || parsed.pathname === '/settings') &&
    !/^\/(?:__openclaw__|api|avatar)(?:\/|$)/u.test(parsed.pathname);
  const publicAsset =
    navigation ||
    parsed.pathname === '/' ||
    parsed.pathname === '/control-ui-config.json' ||
    /^\/(?:assets|fonts|themes|provider-icons)\/[A-Za-z0-9@+._/-]+$/u.test(parsed.pathname);
  const allowed =
    navigation ||
    controlResource ||
    isMobileMediaResource(parsed) ||
    /^\/(?:api\/artifacts\/download|plugins|__openclaw__\/(?:browser|computer|board))\//u.test(
      parsed.pathname,
    );
  return {
    parsed,
    navigation,
    publicAsset,
    allowed,
    upstreamPath: resourceUpstreamPath({ parsed, publicAsset, controlResource }, authority),
  };
}

function resourceUpstreamPath(
  resource: { parsed: URL; publicAsset: boolean; controlResource: boolean },
  authority: MobileGatewayAuthority,
): string {
  const { parsed } = resource;
  const suffix = `${parsed.pathname}${parsed.search}`;
  if (
    resource.publicAsset ||
    resource.controlResource ||
    isMobileMediaResource(parsed) ||
    parsed.pathname.startsWith('/plugins/assets/')
  )
    return `${authority.controlBasePath()}${suffix}`;
  return suffix;
}

function validHttpQuery(path: string, parsed: URL, gatewayId: string): boolean {
  if (isMobileMediaResource(parsed)) return true;
  try {
    openClawControlUpstreamPath(`/openclaw${path}`, gatewayId);
    return true;
  } catch {
    return false;
  }
}

async function httpAccess(
  req: Request,
  res: Response,
  target: { id: string; parsed: URL; publicAsset: boolean },
  authority: MobileGatewayAuthority,
) {
  const { id, parsed, publicAsset } = target;
  const token = /^Bearer ([A-Za-z0-9_.~-]{1,4096})$/u.exec(req.get('authorization') ?? '')?.[1];
  const readCookies = (req.get('cookie') ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => /^__openclaw_plugin_tab_auth_[a-f0-9]+_[A-Za-z0-9_-]+=/u.test(s))
    .join('; ');
  let binding: NativeMobileBinding;
  if (token) binding = await authority.broker('http', id, { tokenHash: mobileDigest(token) });
  else if (publicAsset || nativeReadTicket(parsed, readCookies))
    binding = await authority.broker('inspect', id);
  else {
    res.status(401).end();
    return;
  }
  if (!publicAsset && binding.state !== 'active') {
    res.status(401).end();
    return;
  }
  if (!publicAsset) binding = await checkedHttpBinding(binding, token, authority);
  if (req.method !== 'GET' && req.method !== 'HEAD' && !token) {
    res.status(401).end();
    return;
  }
  return { binding, token, readCookies };
}

function httpHeaders(
  req: Request,
  binding: NativeMobileBinding,
  token: string | undefined,
  readCookies: string,
  authority: MobileGatewayAuthority,
) {
  const headers: Record<string, string> = {};
  for (const name of ['accept', 'content-type', 'content-length', 'range', 'if-none-match']) {
    const value = req.get(name);
    if (value) headers[name] = value;
  }
  if (token) {
    Object.assign(headers, authority.identity.userHeaders(mobileSession(binding), req));
    headers.authorization = `Bearer ${token}`;
    headers['x-openclaw-scopes'] = binding.httpTokens
      .find((t) => t.hash === mobileDigest(token))!
      .scopes.join(',');
  }
  if (readCookies) headers.cookie = readCookies;
  return headers;
}

async function checkedHttpBinding(
  binding: NativeMobileBinding,
  token: string | undefined,
  authority: MobileGatewayAuthority,
): Promise<NativeMobileBinding> {
  await authority.checkNative(binding, 'operator');
  return token ? authority.broker('http', binding.id, { tokenHash: mobileDigest(token) }) : binding;
}

function relayResponse(
  response: http.IncomingMessage,
  res: Response,
  target: { parsed: URL; navigation: boolean; binding: NativeMobileBinding; method: string },
  authority: MobileGatewayAuthority,
) {
  const { parsed, navigation, binding } = target;
  res.status(response.statusCode ?? 502);
  for (const name of [
    'content-type',
    'content-length',
    'content-disposition',
    'content-range',
    'accept-ranges',
    'etag',
  ]) {
    const value = response.headers[name];
    if (value !== undefined) res.setHeader(name, value);
  }
  const cookies = response.headers['set-cookie']?.filter((c) =>
    /^__openclaw_plugin_tab_auth_[a-f0-9]+_[A-Za-z0-9_-]+=/u.test(c),
  );
  if (cookies?.length)
    res.setHeader(
      'set-cookie',
      cookies.map((c) =>
        c.replace(
          /Path=([^;]*)/iu,
          (_all, p: string) => `Path=${authority.basePath(binding.id)}${p === '/' ? '/' : p}`,
        ),
      ),
    );
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  if (target.method === 'HEAD') {
    response.resume();
    res.end();
    return;
  }
  if (
    parsed.pathname === '/control-ui-config.json' ||
    (navigation && response.headers['content-type']?.includes('text/html'))
  ) {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        response.destroy();
        res.destroy();
      } else chunks.push(chunk);
    });
    response.on('end', () => {
      try {
        const content = Buffer.concat(chunks).toString();
        res.removeHeader('content-length');
        if (parsed.pathname === '/control-ui-config.json')
          res.json({ ...JSON.parse(content), basePath: authority.basePath(binding.id) });
        else
          res.send(
            projectMobileDocument(content, authority.basePath(binding.id), authority.controlBasePath()),
          );
      } catch {
        logger.warn('Mobile Control UI metadata rejected');
        res.destroy();
      }
    });
  } else response.pipe(res);
  response.on('error', () => res.destroy());
}

function nativeSetup(native: Record<string, unknown> | null, expectedUrl: string) {
  if (
    typeof native?.setupCode !== 'string' ||
    typeof native.qrDataUrl !== 'string' ||
    !native.qrDataUrl.startsWith('data:image/png;base64,') ||
    typeof native.expiresAtMs !== 'number'
  )
    throw new Error('Native pairing QR unavailable');
  const payload = mobileRecord(JSON.parse(Buffer.from(native.setupCode, 'base64url').toString()));
  if (
    payload?.url !== expectedUrl ||
    typeof payload.bootstrapToken !== 'string' ||
    payload.bootstrapToken.length < 16
  )
    throw new Error('Native pairing payload rejected');
  if (native.access !== 'full' || native.accessDowngraded === true || !validSetupLifetime(native, payload))
    throw new Error('Native pairing setup is incomplete or expired');
  return { payload, result: native };
}

function validSetupLifetime(native: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  return (
    Number.isSafeInteger(native.expiresAtMs) &&
    (native.expiresAtMs as number) > Date.now() &&
    payload.expiresAtMs === native.expiresAtMs
  );
}

function nativeReadTicket(parsed: URL, readCookies: string): boolean {
  const artifactTicket = /^\/api\/artifacts\/download\/[A-Za-z0-9_-]+$/u.test(parsed.pathname);
  const mediaTicket =
    parsed.pathname === '/__openclaw__/assistant-media' &&
    /^v1\.[A-Za-z0-9_.-]{1,4096}$/u.test(parsed.searchParams.get('mediaTicket') ?? '');
  return artifactTicket || mediaTicket || (!!readCookies && parsed.pathname.startsWith('/plugins/'));
}
