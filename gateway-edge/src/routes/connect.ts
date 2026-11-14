import * as crypto from "crypto";
import { Router, Request, Response, NextFunction } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import {
  GOOGLE_CAPABILITY_SCOPES,
  googleCapabilitiesFromScopes,
  parseGooglePickedFiles,
  type ConnectorCaptureMethod,
} from "@octogee/shared/types/connectors";
import { GOOGLE_CAPABILITY_CATALOG_VERSION } from "@octogee/shared/types/google-capabilities";
import {
  GOOGLE_CONNECT_CAPABILITY_KEYS,
  googleCapabilityConnectAllowed,
  googleConnectAllowed,
  googleConsentPermission,
  isGoogleConnectCapabilityKey,
  type GoogleConnectCapabilityKey,
  type PlatformConnectConfig,
} from "@octogee/shared/types/platform-config";
import { accountActiveInStore } from "../lib/user-platform-state.js";
import { revokeProviderGrant } from "@octogee/core/connector-revocation";
import { requireActiveAccount, requireAuthenticatedUid } from "../middleware/auth.js";
import { DEFAULT_RATE_LIMIT_OPTIONS } from "../middleware/security.js";
import { logger } from "../middleware/logging.js";
import { db, FieldValue, Timestamp } from "../lib/db.js";
import { platformStateStore } from "../lib/platform-state.js";
import { encryptSecret, decryptSecret } from "../lib/kms.js";
import { sanitizeReturnUrl, buildOAuthRedirect } from "../lib/redirect-validation.js";
import {
  MalformedPlatformConnectConfigError,
  readPlatformConnectConfig,
} from "../lib/platform-connect-config.js";
import {
  generateConnectState,
  verifyConnectState,
  type ConnectStatePayload,
} from "../lib/connect-state.js";
import {
  getConnector,
  listConnectors,
  connectorRedirectUri,
  type ConnectorDef,
} from "../lib/connectors/index.js";
import {
  configuredEnvValue,
  readConnectorClientCreds,
  getFreshAccessToken,
  type ConnectorClientCreds,
} from "../lib/connector-tokens.js";

import { connectorDisconnected } from "../lib/connector-disconnect.js";

const router = Router();
const connectorAuthenticationLimit = rateLimit({
  windowMs: 60_000,
  limit: 1200,
  legacyHeaders: false,
  keyGenerator: req => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown"),
  skipSuccessfulRequests: true,
  requestWasSuccessful: req => Boolean(req.uid),
  message: { error: "Too many connector authentication attempts, please try again later." },
});
const callbackVerificationLimit = rateLimit({
  ...DEFAULT_RATE_LIMIT_OPTIONS,
  windowMs: 60_000,
  limit: 1200,
  keyGenerator: req => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown"),
  message: { error: "Too many connector callbacks, please try again later." },
});
function connectorRateLimit(limit: number) {
  return rateLimit({
    ...DEFAULT_RATE_LIMIT_OPTIONS,
    windowMs: 60_000,
    limit,
    keyGenerator: req => req.uid!,
    message: { error: "Too many connector requests, please try again later." },
  });
}
const APP_URL = process.env.APP_URL || "https://octogee.com";
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

class GoogleAccountMismatchError extends Error {
  constructor() {
    super("google_account_mismatch");
    this.name = "GoogleAccountMismatchError";
  }
}

class InactiveConnectorOwnerError extends Error {
  constructor() {
    super("connector owner is not active");
    this.name = "InactiveConnectorOwnerError";
  }
}

interface RouteError {
  status: number;
  body: Record<string, unknown>;
}

type FieldsConnectorDef = ConnectorDef & {
  validateFields: NonNullable<ConnectorDef["validateFields"]>;
};

type DeviceConnectorDef = ConnectorDef & {
  device: NonNullable<ConnectorDef["device"]>;
};

function routeError(status: number, body: Record<string, unknown>): RouteError {
  return { status, body };
}

function isRouteError<T>(value: T | RouteError): value is RouteError {
  return typeof (value as RouteError).status === "number" && "body" in (value as RouteError);
}

function sendRouteError(res: Response, error: RouteError): void {
  res.status(error.status).json(error.body);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function flowsCol() {
  return db.collection("connectFlows");
}

function userCol(uid: string, sub: "secrets" | "integrations") {
  return db.collection("users").doc(uid).collection(sub);
}

function requestScopesFor(def: ConnectorDef, capability: unknown): string[] | RouteError {
  if (!def.capabilityRequestScopes) return def.meta.scopes;
  if (typeof capability !== "string" || capability.length === 0) {
    return routeError(400, { error: "capability required" });
  }
  const scopes = def.capabilityRequestScopes(capability);
  return scopes ?? routeError(400, { error: `Unknown capability: ${capability}` });
}

function parseGoogleCapabilityRequest(capability: unknown): GoogleConnectCapabilityKey[] | RouteError {
  if (typeof capability !== "string" || capability.length === 0) {
    return routeError(400, { error: "capability required" });
  }
  const requested = capability.split(",");
  if (!requested.every(isGoogleConnectCapabilityKey)) {
    return routeError(400, { error: `Unknown capability: ${capability}` });
  }
  return requested;
}

function permittedGoogleCapabilityRequest(
  config: PlatformConnectConfig,
  uid: string,
  capability: unknown,
): { capability: string; excluded: GoogleConnectCapabilityKey[] } | RouteError {
  const requested = parseGoogleCapabilityRequest(capability);
  if (isRouteError(requested)) return requested;
  const { permitted, excluded } = googleConsentPermission(config, uid, requested);
  if (permitted.length === 0) {
    logger.info(
      `[connect] google auth-url refused for uid=${uid}: no requested capability admits this uid (${requested.join(",")})`,
    );
    return routeError(403, { error: "pending_verification", excluded });
  }
  if (excluded.length > 0) {
    logger.info(
      `[connect] google auth-url for uid=${uid} dropped stage-gated capabilities: ${excluded.join(",")}`,
    );
  }
  return { capability: permitted.join(","), excluded };
}

function googleCapabilityAvailability(
  config: PlatformConnectConfig,
  uid: string,
): Record<GoogleConnectCapabilityKey, { stage: string; available: boolean }> {
  return Object.fromEntries(
    GOOGLE_CONNECT_CAPABILITY_KEYS.map((capability) => [
      capability,
      {
        stage: config.googleStages[capability],
        available: googleCapabilityConnectAllowed(config, uid, capability),
      },
    ]),
  ) as Record<GoogleConnectCapabilityKey, { stage: string; available: boolean }>;
}

function sendIfMalformedConnectConfig(res: Response, error: unknown): boolean {
  if (!(error instanceof MalformedPlatformConnectConfigError)) return false;
  res.status(503).json({ error: "connect_config_invalid" });
  return true;
}

async function connectedAccountHint(uid: string, def: ConnectorDef): Promise<Record<string, string>> {
  const param = def.oauth?.accountHintParam;
  if (!param) return {};
  const snap = await userCol(uid, "integrations").doc(def.meta.id).get();
  const accountLabel = (snap.data() as { accountLabel?: unknown } | undefined)?.accountLabel;
  return typeof accountLabel === "string" && accountLabel.length > 0 ? { [param]: accountLabel } : {};
}

function parseGrantedScopes(scope: string | undefined, requested: string[]): string[] {
  const parsed = (scope ?? "").split(/[\s,]+/).filter(Boolean);
  return parsed.length > 0 ? parsed : requested;
}

async function enforceGoogleAccountContinuity(uid: string, accountLabel: string): Promise<void> {
  const snap = await userCol(uid, "integrations").doc("google").get();
  const existing = (snap.data() as { accountLabel?: unknown } | undefined)?.accountLabel;
  if (
    typeof existing === "string" &&
    existing.trim().toLowerCase() !== accountLabel.trim().toLowerCase()
  ) {
    throw new GoogleAccountMismatchError();
  }
}

function googleCapabilityGrantLedger(scopes: readonly string[]): Record<string, unknown>[] {
  const consentedAt = Timestamp.now();
  return googleCapabilitiesFromScopes(scopes).map((capability) => ({
    capability,
    state: "granted",
    scopes: GOOGLE_CAPABILITY_SCOPES[capability],
    catalogVersion: GOOGLE_CAPABILITY_CATALOG_VERSION,
    consentedAt,
  }));
}

async function storeConnectorTokens(args: {
  uid: string;
  def: ConnectorDef;
  tokens: TokenResponse;
  accountLabel: string;
  captureMethod: ConnectorCaptureMethod;
  grantedScopes?: string[];
}): Promise<void> {
  const { uid, def, tokens, accountLabel, captureMethod, grantedScopes } = args;
  const encryptedAccessToken = await encryptSecret(tokens.access_token);
  const encryptedRefreshToken = tokens.refresh_token
    ? await encryptSecret(tokens.refresh_token)
    : null;
  const refreshTokenPatch: { encryptedRefreshToken?: string | null } = {};
  if (encryptedRefreshToken) {
    refreshTokenPatch.encryptedRefreshToken = encryptedRefreshToken;
  } else if (captureMethod !== "oauth-web") {
    refreshTokenPatch.encryptedRefreshToken = null;
  }

  const secretRef = userCol(uid, "secrets").doc(def.meta.id);
  const integrationRef = userCol(uid, "integrations").doc(def.meta.id);
  const secret = {
      provider: def.meta.id,
      tokens: {
        encryptedAccessToken,
        ...refreshTokenPatch,
        expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
        tokenType: tokens.token_type ?? "bearer",
      },
      updatedAt: FieldValue.serverTimestamp(),
    };

  const integration = {
    provider: def.meta.id,
    status: "connected",
    accountLabel,
    scopes: captureMethod === "oauth-web" ? grantedScopes ?? [] : [],
    captureMethod,
    connectedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...(def.meta.id === "google"
      ? {
          capabilityCatalogVersion: GOOGLE_CAPABILITY_CATALOG_VERSION,
          capabilityGrants: googleCapabilityGrantLedger(grantedScopes ?? []),
        }
      : {}),
  };
  await db.runTransaction(async (tx) => {
    const ownerRef = db.collection("users").doc(uid);
    const owner = await tx.get(ownerRef);
    if (!owner.exists || !(await accountActiveInStore(uid))) {
      throw new InactiveConnectorOwnerError();
    }
    const priorGoogle = def.meta.id === "google" ? (await tx.get(integrationRef)).data() : undefined;
    const continuingGoogleConnection = priorGoogle?.status === "connected"
      && priorGoogle.accountLabel === accountLabel && priorGoogle.connectedAt;
    tx.set(secretRef, secret, { merge: true });
    if (def.meta.id === "google") {
      tx.set(integrationRef, {
        ...integration,
        connectedAt: continuingGoogleConnection ? priorGoogle.connectedAt : integration.connectedAt,
        error: FieldValue.delete(),
        verifiedAt: FieldValue.delete(),
      }, { merge: true });
    } else {
      tx.set(integrationRef, integration);
    }
  });

  logger.info(`[connect] ${def.meta.id} connected for uid=${uid} via ${captureMethod}`);
}

async function exchangeAuthCode(
  def: ConnectorDef,
  code: string,
  creds: ConnectorClientCreds,
  codeVerifier: string | null,
): Promise<TokenResponse> {
  const oauth = def.oauth!;
  const resp = await fetch(oauth.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: connectorRedirectUri(def),
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    }),
  });
  if (!resp.ok) {
    throw new Error(`token exchange failed: ${resp.status}`);
  }
  const tokens = (await resp.json()) as TokenResponse & { error?: string };
  if (tokens.error || !tokens.access_token) {
    throw new Error(`token exchange rejected: ${tokens.error ?? "no access_token"}`);
  }
  return tokens;
}

async function revokeFreshConnectorGrant(def: ConnectorDef, tokens: TokenResponse): Promise<void> {
  if (!def.oauth?.revocationUrl) return;
  const token = tokens.refresh_token ?? tokens.access_token;
  const response = await fetch(def.oauth.revocationUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`provider revoke returned ${response.status}`);
  }
}

async function revokeStoredConnectorFields(uid: string, def: ConnectorDef): Promise<void> {
  if (!def.revokeStoredFields) return;
  const snap = await userCol(uid, "secrets").doc(def.meta.id).get();
  const encryptedFields = (snap.data() as { fields?: Record<string, unknown> } | undefined)?.fields;
  if (!encryptedFields) return;
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(encryptedFields)) {
    if (typeof value === "string") fields[key] = await decryptSecret(value);
  }
  await def.revokeStoredFields(fields);
}

async function cleanupInactiveConnectorCallback(
  error: unknown,
  def: ConnectorDef,
  tokens: TokenResponse | null,
  uid: string,
): Promise<void> {
  if (!(error instanceof InactiveConnectorOwnerError) || !tokens) return;
  try {
    await revokeFreshConnectorGrant(def, tokens);
  } catch (cleanupError) {
    logger.error(
      `[connect] ${def.meta.id} inactive callback revoke failed for uid=${uid}: ${String(cleanupError)}`,
    );
  }
}

router.post(
  "/disconnect",
  connectorAuthenticationLimit, requireAuthenticatedUid, connectorRateLimit(30), requireActiveAccount,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const connector = String((req.body ?? {}).connector ?? "");
      const def = getConnector(connector);
      if (!def) {
        res.status(400).json({ error: `Unknown connector: ${connector}` });
        return;
      }
      if (def.oauth?.revocationUrl) {
        await revokeProviderGrant(
          req.uid!,
          { connectorId: def.meta.id, revocationUrl: def.oauth.revocationUrl },
          { secrets: platformStateStore.secrets, decryptSecret, logger },
        );
      }
      if (def.revokeStoredFields) {
        try {
          await revokeStoredConnectorFields(req.uid!, def);
        } catch (error) {
          logger.warn(`[connect] ${def.meta.id} provider revoke failed for uid=${req.uid}: ${String(error)}`);
        }
      }
      const disconnect = db.batch();
      disconnect.set(userCol(req.uid!, "integrations").doc(def.meta.id), {
        provider: def.meta.id,
        status: "disconnected",
        updatedAt: FieldValue.serverTimestamp(),
      });
      disconnect.delete(userCol(req.uid!, "secrets").doc(def.meta.id));
      await disconnect.commit();
      await connectorDisconnected()(req.uid!, def.meta.id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/availability",
  connectorAuthenticationLimit, requireAuthenticatedUid, connectorRateLimit(120), requireActiveAccount,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const config = await readPlatformConnectConfig();
      const providers: Record<
        string,
        {
          configured: boolean;
          available: boolean;
          pickerConfigured?: boolean;
          capabilities?: Record<string, { stage: string; available: boolean }>;
        }
      > = {};
      for (const def of listConnectors()) {
        if (!def.oauth) continue;
        const configured = readConnectorClientCreds(def) !== null;
        providers[def.meta.id] =
          def.meta.id === "google"
            ? {
                configured,
                available: configured && googleConnectAllowed(config, req.uid!),
                pickerConfigured: googlePickerEnv() !== null,
                capabilities: googleCapabilityAvailability(config, req.uid!),
              }
            : { configured, available: configured };
      }
      res.json({ providers });
    } catch (e) {
      if (sendIfMalformedConnectConfig(res, e)) return;
      next(e);
    }
  },
);

async function setVerifyStatus(
  uid: string,
  def: ConnectorDef,
  patch: { status: "connected" } | { status: "error"; error: string },
): Promise<void> {
  await userCol(uid, "integrations").doc(def.meta.id).set(
    {
      provider: def.meta.id,
      ...patch,
      ...(patch.status === "connected"
        ? { error: FieldValue.delete(), verifiedAt: FieldValue.serverTimestamp() }
        : {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function verifyFieldsConnector(
  uid: string,
  def: ConnectorDef,
  res: Response,
): Promise<void> {
  const snap = await userCol(uid, "secrets").doc(def.meta.id).get();
  const encryptedFields = (snap.data() as { fields?: Record<string, unknown> } | undefined)?.fields;
  if (!encryptedFields || Object.keys(encryptedFields).length === 0) {
    res.status(422).json({ ok: false, reason: "not_connected" });
    return;
  }
  try {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(encryptedFields)) {
      if (typeof v === "string") fields[k] = await decryptSecret(v);
    }
    const validate = def.validateStoredFields ?? def.validateFields;
    if (!validate) {
      res.status(422).json({ ok: false, reason: "not_connected" });
      return;
    }
    const identity = await validate(fields);
    await setVerifyStatus(uid, def, { status: "connected" });
    res.json({ ok: true, accountLabel: identity.accountLabel });
  } catch (err) {
    logger.warn(`[connect] ${def.meta.id} fields verify failed for uid=${uid}: ${(err as Error).message}`);
    await setVerifyStatus(uid, def, { status: "error", error: "verify_failed" });
    res.status(502).json({ ok: false, reason: "provider_rejected" });
  }
}

async function grantedScopesFor(uid: string, def: ConnectorDef): Promise<string[]> {
  const snap = await userCol(uid, "integrations").doc(def.meta.id).get();
  const scopes = (snap.data() as { scopes?: unknown } | undefined)?.scopes;
  return Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : [];
}

async function verifyTokenConnector(
  uid: string,
  def: ConnectorDef,
  res: Response,
): Promise<void> {
  const fresh = await getFreshAccessToken(uid, def);
  if (!fresh.ok) {
    if (fresh.reason === "reauth_required") {
      await setVerifyStatus(uid, def, { status: "error", error: "reauth_required" });
      res.status(409).json({ ok: false, reason: fresh.reason });
      return;
    }
    res.status(422).json({ ok: false, reason: fresh.reason });
    return;
  }
  try {
    const [identity, grantedScopes] = await Promise.all([
      def.fetchIdentity(fresh.accessToken),
      def.deepProbe ? grantedScopesFor(uid, def) : Promise.resolve([]),
    ]);
    const probe = def.deepProbe ? await def.deepProbe(fresh.accessToken, grantedScopes) : null;
    await setVerifyStatus(uid, def, { status: "connected" });
    res.json({ ok: true, accountLabel: identity.accountLabel, ...(probe ? { probe } : {}) });
  } catch (err) {
    logger.warn(`[connect] ${def.meta.id} verify failed for uid=${uid}: ${err instanceof Error ? err.message : String(err)}`);
    await setVerifyStatus(uid, def, { status: "error", error: "verify_failed" });
    res.status(502).json({ ok: false, reason: "provider_rejected" });
  }
}

router.post(
  "/:connector/verify",
  connectorAuthenticationLimit, requireAuthenticatedUid, connectorRateLimit(30), requireActiveAccount,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const def = getConnector(req.params.connector as string);
      if (!def) {
        res.status(404).json({ error: "Unknown connector" });
        return;
      }
      const canVerifyStoredFields = def.validateStoredFields
        && def.meta.captureMethods.includes("local-pairing");
      if (canVerifyStoredFields || (def.validateFields && def.meta.captureMethods.includes("fields"))) {
        await verifyFieldsConnector(req.uid!, def, res);
      } else {
        await verifyTokenConnector(req.uid!, def, res);
      }
    } catch (e) {
      next(e);
    }
  },
);

function googlePickerEnv(): { clientId: string; apiKey: string; appId: string } | null {
  const clientId = configuredEnvValue(process.env.GOOGLE_PICKER_CLIENT_ID);
  const serverClientId = configuredEnvValue(process.env.GOOGLE_CLIENT_ID);
  const apiKey = configuredEnvValue(process.env.GOOGLE_PICKER_API_KEY);
  const appId = configuredEnvValue(process.env.GOOGLE_PICKER_APP_ID);
  return clientId && clientId !== serverClientId && apiKey && appId
    ? { clientId, apiKey, appId }
    : null;
}

router.get(
  "/google/picker-token",
  connectorAuthenticationLimit, requireAuthenticatedUid, connectorRateLimit(60), requireActiveAccount,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const picker = googlePickerEnv();
      if (!picker) {
        logger.error(
          "[connect] google picker unavailable: dedicated GOOGLE_PICKER_CLIENT_ID, GOOGLE_PICKER_API_KEY, and GOOGLE_PICKER_APP_ID are required",
        );
        res.status(503).json({ error: "Google Drive picker is not configured" });
        return;
      }
      const def = getConnector("google")!;
      const scopes = await grantedScopesFor(req.uid!, def);
      if (!googleCapabilitiesFromScopes(scopes).includes("drive")) {
        res.status(422).json({ ok: false, reason: "drive_not_connected" });
        return;
      }
      const fresh = await getFreshAccessToken(req.uid!, def);
      if (!fresh.ok) {
        res
          .status(fresh.reason === "reauth_required" ? 409 : 422)
          .json({ ok: false, reason: fresh.reason });
        return;
      }
      const integration = await userCol(req.uid!, "integrations").doc("google").get();
      const accountHint = nonEmptyString(integration.data()?.accountLabel);
      if (!accountHint) {
        logger.error(`[connect] google picker unavailable: account label missing for uid=${req.uid!}`);
        res.status(422).json({ ok: false, reason: "google_account_unknown" });
        return;
      }
      res.set("Cache-Control", "no-store");
      res.set("Pragma", "no-cache");
      res.json({
        clientId: picker.clientId,
        apiKey: picker.apiKey,
        appId: picker.appId,
        accountHint,
      });
    } catch (e) {
      next(e);
    }
  },
);

const GOOGLE_PICKED_FILES_MAX = 500;

router.post(
  "/google/picked-files",
  connectorAuthenticationLimit, requireAuthenticatedUid, connectorRateLimit(60), requireActiveAccount,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { add, remove } = (req.body ?? {}) as { add?: unknown; remove?: unknown };
      const files = parseGooglePickedFiles(add);
      const removeIds = Array.isArray(remove)
        ? remove.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      if (files.length === 0 && removeIds.length === 0) {
        res.status(400).json({ error: "add or remove required" });
        return;
      }
      const ref = userCol(req.uid!, "integrations").doc("google");
      const snap = await ref.get();
      if (!snap.exists) {
        res.status(422).json({ ok: false, reason: "not_connected" });
        return;
      }
      const integration = snap.data() as { status?: unknown; scopes?: unknown; pickedFiles?: unknown };
      if (integration.status !== "connected") {
        res.status(422).json({ ok: false, reason: "not_connected" });
        return;
      }
      const scopes = Array.isArray(integration.scopes)
        ? integration.scopes.filter((scope): scope is string => typeof scope === "string")
        : [];
      if (!googleCapabilitiesFromScopes(scopes).includes("drive")) {
        res.status(422).json({ ok: false, reason: "drive_not_connected" });
        return;
      }
      const current = parseGooglePickedFiles(
        integration.pickedFiles,
      );
      const dropIds = new Set([...removeIds, ...files.map((f) => f.id)]);
      const pickedFiles = [...current.filter((f) => !dropIds.has(f.id)), ...files];
      if (pickedFiles.length > GOOGLE_PICKED_FILES_MAX) {
        res.status(400).json({ error: `picked files capped at ${GOOGLE_PICKED_FILES_MAX}` });
        return;
      }
      await ref.set({ pickedFiles, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      res.json({ ok: true, pickedFiles });
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/:connector/auth-url",
  connectorAuthenticationLimit, requireAuthenticatedUid, connectorRateLimit(60), requireActiveAccount,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const def = getConnector(req.params.connector as string);
      if (!def?.oauth) {
        res.status(404).json({ error: "Unknown connector" });
        return;
      }
      let capabilityRequest = req.query.capability;
      let excluded: GoogleConnectCapabilityKey[] = [];
      if (def.meta.id === "google") {
        const config = await readPlatformConnectConfig();
        const permitted = permittedGoogleCapabilityRequest(config, req.uid!, req.query.capability);
        if (isRouteError(permitted)) {
          sendRouteError(res, permitted);
          return;
        }
        capabilityRequest = permitted.capability;
        excluded = permitted.excluded;
      }
      const creds = readConnectorClientCreds(def);
      if (!creds) {
        logger.error(`[connect] ${def.meta.id} unavailable: ${def.oauth.clientIdEnv} is not set`);
        res.status(503).json({ error: `${def.meta.displayName} connection is not configured` });
        return;
      }
      const scopes = requestScopesFor(def, capabilityRequest);
      if (isRouteError(scopes)) {
        sendRouteError(res, scopes);
        return;
      }

      const returnUrl = sanitizeReturnUrl(req.query.returnUrl as string | undefined);
      const { state, nonce, expiresAt } = generateConnectState({
        uid: req.uid!,
        connector: def.meta.id,
        returnUrl,
      });
      const codeVerifier = def.oauth.pkce ? crypto.randomBytes(32).toString("base64url") : null;
      await flowsCol().doc(nonce).set({
        uid: req.uid!,
        connector: def.meta.id,
        kind: "oauth-web",
        requestedScopes: scopes,
        ...(codeVerifier ? { codeVerifier } : {}),
        createdAt: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromDate(expiresAt),
      });

      const params = new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: connectorRedirectUri(def),
        response_type: "code",
        scope: scopes.join(" "),
        state,
        ...(codeVerifier
          ? {
              code_challenge: crypto
                .createHash("sha256")
                .update(codeVerifier)
                .digest("base64url"),
              code_challenge_method: "S256",
            }
          : {}),
        ...(def.oauth.extraAuthParams ?? {}),
        ...(await connectedAccountHint(req.uid!, def)),
      });
      res.set("Cache-Control", "no-store");
      res.set("Pragma", "no-cache");
      res.json({ url: `${def.oauth.authorizeUrl}?${params}`, excluded });
    } catch (e) {
      if (sendIfMalformedConnectConfig(res, e)) return;
      next(e);
    }
  },
);

async function consumeFlowNonce(
  payload: ConnectStatePayload,
  connectorId: string,
): Promise<{ requestedScopes: string[] | null; codeVerifier: string | null }> {
  return db.runTransaction(async (tx) => {
    const ref = flowsCol().doc(payload.nonce);
    const [snap, owner] = await Promise.all([
      tx.get(ref),
      tx.get(db.collection("users").doc(payload.uid)),
    ]);
    const flow = snap.data() as
      | {
          uid?: string;
          connector?: string;
          consumedAt?: unknown;
          requestedScopes?: unknown;
          codeVerifier?: unknown;
        }
      | undefined;
    if (!snap.exists || !flow || flow.consumedAt || flow.uid !== payload.uid || flow.connector !== connectorId) {
      throw new Error("state nonce unknown or already consumed");
    }
    if (!owner.exists || !(await accountActiveInStore(payload.uid))) {
      throw new InactiveConnectorOwnerError();
    }
    tx.set(ref, { consumedAt: FieldValue.serverTimestamp() }, { merge: true });
    return {
      requestedScopes: Array.isArray(flow.requestedScopes)
        ? flow.requestedScopes.filter((s): s is string => typeof s === "string")
        : null,
      codeVerifier: typeof flow.codeVerifier === "string" ? flow.codeVerifier : null,
    };
  });
}

async function redirectOAuthCallbackFailure(
  res: Response,
  def: ConnectorDef,
  payload: ConnectStatePayload,
  err: unknown,
): Promise<void> {
  if (err instanceof GoogleAccountMismatchError) {
    logger.warn(`[connect] google callback rejected an account switch for uid=${payload.uid}`);
    res.redirect(
      buildOAuthRedirect(payload.returnUrl, APP_URL, {
        connect_error: "google_account_mismatch",
      }),
    );
    return;
  }
  if (err instanceof InactiveConnectorOwnerError) {
    res.redirect(
      buildOAuthRedirect(payload.returnUrl, APP_URL, { connect_error: "account_inactive" }),
    );
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  logger.error(`[connect] ${def.meta.id} connect failed for uid=${payload.uid}: ${msg}`);
  try {
    await userCol(payload.uid, "integrations").doc(def.meta.id).set(
      {
        provider: def.meta.id,
        status: "error",
        error: msg.slice(0, 300),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } catch (statusErr) {
    logger.error(
      `[connect] ${def.meta.id} error-status write failed for uid=${payload.uid}: ${String(statusErr)}`,
    );
  }
  res.redirect(
    buildOAuthRedirect(payload.returnUrl, APP_URL, {
      connect_error: `${def.meta.id}_failed`,
    }),
  );
}

type OAuthCallback = { def: ConnectorDef; payload: ConnectStatePayload };

function validateOAuthCallback(req: Request, res: Response<unknown, OAuthCallback>, next: NextFunction): void {
  const def = getConnector(req.params.connector as string);
  if (!def?.oauth) {
    res.status(404).json({ error: "Unknown connector" });
    return;
  }
  try {
    const payload = verifyConnectState(String(req.query.state ?? ""));
    if (payload.connector !== def.meta.id) {
      throw new Error(`state minted for ${payload.connector}, presented to ${def.meta.id}`);
    }
    req.uid = payload.uid;
    Object.assign(res.locals, { def, payload });
  } catch (err) {
    logger.warn(`[connect] ${def.meta.id} callback rejected: ${(err as Error).message}`);
    res.redirect(`${APP_URL}/dashboard?connect_error=invalid_state`);
    return;
  }
  next();
}

router.get("/:connector/callback", callbackVerificationLimit, validateOAuthCallback, connectorRateLimit(60), async (req: Request, res: Response<unknown, OAuthCallback>) => {
  const { def, payload } = res.locals;
  const { code, error: authError } = req.query as Record<string, string | undefined>;
  let flow: Awaited<ReturnType<typeof consumeFlowNonce>>;
  try {
    flow = await consumeFlowNonce(payload, def.meta.id);
  } catch (err) {
    logger.warn(`[connect] ${def.meta.id} callback rejected: ${(err as Error).message}`);
    res.redirect(`${APP_URL}/dashboard?connect_error=invalid_state`);
    return;
  }

  if (authError || !code) {
    res.redirect(
      buildOAuthRedirect(payload.returnUrl, APP_URL, {
        connect_error: authError ? "cancelled" : "invalid",
      }),
    );
    return;
  }

  let exchangedTokens: TokenResponse | null = null;
  try {
    const creds = readConnectorClientCreds(def);
    if (!creds) {
      throw new Error("connector client credentials missing at exchange time");
    }
    const tokens = await exchangeAuthCode(def, code, creds, flow.codeVerifier);
    exchangedTokens = tokens;
    const identity = await def.fetchIdentity(tokens.access_token);
    if (def.meta.id === "google") {
      await enforceGoogleAccountContinuity(payload.uid, identity.accountLabel);
    }
    await storeConnectorTokens({
      uid: payload.uid,
      def,
      tokens,
      accountLabel: identity.accountLabel,
      captureMethod: "oauth-web",
      grantedScopes: parseGrantedScopes(tokens.scope, flow.requestedScopes ?? def.meta.scopes),
    });
    res.redirect(
      buildOAuthRedirect(payload.returnUrl, APP_URL, {
        [`${def.meta.id}_connected`]: "true",
      }),
    );
  } catch (err) {
    await cleanupInactiveConnectorCallback(err, def, exchangedTokens, payload.uid);
    await redirectOAuthCallbackFailure(res, def, payload, err);
  }
});

router.post(
  "/:connector/pat",
  connectorAuthenticationLimit, requireAuthenticatedUid, connectorRateLimit(30), requireActiveAccount,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const def = getConnector(req.params.connector as string);
      if (!def || !def.meta.captureMethods.includes("pat")) {
        res.status(404).json({ error: "Unknown connector or PAT capture not supported" });
        return;
      }
      const token = (req.body ?? {}).token;
      if (typeof token !== "string" || token.trim().length === 0) {
        res.status(400).json({ error: "token required" });
        return;
      }

      let accountLabel: string;
      try {
        ({ accountLabel } = await def.fetchIdentity(token.trim()));
      } catch (err) {
        logger.warn(`[connect] ${def.meta.id} PAT rejected for uid=${req.uid}: ${(err as Error).message}`);
        res.status(400).json({ error: "Token was rejected by the provider" });
        return;
      }

      await storeConnectorTokens({
        uid: req.uid!,
        def,
        tokens: { access_token: token.trim() },
        accountLabel,
        captureMethod: "pat",
      });
      res.json({ ok: true, accountLabel });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/:connector/fields",
  connectorAuthenticationLimit, requireAuthenticatedUid, connectorRateLimit(30), requireActiveAccount,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const def = fieldsConnectorDef(req.params.connector as string);
      if (!def) {
        res.status(404).json({ error: "Unknown connector or fields capture not supported" });
        return;
      }

      const fields = connectorFieldsFromBody(def, req.body);
      if (isRouteError(fields)) {
        sendRouteError(res, fields);
        return;
      }

      const identity = await validateConnectorFields(req.uid!, def, fields);
      if (isRouteError(identity)) {
        sendRouteError(res, identity);
        return;
      }

      await storeFieldsConnector(req.uid!, def, fields, identity.accountLabel);
      logger.info(`[connect] ${def.meta.id} connected for uid=${req.uid} via fields (${identity.accountLabel})`);
      res.json({ ok: true, accountLabel: identity.accountLabel });
    } catch (e) {
      next(e);
    }
  },
);

function fieldsConnectorDef(connector: string): FieldsConnectorDef | null {
  const def = getConnector(connector);
  if (
    !def?.validateFields
    || !def.meta.captureMethods.includes("fields")
  ) {
    return null;
  }
  return def as FieldsConnectorDef;
}

function fieldsBody(body: unknown): Record<string, unknown> {
  return (((body ?? {}) as { fields?: unknown }).fields ?? {}) as Record<string, unknown>;
}

function connectorFieldsFromBody(
  def: FieldsConnectorDef,
  body: unknown,
): Record<string, string> | RouteError {
  const fields = new Map<string, string>();
  const input = fieldsBody(body);
  for (const field of def.meta.captureFields ?? []) {
    const value = Object.hasOwn(input, field.key) ? input[field.key] : undefined;
    if (typeof value !== "string" || value.trim().length === 0) {
      return routeError(400, { error: `${field.label} is required` });
    }
    fields.set(field.key, value.trim());
  }
  return Object.fromEntries(fields);
}

async function validateConnectorFields(
  uid: string,
  def: FieldsConnectorDef,
  fields: Record<string, string>,
): Promise<{ accountLabel: string } | RouteError> {
  try {
    return await def.validateFields(fields);
  } catch (err) {
    logger.warn(`[connect] ${def.meta.id} fields rejected for uid=${uid}: ${(err as Error).message}`);
    return routeError(400, { error: "The provider rejected these credentials" });
  }
}

async function encryptConnectorFields(fields: Record<string, string>): Promise<Record<string, string>> {
  const encryptedFields = new Map<string, string>();
  for (const [key, value] of Object.entries(fields)) {
    encryptedFields.set(key, await encryptSecret(value));
  }
  return Object.fromEntries(encryptedFields);
}

async function storeFieldsConnector(
  uid: string,
  def: FieldsConnectorDef,
  fields: Record<string, string>,
  accountLabel: string,
): Promise<void> {
  await userCol(uid, "secrets").doc(def.meta.id).set({
    provider: def.meta.id,
    fields: await encryptConnectorFields(fields),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await userCol(uid, "integrations").doc(def.meta.id).set({
    provider: def.meta.id,
    status: "connected",
    accountLabel,
    scopes: [],
    captureMethod: "fields",
    connectedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

router.post(
  "/:connector/device/start",
  connectorAuthenticationLimit, requireAuthenticatedUid, connectorRateLimit(30), requireActiveAccount,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const def = getConnector(req.params.connector as string);
      if (!def?.device || !def.meta.captureMethods.includes("device")) {
        res.status(404).json({ error: "Unknown connector or device flow not supported" });
        return;
      }
      const clientId = process.env[def.device.clientIdEnv];
      if (!clientId) {
        logger.error(`[connect] ${def.meta.id} unavailable: ${def.device.clientIdEnv} is not set`);
        res.status(503).json({ error: `${def.meta.displayName} connection is not configured` });
        return;
      }

      const resp = await fetch(def.device.codeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ client_id: clientId, scope: def.meta.scopes.join(" ") }),
      });
      if (!resp.ok) {
        throw new Error(`device code request failed: ${resp.status}`);
      }
      const out = (await resp.json()) as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        expires_in: number;
        interval?: number;
      };

      const flowId = crypto.randomUUID();
      await flowsCol().doc(flowId).set({
        uid: req.uid!,
        connector: def.meta.id,
        kind: "device",
        encryptedDeviceCode: await encryptSecret(out.device_code),
        createdAt: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromMillis(Date.now() + out.expires_in * 1000),
      });

      res.json({
        flowId,
        userCode: out.user_code,
        verificationUri: out.verification_uri,
        interval: out.interval ?? 5,
        expiresIn: out.expires_in,
      });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/:connector/device/poll",
  connectorAuthenticationLimit, requireAuthenticatedUid, connectorRateLimit(120), requireActiveAccount,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const def = deviceConnectorDef(req.params.connector as string);
      if (!def) {
        res.status(404).json({ error: "Unknown connector or device flow not supported" });
        return;
      }
      const flowId = deviceFlowId(req.body);
      if (isRouteError(flowId)) {
        sendRouteError(res, flowId);
        return;
      }

      const flow = await readDeviceFlow(req.uid!, def, flowId);
      if (isRouteError(flow)) {
        sendRouteError(res, flow);
        return;
      }

      const clientId = deviceClientId(def);
      if (isRouteError(clientId)) {
        sendRouteError(res, clientId);
        return;
      }

      const out = await pollDeviceToken(def, clientId, await decryptSecret(flow.encryptedDeviceCode));
      res.json(await devicePollResponse(req.uid!, def, flow.ref, out));
    } catch (e) {
      next(e);
    }
  },
);

function deviceConnectorDef(connector: string): DeviceConnectorDef | null {
  const def = getConnector(connector);
  return def?.device ? (def as DeviceConnectorDef) : null;
}

function deviceFlowId(body: unknown): string | RouteError {
  const flowId = ((body ?? {}) as { flowId?: unknown }).flowId;
  return typeof flowId === "string" && flowId
    ? flowId
    : routeError(400, { error: "flowId required" });
}

interface DeviceFlowDoc {
  uid?: string;
  connector?: string;
  kind?: string;
  encryptedDeviceCode?: string;
  consumedAt?: unknown;
}

interface LoadedDeviceFlow {
  ref: FirebaseFirestore.DocumentReference;
  encryptedDeviceCode: string;
}

function isUsableDeviceFlow(
  snap: FirebaseFirestore.DocumentSnapshot,
  flow: DeviceFlowDoc | undefined,
  uid: string,
  def: DeviceConnectorDef,
): flow is DeviceFlowDoc & { encryptedDeviceCode: string } {
  return Boolean(
    snap.exists &&
    flow &&
    flow.uid === uid &&
    flow.connector === def.meta.id &&
    flow.kind === "device" &&
    !flow.consumedAt &&
    typeof flow.encryptedDeviceCode === "string",
  );
}

async function readDeviceFlow(
  uid: string,
  def: DeviceConnectorDef,
  flowId: string,
): Promise<LoadedDeviceFlow | RouteError> {
  const ref = flowsCol().doc(flowId);
  const snap = await ref.get();
  const flow = snap.data() as DeviceFlowDoc | undefined;
  if (!isUsableDeviceFlow(snap, flow, uid, def)) {
    return routeError(404, { error: "flow not found" });
  }
  return { ref, encryptedDeviceCode: flow.encryptedDeviceCode };
}

function deviceClientId(def: DeviceConnectorDef): string | RouteError {
  const clientId = process.env[def.device.clientIdEnv];
  return clientId
    ? clientId
    : routeError(503, { error: `${def.meta.displayName} connection is not configured` });
}

async function pollDeviceToken(
  def: DeviceConnectorDef,
  clientId: string,
  deviceCode: string,
): Promise<TokenResponse & { error?: string }> {
  const resp = await fetch(def.device.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  if (!resp.ok) {
    throw new Error(`device token poll failed: ${resp.status}`);
  }
  return (await resp.json()) as TokenResponse & { error?: string };
}

async function consumeFailedDeviceFlow(
  uid: string,
  def: DeviceConnectorDef,
  ref: FirebaseFirestore.DocumentReference,
  reason: string,
): Promise<{ status: "failed"; reason: string }> {
  await ref.set({ consumedAt: FieldValue.serverTimestamp() }, { merge: true });
  logger.warn(`[connect] ${def.meta.id} device flow failed for uid=${uid}: ${reason}`);
  return { status: "failed", reason };
}

async function devicePollResponse(
  uid: string,
  def: DeviceConnectorDef,
  ref: FirebaseFirestore.DocumentReference,
  out: TokenResponse & { error?: string },
): Promise<
  | { status: "pending" }
  | { status: "failed"; reason: string }
  | { status: "connected"; accountLabel: string }
> {
  if (out.error === "authorization_pending" || out.error === "slow_down") {
    return { status: "pending" };
  }
  if (out.error || !out.access_token) {
    return consumeFailedDeviceFlow(uid, def, ref, out.error ?? "no_access_token");
  }

  const identity = await def.fetchIdentity(out.access_token);
  await storeConnectorTokens({
    uid,
    def,
    tokens: out,
    accountLabel: identity.accountLabel,
    captureMethod: "device",
  });
  await ref.set({ consumedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { status: "connected", accountLabel: identity.accountLabel };
}

export default router;
