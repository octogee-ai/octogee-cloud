// Server-side link unfurl for Codex-style cards (title + favicon). The browser
// can't fetch a page's metadata cross-origin, so the app asks the API. Fetching
// arbitrary user-supplied URLs server-side is a textbook SSRF sink, so the
// guard here is load-bearing: scheme allowlist, byte-accurate IP classification
// (incl. IPv4-mapped/NAT64/6to4 IPv6), DNS resolution with a public-IP check on
// EVERY resolved address, **connection pinned to the validated IP** (so the
// fetch can't re-resolve to a private address — closes the rebinding TOCTOU),
// per-hop redirect re-validation, a hard timeout, and a streaming size cap.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';

export interface LinkPreview {
  url: string;
  domain: string;
  title: string | null;
  favicon: string | null;
  image: string | null;
}

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 4000;
const MAX_BYTES = 512 * 1024; // 512KB of HTML is plenty for <head> metadata.
const ICON_TIMEOUT_MS = 3000;
const ICON_MAX_BYTES = 32 * 1024;

// Types a browser renders in an <img>. SVG is safe here: an SVG loaded as an
// image never runs script.
const ICON_TYPES = new Set([
  'image/png',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/ico',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
]);

export class UnsafeUrlError extends Error {
  constructor(reason: string) {
    super(`unsafe url: ${reason}`);
    this.name = 'UnsafeUrlError';
  }
}

// --- IP classification (byte-accurate) ---

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

interface V4Range {
  base: number;
  mask: number;
}

// CIDR from octet numbers (not an IP-string literal) — the range is pre-masked.
function cidr(a: number, b: number, c: number, d: number, prefix: number): V4Range {
  const ip = (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (ip & mask) >>> 0, mask };
}

function inV4Range(ipInt: number, range: V4Range): boolean {
  return ((ipInt & range.mask) >>> 0) === range.base;
}

// Private, loopback, link-local (incl. the cloud-metadata address), CGNAT,
// broadcast, and reserved IPv4 ranges.
const BLOCKED_V4: readonly V4Range[] = [
  cidr(0, 0, 0, 0, 8),
  cidr(10, 0, 0, 0, 8),
  cidr(100, 64, 0, 0, 10),
  cidr(127, 0, 0, 0, 8),
  cidr(169, 254, 0, 0, 16),
  cidr(172, 16, 0, 0, 12),
  cidr(192, 0, 0, 0, 24),
  cidr(192, 168, 0, 0, 16),
  cidr(198, 18, 0, 0, 15),
  cidr(224, 0, 0, 0, 4),
  cidr(240, 0, 0, 0, 4),
  cidr(255, 255, 255, 255, 32),
];

// Parse IPv6 (with `::` expansion and trailing dotted-v4) to 16 bytes, else null.
function ipv6ToBytes(input: string): Uint8Array | null {
  let s = input.toLowerCase().split('%')[0];
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  // Convert a trailing dotted v4 (e.g. ::ffff:127.0.0.1) to two hextets.
  const m = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) {
    const v4 = ipv4ToInt(m[2]);
    if (v4 === null) return null;
    s = `${m[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const groupsOf = (g: string) => (g === '' ? [] : g.split(':'));
  const head = groupsOf(dbl[0]);
  const tail = dbl.length === 2 ? groupsOf(dbl[1]) : [];
  let groups: string[];
  if (dbl.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const val = parseInt(groups[i], 16);
    bytes[i * 2] = (val >> 8) & 0xff;
    bytes[i * 2 + 1] = val & 0xff;
  }
  return bytes;
}

function embeddedV4(b: Uint8Array, offset: number): string {
  return `${b[offset]}.${b[offset + 1]}.${b[offset + 2]}.${b[offset + 3]}`;
}

function allZero(b: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (b[i] !== 0) return false;
  return true;
}

// IPv4-mapped ::ffff:0:0/96 — byte parse catches hex AND dotted forms.
function isV4Mapped(b: Uint8Array): boolean {
  return allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff;
}
// IPv4-compatible ::/96 (deprecated), excluding :: and ::1.
function isV4Compatible(b: Uint8Array): boolean {
  return allZero(b, 0, 12) && !(b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] <= 1);
}
// NAT64 64:ff9b::/96.
function isNat64(b: Uint8Array): boolean {
  return b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(b, 4, 12);
}

// If the address embeds an IPv4 (mapped / compatible / NAT64 / 6to4), return that
// v4 as a dotted string so it's classified by the v4 rules. Else null.
function embeddedV4Target(b: Uint8Array): string | null {
  if (isV4Mapped(b) || isV4Compatible(b) || isNat64(b)) return embeddedV4(b, 12);
  if (b[0] === 0x20 && b[1] === 0x02) return embeddedV4(b, 2); // 6to4 2002::/16
  return null;
}

// Allowlist, not blocklist: outside embedded-v4, an address is public only if it's
// global unicast (2000::/3) and not in the IANA special-purpose sub-blocks carved
// out of it. Everything else — ::, ::1, fe80::/10, fc00::/7, ff00::/8 multicast,
// 100::/64 discard, etc. — falls outside 2000::/3 and is rejected by default.
function isGlobalUnicastV6(b: Uint8Array): boolean {
  if ((b[0] & 0xe0) !== 0x20) return false; // not in 2000::/3
  // 2001::/23 — IETF protocol assignments: Teredo, benchmarking (2001:2::/48),
  // ORCHID (2001:10::/28, 2001:20::/28), etc. — all non-routable.
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2] & 0xfe) === 0x00) return false;
  // 2001:db8::/32 — documentation.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false;
  return true;
}

function isPublicV6(b: Uint8Array): boolean {
  const embedded = embeddedV4Target(b);
  if (embedded !== null) return isPublicIp(embedded);
  return isGlobalUnicastV6(b);
}

export function isPublicIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = ipv4ToInt(ip);
    if (n === null) return false;
    return !BLOCKED_V4.some((range) => inV4Range(n, range));
  }
  if (kind === 6) {
    const b = ipv6ToBytes(ip);
    return b ? isPublicV6(b) : false;
  }
  return false;
}

interface ValidatedTarget {
  url: URL;
  /** The single validated IP the connection must be pinned to. */
  address: string;
}

// Validate a URL is fetchable and return the URL + the validated IP to pin to.
// http(s) only, no embedded credentials, real hostname, and EVERY resolved
// address public. The first resolved address is the pin target (all checked).
export async function assertPublicHttpUrl(
  raw: string,
  resolver: (host: string) => Promise<string[]> = defaultResolve,
): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('malformed');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`scheme ${url.protocol}`);
  }
  if (url.username || url.password) throw new UnsafeUrlError('credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new UnsafeUrlError('no host');

  if (isIP(host)) {
    if (!isPublicIp(host)) throw new UnsafeUrlError(`private ip ${host}`);
    return { url, address: host };
  }
  return { url, address: await resolvePublicHost(host, resolver) };
}

// Resolve a hostname and return its first address — only if the host isn't a
// known-internal name and EVERY resolved address is public.
async function resolvePublicHost(
  host: string,
  resolver: (host: string) => Promise<string[]>,
): Promise<string> {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new UnsafeUrlError(`blocked host ${host}`);
  }
  const addrs = await resolver(host);
  if (addrs.length === 0) throw new UnsafeUrlError('unresolved');
  for (const addr of addrs) {
    if (!isPublicIp(addr)) throw new UnsafeUrlError(`resolves to private ${addr}`);
  }
  return addrs[0];
}

async function defaultResolve(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true });
  return results.map((r) => r.address);
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

// undici dispatcher that pins DNS to the already-validated address, so the fetch
// can't perform a second, attacker-controlled resolution (closes the rebinding
// window). SNI / Host header stay the original hostname.
function pinnedDispatcher(address: string): Agent {
  const family = isIP(address);
  return new Agent({
    connect: {
      lookup: (_hostname: string, options: { all?: boolean } | undefined, cb: LookupCallback) => {
        if (options?.all) cb(null, [{ address, family }]);
        else cb(null, address, family);
      },
    },
  });
}

// --- metadata parsing (best-effort, never throws) ---

const METADATA_ENTITIES = new Map([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&apos;', "'"],
  ['&nbsp;', ' '],
]);

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => METADATA_ENTITIES.get(entity)!);
}

// Index every <meta> tag's property/name → content once (literal regexes only,
// either attribute order), so lookups don't build a regex per key.
function indexMetaTags(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const metaTag = /<meta\b[^>]*>/gi;
  for (let m = metaTag.exec(html); m !== null; m = metaTag.exec(html)) {
    const key = /(?:property|name)=["']([^"']+)["']/i.exec(m[0])?.[1];
    const content = /content=["']([^"']*)["']/i.exec(m[0])?.[1];
    if (key && content && content.trim()) {
      const lower = key.toLowerCase();
      if (!map.has(lower)) map.set(lower, content.trim());
    }
  }
  return map;
}

function metaContent(metas: Map<string, string>, ...names: string[]): string | null {
  for (const name of names) {
    const value = metas.get(name.toLowerCase());
    if (value) return decodeEntities(value);
  }
  return null;
}

function absolutize(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export function parseLinkMetadata(html: string, finalUrl: string): Omit<LinkPreview, 'url' | 'domain'> {
  const head = html.slice(0, MAX_BYTES);
  const metas = indexMetaTags(head);
  const ogTitle = metaContent(metas, 'og:title', 'twitter:title');
  const docTitle = head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  const title = ogTitle ?? (docTitle ? decodeEntities(docTitle) : null);
  const image = absolutize(metaContent(metas, 'og:image', 'twitter:image'), finalUrl);

  const iconHref =
    head.match(/<link[^>]+rel=["'](?:shortcut\s+icon|icon|apple-touch-icon)["'][^>]*href=["']([^"']+)["']/i)?.[1] ??
    head.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut\s+icon|icon|apple-touch-icon)["']/i)?.[1];
  let favicon = absolutize(iconHref ? decodeEntities(iconHref) : null, finalUrl);
  if (!favicon) {
    try {
      favicon = new URL('/favicon.ico', finalUrl).toString();
    } catch {
      favicon = null;
    }
  }
  return { title, favicon, image };
}

// Fetch + unfurl. SSRF guard on the initial URL and every redirect hop, with the
// connection pinned to the validated IP each time. Returns null on fetch failure;
// throws UnsafeUrlError if the URL (or any redirect) is unsafe.
export async function unfurl(
  raw: string,
  deps: { resolver?: (host: string) => Promise<string[]>; fetchImpl?: typeof fetch } = {},
): Promise<LinkPreview | null> {
  const resolver = deps.resolver ?? defaultResolve;
  const fetchImpl = deps.fetchImpl ?? fetch;

  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // assertPublicHttpUrl throws UnsafeUrlError (→ 400) and is intentionally OUTSIDE
    // the fetch path: a private/unsafe target is a hard reject, not "unfetchable".
    const target = await assertPublicHttpUrl(current, resolver);
    const result = await fetchHop(target, fetchImpl);
    if (result.kind === 'redirect') {
      current = result.next; // re-validated + re-pinned at the loop top
      continue;
    }
    if (result.kind !== 'done') return null;
    const { preview } = result;
    return {
      ...preview,
      favicon: preview.favicon ? await fetchIconDataUri(preview.favicon, deps) : null,
    };
  }
  return null;
}

/**
 * Inline a site's icon as a `data:` URI. The app pins CSP img-src to a fixed
 * allowlist while unfurl targets are arbitrary, so a remote icon URL can never
 * load there; `data:` can. Never throws: an unsafe, missing, oversized, or
 * non-image icon yields null and the card renders without one.
 */
export async function fetchIconDataUri(
  raw: string,
  deps: { resolver?: (host: string) => Promise<string[]>; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const resolver = deps.resolver ?? defaultResolve;
  const fetchImpl = deps.fetchImpl ?? fetch;

  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let target: ValidatedTarget;
    try {
      target = await assertPublicHttpUrl(current, resolver);
    } catch {
      return null; // an unsafe icon URL drops the icon, it never fails the preview
    }
    const result = await fetchIconHop(target, fetchImpl);
    if (result.kind === 'redirect') {
      current = result.next;
      continue;
    }
    return result.kind === 'done' ? result.dataUri : null;
  }
  return null;
}

type IconHopResult =
  | { kind: 'redirect'; next: string }
  | { kind: 'done'; dataUri: string }
  | { kind: 'fail' };

async function fetchIconHop(target: ValidatedTarget, fetchImpl: typeof fetch): Promise<IconHopResult> {
  const { url, address } = target;
  const dispatcher = pinnedDispatcher(address);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ICON_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      dispatcher,
      headers: { accept: 'image/*', 'user-agent': 'OctogeeLinkPreview/1.0' },
    } as RequestInit);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return { kind: 'fail' };
      return { kind: 'redirect', next: new URL(location, url).toString() };
    }
    if (!res.ok) return { kind: 'fail' };
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!ICON_TYPES.has(mime)) return { kind: 'fail' };
    const bytes = await readWholeCapped(res, ICON_MAX_BYTES);
    if (!bytes || bytes.length === 0) return { kind: 'fail' };
    return { kind: 'done', dataUri: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` };
  } catch {
    return { kind: 'fail' };
  } finally {
    clearTimeout(timer);
    await destroyQuietly(dispatcher);
  }
}

// Read the whole body, or null once it exceeds `max` — unlike HTML, a truncated
// image is useless, so the cap rejects rather than slices.
async function readWholeCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return concat(chunks);
}

type HopResult =
  | { kind: 'redirect'; next: string }
  | { kind: 'done'; preview: LinkPreview }
  | { kind: 'fail' };

// One fetch hop with the abort timer active through the ENTIRE body read (not just
// until headers — else a server can stall/trickle the body forever) and the per-hop
// pinned Agent destroyed in finally. Expected network failures — DNS/abort/timeout/
// connection/body-read errors, a missing or malformed redirect Location — resolve to
// `fail` (→ caller returns null → route 502), never a throw. The only throw path is
// UnsafeUrlError from assertPublicHttpUrl upstream (→ 400).
async function fetchHop(target: ValidatedTarget, fetchImpl: typeof fetch): Promise<HopResult> {
  const { url, address } = target;
  const dispatcher = pinnedDispatcher(address);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      dispatcher,
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'OctogeeLinkPreview/1.0' },
    } as RequestInit);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return { kind: 'fail' };
      return { kind: 'redirect', next: new URL(location, url).toString() };
    }
    if (!res.ok) return { kind: 'fail' };
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('html')) {
      return { kind: 'done', preview: { url: url.toString(), domain: url.hostname, title: null, favicon: faviconFor(url), image: null } };
    }
    const html = await readCapped(res, MAX_BYTES);
    return { kind: 'done', preview: { url: url.toString(), domain: url.hostname, ...parseLinkMetadata(html, url.toString()) } };
  } catch {
    return { kind: 'fail' };
  } finally {
    clearTimeout(timer);
    await destroyQuietly(dispatcher);
  }
}

async function destroyQuietly(dispatcher: Agent): Promise<void> {
  try {
    await dispatcher.destroy();
  } catch {
    /* best-effort cleanup of the per-hop pinned Agent */
  }
}

function faviconFor(url: URL): string | null {
  try {
    return new URL('/favicon.ico', url).toString();
  } catch {
    return null;
  }
}

// Read at most `max` bytes — never retains more than the cap, even if the server
// streams a huge first chunk (slices each read to the remaining budget).
async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const remaining = max - total;
      const slice = value.length > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.length;
      if (total >= max) {
        await reader.cancel();
        break;
      }
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
