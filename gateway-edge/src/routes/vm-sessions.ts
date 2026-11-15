import { authenticatedRequestLimit } from "@octogee/core/http/authenticated-request-limit";
import { Router, type NextFunction, type Request, type Response } from "express";
import { logger } from "@octogee/core/http/logging";
import type { NativeAdminAccess, NativeAdminAccessOutcome } from "../lib/native-admin-access.js";
import type { CdpCookie, CdpCookieOutcome, CdpCookiePartitionKey } from "../lib/cdp-cookies.js";

const MAX_COOKIES = 2000;
const MAX_DOMAINS = 200;
const MAX_FIELD = 4096;
const MAX_PATH = 2048;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/u;
const SAME_SITE = new Set(["Strict", "Lax", "None"]);
const SOURCE_SCHEMES = new Set(["Unset", "NonSecure", "Secure"]);
const UNSPECIFIED_PORT = -1;
const MAX_PORT = 65_535;
const FORBIDDEN_SUFFIXES = [
  "octogee.com",
  "firebaseapp.com",
  "web.app",
  "firebase.com",
  "firebaseio.com",
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
];

export function isForbiddenImportHost(host: string): boolean {
  const normalized = host.replace(/^\./u, "").trim().toLowerCase();
  if (!normalized) return true;
  return FORBIDDEN_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

export interface RejectedCookie {
  name: string;
  domain: string;
  reason: "forbidden_origin" | "unlisted_domain" | "invalid_fields" | "not_stored";
}

export interface VmSessionsDeps {
  localGatewayId(): string | null;
  available: boolean;
  resolveAccess(input: { gatewayId: string; authorization: string | undefined }): Promise<NativeAdminAccessOutcome>;
  applyCookies(cookies: CdpCookie[]): Promise<CdpCookieOutcome>;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

type VmRequest = Request & { vmAccess?: NativeAdminAccess };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requireVmAccess(deps: VmSessionsDeps) {
  return async (req: VmRequest, res: Response, next: NextFunction): Promise<void> => {
    const gatewayId = (req.params as { gatewayId?: unknown }).gatewayId;
    if (!deps.available || typeof gatewayId !== "string" || gatewayId.length === 0 || gatewayId !== deps.localGatewayId()) {
      res.status(404).json({ error: "computer_unavailable" });
      return;
    }
    let outcome: NativeAdminAccessOutcome;
    try {
      outcome = await deps.resolveAccess({ gatewayId, authorization: req.headers.authorization });
    } catch (err) {
      logger.warn("VM sessions access broker unavailable", { error: err instanceof Error ? err.message : String(err) });
      res.status(503).json({ error: "access_unavailable" });
      return;
    }
    if (outcome.kind === "unauthenticated") { res.status(401).json({ error: "Unauthenticated" }); return; }
    if (outcome.kind === "forbidden") { res.status(403).json({ error: "forbidden" }); return; }
    if (outcome.kind === "not_found") { res.status(404).json({ error: "computer_unavailable" }); return; }
    if (!outcome.canControl) { res.status(403).json({ error: "forbidden" }); return; }
    req.vmAccess = outcome;
    next();
  };
}

function normalizedDomains(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DOMAINS) return null;
  const domains: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return null;
    const domain = entry.trim().toLowerCase();
    if (!DOMAIN_PATTERN.test(domain)) return null;
    domains.push(domain);
  }
  return domains;
}

function hostMatchesDomain(host: string, domains: Set<string>): string | null {
  const normalized = host.replace(/^\./u, "").trim().toLowerCase();
  for (const domain of domains) {
    if (normalized === domain || normalized.endsWith(`.${domain}`)) return domain;
  }
  return null;
}

function boundedString(value: unknown, min: number, max: number): boolean {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function hasValidCookieFields(input: Record<string, unknown>): boolean {
  const strings = boundedString(input.name, 1, MAX_FIELD)
    && boundedString(input.value, 0, MAX_FIELD)
    && boundedString(input.domain, 1, 253)
    && boundedString(input.path, 1, MAX_PATH) && (input.path as string).startsWith("/");
  const flags = typeof input.secure === "boolean" && typeof input.httpOnly === "boolean";
  const expires = input.expires === undefined || (typeof input.expires === "number" && Number.isFinite(input.expires));
  const sameSite = input.sameSite === undefined || (typeof input.sameSite === "string" && SAME_SITE.has(input.sameSite));
  return strings && flags && expires && sameSite && hasValidSourceFields(input);
}

function hasValidSourceFields(input: Record<string, unknown>): boolean {
  const scheme = input.sourceScheme === undefined || (typeof input.sourceScheme === "string" && SOURCE_SCHEMES.has(input.sourceScheme));
  const port = input.sourcePort;
  const validPort = port === undefined
    || (typeof port === "number" && Number.isInteger(port) && (port === UNSPECIFIED_PORT || (port >= 1 && port <= MAX_PORT)));
  return scheme && validPort;
}

type PartitionOutcome =
  | { kind: "none" }
  | { kind: "ok"; key: CdpCookiePartitionKey }
  | { kind: "invalid" }
  | { kind: "forbidden" };

function httpsOrigin(site: string): URL | null {
  let url: URL;
  try { url = new URL(site); } catch { return null; }
  if (url.protocol !== "https:" || !url.hostname) return null;
  return url;
}

function parsePartitionKey(value: unknown): PartitionOutcome {
  if (value === undefined) return { kind: "none" };
  const input = record(value);
  if (!input || Object.keys(input).some((key) => key !== "topLevelSite" && key !== "hasCrossSiteAncestor")) return { kind: "invalid" };
  const { topLevelSite, hasCrossSiteAncestor } = input;
  if (typeof topLevelSite !== "string" || topLevelSite.length > 253 || typeof hasCrossSiteAncestor !== "boolean") return { kind: "invalid" };
  const origin = httpsOrigin(topLevelSite);
  if (!origin) return { kind: "invalid" };
  if (isForbiddenImportHost(origin.hostname)) return { kind: "forbidden" };
  return { kind: "ok", key: { topLevelSite, hasCrossSiteAncestor } };
}

function buildCookie(input: Record<string, unknown>, partitionKey?: CdpCookiePartitionKey): CdpCookie {
  const cookie: CdpCookie = {
    name: input.name as string,
    value: input.value as string,
    domain: input.domain as string,
    path: input.path as string,
    secure: input.secure as boolean,
    httpOnly: input.httpOnly as boolean,
  };
  if (typeof input.expires === "number" && input.expires > 0) cookie.expires = input.expires;
  if (typeof input.sameSite === "string") cookie.sameSite = input.sameSite as CdpCookie["sameSite"];
  if (partitionKey) cookie.partitionKey = partitionKey;
  if (typeof input.sourceScheme === "string") cookie.sourceScheme = input.sourceScheme as CdpCookie["sourceScheme"];
  if (typeof input.sourcePort === "number") cookie.sourcePort = input.sourcePort;
  return cookie;
}

function parseCookie(value: unknown, domains: Set<string>): CdpCookie | RejectedCookie {
  const input = record(value);
  const name = input && typeof input.name === "string" ? input.name : "";
  const host = input && typeof input.domain === "string" ? input.domain : "";
  const reject = (reason: RejectedCookie["reason"]): RejectedCookie => ({ name, domain: host, reason });
  if (!input || !hasValidCookieFields(input)) return reject("invalid_fields");
  if (isForbiddenImportHost(host)) return reject("forbidden_origin");
  if (!hostMatchesDomain(host, domains)) return reject("unlisted_domain");
  const partition = parsePartitionKey(input.partitionKey);
  if (partition.kind === "invalid") return reject("invalid_fields");
  if (partition.kind === "forbidden") return reject("forbidden_origin");
  return buildCookie(input, partition.kind === "ok" ? partition.key : undefined);
}

function isRejected(value: CdpCookie | RejectedCookie): value is RejectedCookie {
  return "reason" in value;
}

export function createVmSessionsRouter(deps: VmSessionsDeps): Router {
  const log = deps.log ?? ((message, meta) => logger.info(message, meta));
  const router = Router({ mergeParams: true });
  router.post("/sessions/import", authenticatedRequestLimit(60), requireVmAccess(deps), async (req: VmRequest, res) => {
    const body = record(req.body);
    if (!body || Object.keys(body).some((key) => key !== "domains" && key !== "cookies")) {
      res.status(400).json({ error: "invalid_payload" });
      return;
    }
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_PAYLOAD_BYTES) {
      res.status(413).json({ error: "payload_too_large" });
      return;
    }
    const domains = normalizedDomains(body.domains);
    if (!domains) { res.status(400).json({ error: "invalid_domains" }); return; }
    if (domains.some((domain) => isForbiddenImportHost(domain))) { res.status(400).json({ error: "forbidden_domain" }); return; }
    if (!Array.isArray(body.cookies) || body.cookies.length === 0 || body.cookies.length > MAX_COOKIES) {
      res.status(400).json({ error: "invalid_cookies" });
      return;
    }
    const domainSet = new Set(domains);
    const accepted: CdpCookie[] = [];
    const rejected: RejectedCookie[] = [];
    for (const entry of body.cookies) {
      const parsed = parseCookie(entry, domainSet);
      if (isRejected(parsed)) rejected.push(parsed);
      else accepted.push(parsed);
    }
    const access = req.vmAccess!;
    let applied = 0;
    try {
      const outcome = await deps.applyCookies(accepted);
      applied = outcome.stored;
      for (const dropped of outcome.dropped) rejected.push({ ...dropped, reason: "not_stored" });
    } catch (error) {
      log("VM sessions import failed to apply", { gatewayId: access.gatewayId, uid: req.uid, error: error instanceof Error ? error.message : String(error) });
      res.status(502).json({ error: "computer_unreachable" });
      return;
    }
    log("VM sessions import applied", {
      event: "computer.sessions.import",
      gatewayId: access.gatewayId,
      uid: req.uid,
      workspaceSlug: access.workspaceSlug,
      domains,
      applied,
      rejected: rejected.length,
    });
    res.status(200).set("cache-control", "no-store").json({ applied, rejected });
  });

  return router;
}
