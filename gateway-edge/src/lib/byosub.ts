import { userDefaultAgentId } from "@octogee/core/byosub-onboarding";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import { deriveCodexAuthHealth } from "@octogee/core/codex-auth-health";
import { internalFetch } from "./internal-fetch.js";

export { userDefaultAgentId };

export function byosubSecretName(uid: string, provider: string): string {
  return `byosub-${uid}-${provider}`;
}

export function isSafeGatewayId(id: unknown): id is string {
  return isValidGatewayId(id);
}

const MAX_CREDENTIAL_BYTES = 32_768;

function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0;
}

export function validateCodexCredential(
  raw: string,
): { ok: true } | { ok: false; reason: string } {
  if (!raw || !raw.trim()) return { ok: false, reason: "empty payload" };
  if (raw.length > MAX_CREDENTIAL_BYTES) {
    return { ok: false, reason: "payload too large" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not a JSON object" };
  }
  const o = parsed as Record<string, unknown>;
  if (!nonEmptyString(o.auth_mode)) {
    return { ok: false, reason: "missing auth_mode" };
  }
  if (!o.tokens || typeof o.tokens !== "object") {
    return { ok: false, reason: "missing tokens object" };
  }
  const t = o.tokens as Record<string, unknown>;
  if (!nonEmptyString(t.access_token)) {
    return { ok: false, reason: "missing tokens.access_token" };
  }
  if (!nonEmptyString(t.refresh_token)) {
    return { ok: false, reason: "missing tokens.refresh_token" };
  }
  return { ok: true };
}

// The Claude SUBSCRIPTION token from `claude setup-token` — a single long-lived
// bearer (sk-ant-oat…). NOT an API key (sk-ant-api…): the oat prefix is what
// distinguishes the subscription from a BYOT key, and routing them differently
// matters (sub → claude-cli runtime, key → anthropic api_key profile).
const CLAUDE_OAT_PREFIX = "sk-ant-oat";
type CredentialValidation = { ok: true } | { ok: false; reason: string };

export function validateClaudeCliToken(
  raw: string,
): CredentialValidation {
  const token = (raw ?? "").trim();
  if (!token) return { ok: false, reason: "empty token" };
  if (token.length > MAX_CREDENTIAL_BYTES) {
    return { ok: false, reason: "token too large" };
  }
  if (!token.startsWith(CLAUDE_OAT_PREFIX)) {
    return {
      ok: false,
      reason:
        "not a Claude subscription token — expected an sk-ant-oat… token from `claude setup-token`",
    };
  }
  return { ok: true };
}

export function validateClaudeCliCredential(
  raw: string,
): CredentialValidation {
  const credential = (raw ?? "").trim();
  if (!credential) return { ok: false, reason: "empty credential" };
  if (credential.length > MAX_CREDENTIAL_BYTES) {
    return { ok: false, reason: "credential too large" };
  }
  if (!credential.startsWith("{")) return validateClaudeCliToken(credential);
  return validateClaudeSsoCredentialJson(credential);
}

function validateClaudeSsoCredentialJson(credential: string): CredentialValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential);
  } catch {
    return { ok: false, reason: "Claude SSO credential is not valid JSON" };
  }
  return validateClaudeSsoCredentialObject(parsed);
}

function validateClaudeSsoCredentialObject(parsed: unknown): CredentialValidation {
  const oauth = (parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) {
    return { ok: false, reason: "missing claudeAiOauth object" };
  }
  const fields = oauth as Record<string, unknown>;
  if (typeof fields.accessToken !== "string" || !fields.accessToken) {
    return { ok: false, reason: "missing claudeAiOauth.accessToken" };
  }
  if (typeof fields.refreshToken !== "string" || !fields.refreshToken) {
    return { ok: false, reason: "missing claudeAiOauth.refreshToken" };
  }
  if (
    typeof fields.expiresAt !== "number" ||
    !Number.isFinite(fields.expiresAt) ||
    fields.expiresAt <= 0
  ) {
    return { ok: false, reason: "invalid claudeAiOauth.expiresAt" };
  }
  return { ok: true };
}

export type ByosubProvider = "openai" | "anthropic";
export type ByosubStatus = "connected" | "needs_reauth";
export type ByosubModelCredentialProvider = "openai-codex" | "claude-cli";
const BYOSUB_PROVIDERS: ByosubProvider[] = ["openai", "anthropic"];

export function modelCredentialProviderForByosubProvider(
  provider: ByosubProvider,
): ByosubModelCredentialProvider {
  return provider === "anthropic" ? "claude-cli" : "openai-codex";
}

export interface ByosubProviderConnectionView {
  connected: boolean;
  provider: ByosubProvider;
  status: ByosubStatus;
  modelCredentialProvider: ByosubModelCredentialProvider;
}

export interface ByosubConnectionView {
  connected: boolean;
  providers: Partial<Record<ByosubProvider, ByosubProviderConnectionView>>;
}

export function byosubConnectionView(
  ref: { providers?: unknown } | null | undefined,
): ByosubConnectionView {
  const providers =
    ref?.providers && typeof ref.providers === "object"
      ? (ref.providers as Record<string, unknown>)
      : null;
  if (!providers) {
    return { connected: false, providers: {} };
  }
  const view: Partial<Record<ByosubProvider, ByosubProviderConnectionView>> = {};
  for (const provider of BYOSUB_PROVIDERS) {
    const raw = providers[provider];
    if (
      !raw ||
      typeof raw !== "object" ||
      (raw as { provider?: unknown }).provider !== provider
    ) {
      continue;
    }
    const status: ByosubStatus =
      (raw as { status?: unknown }).status === "needs_reauth" ? "needs_reauth" : "connected";
    view[provider] = {
      connected: status === "connected",
      provider,
      status,
      modelCredentialProvider: modelCredentialProviderForByosubProvider(provider),
    };
  }
  return {
    connected: Object.values(view).some((provider) => provider.connected),
    providers: view,
  };
}

// The DEEP byosub health: byosubConnectionView reads only the Firestore ref
// (the "a credential was provisioned" pointer), which survives a reroll/
// relocation whether or not the destination pod actually re-materialized a
// working credential. This crosses that expectation with pod REALITY — is the
// auth-profile store actually present on this pod, and does codex consider it
// alive — so a silent boot-sync materialization failure surfaces as `missing`
// instead of a false `connected`. Used by /api/g/<gatewayId>/byosub/health on the user's
// own pod (the durability harness's real proof) and to fix the product
// false-"connected" the ref-only read can't catch.
export type ByosubHealthStatus =
  | "healthy"
  | "needs_reauth"
  | "missing"
  | "not_connected"
  | "not_on_this_pod";

export interface ByosubHealthView {
  connected: boolean;
  status: ByosubHealthStatus;
  provider?: string;
}

export function deriveByosubHealth(input: {
  mountedHere: boolean;
  refProvider: string | null;
  storePresent: boolean;
  profileExpiresAt?: number | null;
  authStateText: string | null;
  profileId: string;
  now: number;
}): ByosubHealthView {
  if (!input.mountedHere) return { connected: false, status: "not_on_this_pod" };
  if (!input.refProvider) return { connected: false, status: "not_connected" };
  if (!input.storePresent) {
    return { connected: false, status: "missing", provider: input.refProvider };
  }
  if (
    typeof input.profileExpiresAt === "number" &&
    Number.isFinite(input.profileExpiresAt) &&
    input.profileExpiresAt <= input.now
  ) {
    return { connected: false, status: "needs_reauth", provider: input.refProvider };
  }
  const health = deriveCodexAuthHealth(input.authStateText, input.profileId, input.now);
  if (health === "needs_reauth") {
    return { connected: false, status: "needs_reauth", provider: input.refProvider };
  }
  return { connected: true, status: "healthy", provider: input.refProvider };
}

export interface DeviceAuthStart {
  flowId: string;
  verificationUrl: string;
  userCode: string;
  expiresInMinutes: number | null;
}
export interface DeviceAuthStatus {
  state: string;
  expiresInMinutes?: number;
}
export interface GatewayDeviceAuthClient {
  start(args: { gatewayId: string; agentId: string }): Promise<DeviceAuthStart>;
  status(args: { gatewayId: string; flowId: string }): Promise<DeviceAuthStatus>;
}

export interface ClaudeSsoStart {
  flowId: string;
  verificationUrl: string;
  expiresInMinutes: number | null;
  state: string;
}
export interface ClaudeSsoStatus {
  state: string;
  expiresInMinutes?: number;
  reason?: string;
}
export interface GatewayClaudeSsoClient {
  start(args: { gatewayId: string; agentId: string }): Promise<ClaudeSsoStart>;
  status(args: { gatewayId: string; flowId: string }): Promise<ClaudeSsoStatus>;
  submit(args: { gatewayId: string; flowId: string; code: string }): Promise<ClaudeSsoStatus>;
}

function octogeeApiBrokerBase(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.FLEET_BROKER_URL || env.OCTOGEE_API_URL;
  if (!base) {
    throw new Error("FLEET_BROKER_URL or OCTOGEE_API_URL is required to broker the byosub flow");
  }
  let trimmed = base;
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

// Record the subscription flow owner mapping through octogee-api on the gateway's own
// KSA identity (internalFetch attaches the projected SA token). Cattle pods are
// datastore.viewer — they can READ Firestore (resolveUserGateway/readFlow) but
// not WRITE, so the one write in the connect flow brokers here.
export async function brokerByosubFlow(args: {
  flowId: string;
  agentId: string;
  provider: string;
}): Promise<void> {
  const r = await internalFetch(
    `${octogeeApiBrokerBase()}/internal/byok/byosub-flow`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    },
    {},
  );
  if (!r.ok) {
    throw new Error(`byosub-flow broker ${r.status} ${await r.text().catch(() => "")}`);
  }
}

function gatewayInternalBase(gatewayId: string): string {
  const localGatewayId = process.env.GATEWAY_ID?.trim();
  if (!localGatewayId || gatewayId !== localGatewayId) {
    throw new Error("Subscription auth must run on the assigned gateway");
  }
  return `http://127.0.0.1:${process.env.FLEET_CONTROLLER_PORT?.trim() || "3003"}`;
}

async function gatewayInternalCall<T>(
  gatewayId: string,
  path: string,
  init: RequestInit,
): Promise<T> {
  const r = await internalFetch(`${gatewayInternalBase(gatewayId)}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  }, {
    internalServiceKey:
      process.env.OPENCLAW_GATEWAY_TOKEN ?? process.env.INTERNAL_SERVICE_KEY ?? "",
  });
  if (!r.ok) {
    throw new Error(`gateway ${r.status} ${await r.text().catch(() => "")}`);
  }
  return (await r.json()) as T;
}

export function gatewayDeviceAuthClient(): GatewayDeviceAuthClient {
  return {
    start: ({ gatewayId, agentId }) =>
      gatewayInternalCall(gatewayId, "/internal/byosub/device-auth/start", {
        method: "POST",
        body: JSON.stringify({ agentId }),
      }),
    status: ({ gatewayId, flowId }) =>
      gatewayInternalCall(
        gatewayId,
        `/internal/byosub/device-auth/status/${encodeURIComponent(flowId)}`,
        { method: "GET" },
      ),
  };
}

export function gatewayClaudeSsoClient(): GatewayClaudeSsoClient {
  return {
    start: ({ gatewayId, agentId }) =>
      gatewayInternalCall(gatewayId, "/internal/byosub/claude-sso/start", {
        method: "POST",
        body: JSON.stringify({ agentId }),
      }),
    status: ({ gatewayId, flowId }) =>
      gatewayInternalCall(
        gatewayId,
        `/internal/byosub/claude-sso/status/${encodeURIComponent(flowId)}`,
        { method: "GET" },
      ),
    submit: ({ gatewayId, flowId, code }) =>
      gatewayInternalCall(gatewayId, "/internal/byosub/claude-sso/submit", {
        method: "POST",
        body: JSON.stringify({ flowId, code }),
      }),
  };
}
