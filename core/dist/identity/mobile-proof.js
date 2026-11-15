import { createHash, createPublicKey, verify } from 'node:crypto';
import { buildDeviceAuthPayloadV3 } from '@octogee/shared/types/device-identity';
import { OPENCLAW_PROTOCOL_VERSION } from '@octogee/shared/types/openclaw-wire';
import { containsAsciiControlCharacter } from '@octogee/shared/types/text-validation';
export const MOBILE_ENROLLMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const mobileDigest = (value) => createHash('sha256').update(value).digest('hex');
export function mobileRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function text(value, max = 256) {
    return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n|]/u.test(value);
}
function requireRecord(value) {
    const result = mobileRecord(value);
    if (!result)
        throw new Error('invalid-mobile-connect');
    return result;
}
function validProtocol(p) {
    return (Number.isInteger(p.minProtocol) &&
        Number.isInteger(p.maxProtocol) &&
        p.minProtocol <= OPENCLAW_PROTOCOL_VERSION &&
        p.maxProtocol >= OPENCLAW_PROTOCOL_VERSION);
}
function validScopes(value) {
    return (Array.isArray(value) &&
        value.length <= 32 &&
        value.every((s) => text(s, 80)) &&
        new Set(value).size === value.length);
}
function nativePhone(c) {
    return ((c.id === 'openclaw-ios' &&
        /^(?:ios|ipados)(?:\s|$)/iu.test(c.platform) &&
        /^(?:iphone|ipad|ios)$/iu.test(c.deviceFamily)) ||
        (c.id === 'openclaw-android' &&
            /^android(?:\s|$)/iu.test(c.platform) &&
            /^android$/iu.test(c.deviceFamily)));
}
function validClient(c, role, scopes) {
    if (![c.id, c.mode, c.platform, c.deviceFamily].every((v) => text(v)))
        return false;
    if (!nativePhone(c) && !(role === 'operator' && c.id === 'openclaw-control-ui'))
        return false;
    if (role === 'node')
        return c.mode === 'node' && scopes.length === 0;
    return role === 'operator' && c.mode === 'ui';
}
function validDevice(d, nonce, now) {
    return [
        typeof d.id === 'string' && /^[0-9a-f]{64}$/u.test(d.id),
        typeof d.publicKey === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(d.publicKey),
        typeof d.signature === 'string' && /^[A-Za-z0-9_-]{86}$/u.test(d.signature),
        d.nonce === nonce,
        Number.isSafeInteger(d.signedAt),
        Math.abs(now - d.signedAt) <= 120_000,
    ].every(Boolean);
}
export function verifyMobileConnect(frame, nonce, now = Date.now()) {
    const f = requireRecord(frame), p = requireRecord(f.params), c = requireRecord(p.client), d = requireRecord(p.device), auth = mobileRecord(p.auth);
    if (f.type !== 'req' ||
        f.method !== 'connect' ||
        !text(f.id) ||
        !nonce ||
        !validProtocol(p) ||
        !validScopes(p.scopes))
        throw new Error('invalid-mobile-connect');
    if (!validClient(c, String(p.role), p.scopes) || !validDevice(d, nonce, now))
        throw new Error('invalid-mobile-client');
    const role = p.role;
    const { signatureToken, ...credentials } = connectCredentials(auth);
    verifyProof(d, c, { role, scopes: p.scopes, token: signatureToken, nonce });
    return {
        deviceId: d.id,
        publicKey: d.publicKey,
        role,
        scopes: p.scopes,
        ...credentials,
    };
}
export function mobileRoute(url, gatewayId) {
    const raw = url.startsWith('/api/g/') ? url.slice(4) : url;
    const prefix = `/g/${gatewayId}/openclaw/mobile/`;
    if (!raw.startsWith(prefix) || raw.length > 16384)
        return null;
    const rest = raw.slice(prefix.length);
    const separator = rest.search(/[/?]/u);
    const enrollmentId = separator < 0 ? rest : rest.slice(0, separator);
    if (!MOBILE_ENROLLMENT_ID.test(enrollmentId))
        return null;
    const suffix = separator < 0 ? '' : rest.slice(separator);
    const pathname = suffix.split('?')[0];
    if (pathname.startsWith('//') || containsAsciiControlCharacter(pathname))
        return null;
    if (/%2f|%5c|%2e|\\|(?:^|\/)\.\.?(\/|$)/iu.test(pathname))
        return null;
    return { enrollmentId, upstreamPath: !suffix || suffix.startsWith('?') ? `/${suffix}` : suffix };
}
export function isMobileMediaResource(url) {
    const keys = new Set([
        'source',
        'meta',
        'allow',
        'sessionKey',
        'messageId',
        'agentId',
        'mediaTicket',
        'filename',
        'variant',
        'width',
        'playback',
    ]);
    if (url.pathname !== '/__openclaw__/assistant-media' ||
        !url.searchParams.get('source') ||
        url.searchParams.get('source').length > 8192)
        return false;
    return [...url.searchParams.keys()].every((key) => keys.has(key) && url.searchParams.getAll(key).length === 1);
}
export function projectMobileHello(frame, origin, basePath) {
    const payload = mobileRecord(frame.payload);
    if (payload?.type !== 'hello-ok')
        return frame;
    return {
        ...frame,
        payload: { ...payload, controlUiBasePath: basePath, controlUiUrl: `${origin}${basePath}` },
    };
}
export function projectMobileDocument(html, basePath, upstreamBasePath = '') {
    const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return projectMobileDocumentResources(html, basePath, upstreamBasePath)
        .replace(/\sdata-openclaw-control-ui-base-path="[^"]*"/gu, ` data-openclaw-control-ui-base-path="${basePath}"`)
        .replace(/data-openclaw-bootstrap-config="([^"]*)"/gu, (_all, raw) => {
        const decoded = raw
            .replaceAll('&quot;', '"')
            .replaceAll('&#39;', "'")
            .replaceAll('&lt;', '<')
            .replaceAll('&gt;', '>')
            .replaceAll('&amp;', '&');
        const config = mobileRecord(JSON.parse(decoded));
        if (!config)
            throw new Error('Invalid native document bootstrap');
        return `data-openclaw-bootstrap-config="${escape(JSON.stringify({ ...config, basePath }))}"`;
    })
        .replace(/<base\s[^>]*>/giu, '')
        .replace(/<head([^>]*)>/iu, `<head$1><base href="${basePath}/">`)
        .replace(/\b(src|href)="\/(assets|fonts|themes|provider-icons|favicon)([^"]*)"/gu, `$1="${basePath}/$2$3"`);
}
function projectMobileDocumentResources(html, basePath, upstreamBasePath) {
    if (!upstreamBasePath)
        return html;
    return html.replace(/\b(src|href)="([^"]*)"/gu, (attribute, name, value) => {
        if (value === upstreamBasePath || value.startsWith(`${upstreamBasePath}/`))
            return `${name}="${basePath}${value.slice(upstreamBasePath.length)}"`;
        return attribute;
    });
}
export function mobileDefaultAgent(sessionKey, deviceId, workspaceSlug) {
    if (sessionKey === 'main')
        return `octogee-${workspaceSlug}-coach`;
    const parts = sessionKey.split(':');
    if (parts.length !== 3 || parts[0] !== 'agent')
        return null;
    if (parts[2] !== 'main' && parts[2] !== `node-${deviceId.slice(0, 12)}`)
        return null;
    return parts[1] === 'main' ? `octogee-${workspaceSlug}-coach` : parts[1];
}
export function projectMobileSessionFrame(frame, aliases) {
    const payload = mobileRecord(frame.payload);
    if (!payload || aliases.size === 0)
        return frame;
    const project = (value) => {
        const result = { ...value };
        for (const field of ['key', 'sessionKey']) {
            if (typeof value[field] === 'string')
                result[field] = aliases.get(value[field]) ?? value[field];
        }
        return result;
    };
    const result = project(payload);
    for (const field of ['session', 'sessionInfo']) {
        const info = mobileRecord(payload[field]);
        if (info)
            result[field] = project(info);
    }
    if (Array.isArray(payload.sessions))
        result.sessions = payload.sessions.map((entry) => {
            const session = mobileRecord(entry);
            return session ? project(session) : entry;
        });
    return { ...frame, payload: result };
}
function verifyProof(d, c, fields) {
    const { role, scopes, token, nonce } = fields;
    const raw = Buffer.from(d.publicKey, 'base64url');
    if (raw.length !== 32 || raw.toString('base64url') !== d.publicKey || mobileDigest(raw) !== d.id)
        throw new Error('invalid-mobile-key');
    const payload = buildDeviceAuthPayloadV3({
        deviceId: d.id,
        clientId: c.id,
        clientMode: c.mode,
        role,
        scopes: scopes,
        signedAtMs: d.signedAt,
        token,
        nonce,
        platform: c.platform,
        deviceFamily: c.deviceFamily,
    });
    const key = createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
        format: 'der',
        type: 'spki',
    });
    const compatibilityPayload = [
        'v2',
        d.id,
        c.id,
        c.mode,
        role,
        scopes.join(','),
        String(d.signedAt),
        token ?? '',
        nonce,
    ].join('|');
    const signature = Buffer.from(d.signature, 'base64url');
    if (!verify(null, Buffer.from(payload), key, signature) &&
        !verify(null, Buffer.from(compatibilityPayload), key, signature))
        throw new Error('invalid-mobile-signature');
}
function connectCredentials(auth) {
    const credentials = {
        signatureToken: null,
    };
    if (!auth)
        return credentials;
    for (const field of ['token', 'deviceToken', 'bootstrapToken']) {
        const value = auth[field];
        if (value !== undefined && !text(value, 4096))
            throw new Error('invalid-mobile-credential');
    }
    credentials.signatureToken = (auth.token ?? auth.deviceToken ?? auth.bootstrapToken ?? null);
    if (typeof auth.bootstrapToken === 'string')
        credentials.bootstrapToken = auth.bootstrapToken;
    const token = auth.deviceToken ?? auth.token;
    if (typeof token === 'string')
        credentials.token = token;
    return credentials;
}
