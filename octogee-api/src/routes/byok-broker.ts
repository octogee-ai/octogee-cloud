import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import { Router, type Request, type Response } from "express";
import {
  MODEL_CREDENTIAL_STATIC_PROVIDER_IDS,
  modelCredentialOAuthEntryBySubscriptionProvider,
  resolveUserByosubCredentialRefs,
} from "@octogee/shared/types/model-credentials";
import { parseAgentId } from "@octogee/shared/types/identity";

import { readSecret, addSecretVersionKeepingLatest, type SubscriptionSecretVersionResult } from "@octogee/core/secret-store";
import { isSafeAgentId } from "@octogee/core/byosub-restore";
import { readGatewayAuthorizationInStore } from "@octogee/core/gateway-live-release";
import type { UserAccount, UserAccountReader } from "@octogee/core/user-account";
import type { PlatformUserRecord, PlatformStateRepositories, PlatformStateStore } from "@octogee/core/platform-state";
import { userEntitlements, type UserPolicy } from "@octogee/shared/types/user-entitlements";
import {
  spendWindowPercentUsed,
  MODEL_BROKER_USAGE_WINDOW_MS,
  MODEL_BROKER_WEEK_WINDOW_MS,
  usageWindowStartMs,
  weekWindowStartMs,
} from "@octogee/shared/types/model-broker-usage";
import {
  createModelBrokerTokenStore,
  type ModelBrokerProvider,
  type ModelBrokerTokenPurpose,
} from "../lib/model-broker-tokens.js";
import {
  envDefaultModelBrokerLimits,
  resolveOwnerModelBrokerGrant,
} from "../lib/model-broker-limits.js";
import { operatorRailRegistry, type ModelBrokerRailRegistry } from "../lib/model-broker-rails.js";
import {
  agentModelTokenIssueKey,
  createAgentModelTokenIssueCoordinator,
} from "../lib/agent-model-token-issue-coordinator.js";
import { findRunningOutboundMigrationUserByAgentId } from "../lib/agent-model-token-migration-admission.js";
import { userAllowsInteractiveAccess, requireUserAccount } from "../lib/assigned-user.js";
import {
  configuredUserSlugCredentialBootstrapAllowed,
  findAssignedOrInboundMigratingOrConfiguredUserByAgentId,
  findAssignedUserByAgentId,
} from "./fleet-broker.js";
import {
  createOwnerWorkspaceTurnVerifier,
  createAgentSupportTurnVerifier,
  type OwnerWorkspaceTurnVerifier,
} from "../lib/openclaw-owner-turn.js";
import { NO_BROKER_RECORDS, type BrokerRecords, type ByosubRecords } from "../lib/broker-records.js";
import type { ModelBrokerUsageLedger } from "../lib/model-broker-usage.js";
import type { FlowGatewayReader } from "../middleware/tenant-enforcement.js";
import { logger } from "../../../gateway-edge/src/middleware/logging.js";

export function byosubFlowGatewayReader(byosub: Pick<ByosubRecords, "readFlow">): FlowGatewayReader {
  return async (flowId) => {
    const gatewayId = (await byosub.readFlow(flowId))?.gatewayId;
    return typeof gatewayId === "string" ? gatewayId : null;
  };
}

type GatewayBinding = Extract<
  Express.Request["boundTenant"],
  { kind: "gateway" }
>;

const FORBIDDEN = { error: "forbidden" } as const;
const VALID_AGENT_ID_REQUIRED = { error: "valid agentId required" } as const;
const UNSUPPORTED_PROVIDER = { error: "unsupported provider" } as const;
const UNSUPPORTED_PURPOSE = { error: "unsupported token purpose" } as const;
export const BYOK_API_KEY_PROVIDER_IDS = [
  ...MODEL_CREDENTIAL_STATIC_PROVIDER_IDS,
];
const BYOK_API_KEY_RE =
  /^byok-(?<body>[a-z0-9][a-z0-9-]{0,128})(?:\/(?<version>[a-zA-Z0-9-]{1,32}))?$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BYOK_API_KEY_PROVIDER_SUFFIXES = BYOK_API_KEY_PROVIDER_IDS.map(
  (provider) => ({ provider, suffix: `-${provider}` }),
).sort((a, b) => b.suffix.length - a.suffix.length);

function parseByokApiKeyId(
  id: string,
): { slug: string; provider: string; version?: string } | null {
  const m = id.match(BYOK_API_KEY_RE);
  const body = m?.groups?.body;
  if (!body) return null;
  const match = BYOK_API_KEY_PROVIDER_SUFFIXES.find(({ suffix }) =>
    body.endsWith(suffix),
  );
  if (!match) return null;
  const slug = body.slice(0, -match.suffix.length);
  if (!SLUG_RE.test(slug)) return null;
  return {
    slug,
    provider: match.provider,
    ...(m.groups?.version ? { version: m.groups.version } : {}),
  };
}

// Per-user broker tokens are re-minted whenever the resolver re-resolves the
// keyRef; a generous TTL spans a normal agent session (so it is not re-minted
// mid-session) while still bounding how long stale tokens linger before TTL cleanup.
const AGENT_MODEL_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const AGENT_EMBEDDING_REQUESTS_PER_MINUTE = 60;

// Mirrors gateway-edge/src/routes/byosub.ts: a byosub OAuth flow is short-lived.
const BYOSUB_FLOW_TTL_MS = 60 * 60 * 1000;
// flowId is a crypto.randomUUID() minted in-pod (claude-sso/device-auth managers);
// pin a path-safe shape so it cannot steer the byosubFlows doc id elsewhere.
const SAFE_FLOW_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const claimed = (req.body as { gatewayId?: unknown } | undefined)?.gatewayId;
  if (
    typeof claimed === "string" &&
    claimed.length > 0 &&
    claimed !== bound.gatewayId
  ) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

function warnSkippedUserByosubProviders(input: {
  gatewayId: string;
  agentId: string;
  uid: string;
  skipped: string[];
}): void {
  if (input.skipped.length === 0) return;
  logger.warn("[byok-broker] skipped malformed user byosub provider", { input });
}


function ownerSlug(userRecord: Pick<PlatformUserRecord, "slug">): string | null {
  return userRecord.slug !== null && SLUG_RE.test(userRecord.slug) ? userRecord.slug : null;
}

function requestedModelProvider(value: unknown): ModelBrokerProvider | null {
  if (value === undefined || value === null || value === "") return "anthropic";
  return value === "anthropic" || value === "vertex" || value === "openrouter" || value === "openai" || value === "meta"
    ? value
    : null;
}

function requestedTokenPurpose(value: unknown): ModelBrokerTokenPurpose | null {
  if (value === undefined || value === null || value === "") return "model";
  return value === "model" || value === "embeddings" ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export type AgentCredentialPath =
  "platform_broker" | "byok_api_key" | "byosub" | "byosub_suppressed_customer";

function credentialPathFor(
  configData: Record<string, unknown>,
  gatewayClass: string,
): { path: AgentCredentialPath; provider: string | null } {
  if (gatewayClass === "shared") return { path: "platform_broker", provider: null };
  const credential =
    configData.modelCredential && typeof configData.modelCredential === "object"
      ? (configData.modelCredential as Record<string, unknown>)
      : null;
  if (credential?.active !== true) return { path: "platform_broker", provider: null };
  const provider = stringOrNull(credential.provider);
  if (credential.mode !== "oauth") return { path: "byok_api_key", provider };
  return gatewayClass === "isolated"
    ? { path: "byosub", provider }
    : { path: "byosub_suppressed_customer", provider };
}

function deriveSpendStatus(input: {
  policy: UserPolicy;
  railId: string;
  rails: ModelBrokerRailRegistry;
  credentialPath: string;
  windowCostUsd: number;
  weekCostUsd: number;
  balanceUsd: number;
}) {
  const { policy, windowCostUsd, weekCostUsd, balanceUsd } = input;
  const onOwnerCredential =
    input.credentialPath === "byok_api_key" || input.credentialPath === "byosub";
  const throttle = input.rails.rail(input.railId).throttle({
    modelAccess: policy.modelAccess,
    windowCostUsd,
    windowBudgetUsd: policy.spendWindowUsd,
    weekCostUsd,
    weekBudgetUsd: policy.spendWeekUsd,
    onOwnerCredential,
    houseFallback: policy.houseFallback,
    balanceUsd,
  });
  return {
    windowCostUsd,
    weekCostUsd,
    onOwnerCredential,
    balanceUsd,
    throttle,
  };
}

interface UsageReaders {
  records: BrokerRecords;
  store: PlatformStateRepositories;
  accounts: UserAccountReader;
  usage: ModelBrokerUsageLedger;
  rails: ModelBrokerRailRegistry;
}

async function agentUsageStatusPayload(
  { records, store, usage, rails }: Pick<UsageReaders, "records" | "store" | "usage" | "rails">,
  gatewayId: string,
  assigned: { uid: string; account: UserAccount },
  nowMs: number,
): Promise<Record<string, unknown>> {
  const windowStartMs = usageWindowStartMs(nowMs);
  const weekStartMs = weekWindowStartMs(nowMs);
  const balanceLedger = rails.balanceLedger(assigned.uid);
  const owner = { gatewayId, ownerUid: assigned.uid, now: nowMs };
  const [authorization, systemConfig, window, week, balanceUsd] =
    await Promise.all([
      readGatewayAuthorizationInStore(store, gatewayId),
      records.userDocuments.systemConfig(assigned.uid),
      usage.readWindowUsage(owner),
      usage.readWeekUsage(owner),
      balanceLedger ? usage.readBalance(balanceLedger) : 0,
    ]);

  const policy = userEntitlements().policy(assigned.account.planInputs, new Date(nowMs));
  const railId = rails.resolveOwnerProfile({ ...assigned.account.planInputs }, assigned.uid, nowMs)?.rail ?? rails.defaultRailId;
  if (!authorization) {
    throw new Error(
      `durable root config unavailable for gateways/${gatewayId}`,
    );
  }
  const credential = credentialPathFor(systemConfig ?? {}, authorization.config.gatewayClass);
  const spend = deriveSpendStatus({
    policy,
    railId,
    rails,
    credentialPath: credential.path,
    windowCostUsd: window.chargeUsd,
    weekCostUsd: week.chargeUsd,
    balanceUsd,
  });

  return {
    ...userEntitlements().productProjection?.agentUsageStatus(assigned.account.planInputs, new Date(nowMs)),
    gatewayClass: authorization.config.gatewayClass,
    week: {
      percentUsed: spend.onOwnerCredential
        ? 0
        : spendWindowPercentUsed(spend.weekCostUsd, policy.spendWeekUsd),
      resetAt: new Date(
        weekStartMs + MODEL_BROKER_WEEK_WINDOW_MS,
      ).toISOString(),
    },
    window: {
      percentUsed: spend.onOwnerCredential
        ? 0
        : spendWindowPercentUsed(spend.windowCostUsd, policy.spendWindowUsd),
      nextRefillAt: new Date(
        windowStartMs + MODEL_BROKER_USAGE_WINDOW_MS,
      ).toISOString(),
      degraded: spend.throttle.degraded,
      blocked: spend.throttle.blocked,
      reason: spend.throttle.reason,
    },
    credits: spend.throttle.balanceVisible ? { balanceUsd: spend.balanceUsd } : null,
    credential,
  };
}

function agentModelTokenSecretName(input: {
  gatewayId: string;
  ownerUid: string;
  provider: ModelBrokerProvider;
  purpose: ModelBrokerTokenPurpose;
}): string {
  if (input.purpose === "embeddings") {
    return `agent-embedding-token-openai-${input.gatewayId}-${input.ownerUid}`;
  }
  const prefix =
    input.provider === "anthropic"
      ? "agent-model-token"
      : `agent-model-token-${input.provider}`;
  return `${prefix}-${input.gatewayId}-${input.ownerUid}`;
}

async function apiKeyCredentialAllowed(
  store: PlatformStateRepositories,
  bound: GatewayBinding,
  slug: string,
): Promise<boolean> {
  const roster = await store.users.records.listByGateway(bound.gatewayId);
  const assigned = roster.some((userRecord) => userRecord.slug === slug) ||
    await configuredUserSlugCredentialBootstrapAllowed(store, bound.gatewayId, bound.podName, slug);
  const authorization = await readGatewayAuthorizationInStore(store, bound.gatewayId);
  return assigned && authorization?.config.gatewayClass === "isolated";
}

async function handleApiKeyCredential(
  store: PlatformStateRepositories,
  readCredentialSecret: (name: string, version?: string) => Promise<string>,
  req: Request,
  res: Response,
): Promise<void> {
  const bound = boundGateway(req, res);
  if (!bound) return;

  const id = (req.body as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string") {
    res.status(400).json({ error: "valid id required" });
    return;
  }
  const parsed = parseByokApiKeyId(id);
  if (!parsed) {
    res.status(400).json({ error: "malformed byok id" });
    return;
  }
  const { slug, provider, version } = parsed;
  if (!await apiKeyCredentialAllowed(store, bound, slug)) {
    res.status(403).json(FORBIDDEN);
    return;
  }

  const value = await readCredentialSecret(
    `byok-${slug}-${provider}`,
    version ?? "latest",
  );
  if (!await apiKeyCredentialAllowed(store, bound, slug)) {
    res.status(403).json(FORBIDDEN);
    return;
  }
  res.json({ value });
}

async function handleByosubCred(input: {
  byosub: ByosubRecords;
  store: PlatformStateRepositories;
  readCredentialSecret: (name: string, version?: string) => Promise<string>;
  gatewayId: string;
  podName: string | undefined;
  agentId: string;
  res: Response;
}): Promise<void> {
  const { byosub, store, readCredentialSecret, gatewayId, podName, agentId, res } = input;
  const authorization = await readGatewayAuthorizationInStore(store, gatewayId);
  if (authorization?.config.gatewayClass !== "isolated") {
    res.status(403).json(FORBIDDEN);
    return;
  }
  const assigned = await findAssignedOrInboundMigratingOrConfiguredUserByAgentId(
    store,
    gatewayId,
    podName,
    agentId,
  );
  if (!assigned) {
    res.status(403).json(FORBIDDEN);
    return;
  }
  const parsed = resolveUserByosubCredentialRefs(assigned.uid, await byosub.readIntegration(assigned.uid));
  if (parsed.refs.length === 0) {
    warnSkippedUserByosubProviders({ gatewayId, agentId, uid: assigned.uid, skipped: parsed.skipped });
    res.status(parsed.skipped.length > 0 ? 500 : 404).json({
      error: parsed.skipped.length > 0 ? "malformed user byosub integration" : "not_found",
    });
    return;
  }
  const credentials = [];
  for (const { provider, secretName } of parsed.refs) {
    credentials.push({ provider, secretName, credential: await readCredentialSecret(secretName) });
  }
  warnSkippedUserByosubProviders({ gatewayId, agentId, uid: assigned.uid, skipped: parsed.skipped });
  res.json({ credentials, ...(parsed.skipped.length > 0 ? { skipped: parsed.skipped } : {}) });
}

const CODEX_CREDENTIAL_MAX_BYTES = 64 * 1024;

function codexLastRefreshMs(credential: string): number | null {
  try {
    const raw = (JSON.parse(credential) as { last_refresh?: unknown } | null)?.last_refresh;
    if (typeof raw !== "string") return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

// A replacement pod can restore version N, then push it after the original pod
// already synced N+1. codex stamps last_refresh on every rotation, so an
// incoming payload refreshed no later than the stored one is dropped.
async function storedCodexCredentialIsNewer(
  readCredentialSecret: (name: string, version?: string) => Promise<string>,
  secretName: string,
  incoming: string,
): Promise<boolean> {
  const incomingMs = codexLastRefreshMs(incoming);
  if (incomingMs === null) return false;
  let stored: string;
  try {
    stored = await readCredentialSecret(secretName);
  } catch {
    return false;
  }
  const storedMs = codexLastRefreshMs(stored);
  return storedMs !== null && storedMs >= incomingMs;
}

function isCodexAuthJson(credential: unknown): credential is string {
  if (typeof credential !== "string" || credential.length === 0 || credential.length > CODEX_CREDENTIAL_MAX_BYTES) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential);
  } catch {
    return false;
  }
  const tokens = (parsed as { tokens?: unknown } | null)?.tokens as
    | { access_token?: unknown; refresh_token?: unknown }
    | undefined;
  return typeof tokens?.access_token === "string" && tokens.access_token.length > 0 &&
    typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0;
}

// A isolated gateway pushes its rotated codex auth.json back so the durable copy
// stays restorable after the VM is replaced. Roster-scoped like /byosub-cred:
// the owner is derived from the assignment, the provider must already be
// connected, and only the codex shape rotates (claude-cli tokens are static).
async function handleByosubCredSyncback(input: {
  byosub: ByosubRecords;
  store: PlatformStateRepositories;
  readCredentialSecret: (name: string, version?: string) => Promise<string>;
  writeByosubCredential: (name: string, value: string) => Promise<SubscriptionSecretVersionResult>;
  gatewayId: string;
  podName: string | undefined;
  body: { agentId?: unknown; provider?: unknown; credential?: unknown };
  res: Response;
}): Promise<void> {
  const { byosub, store, readCredentialSecret, writeByosubCredential, gatewayId, podName, body, res } = input;
  if (typeof body.agentId !== "string" || !isSafeAgentId(body.agentId)) {
    res.status(400).json(VALID_AGENT_ID_REQUIRED);
    return;
  }
  if (body.provider !== "openai") {
    res.status(400).json({ error: "only the openai subscription credential rotates" });
    return;
  }
  if (!isCodexAuthJson(body.credential)) {
    res.status(400).json({ error: "credential must be a codex auth.json with access and refresh tokens" });
    return;
  }
  const authorization = await readGatewayAuthorizationInStore(store, gatewayId);
  if (authorization?.config.gatewayClass !== "isolated") {
    res.status(403).json(FORBIDDEN);
    return;
  }
  const assigned = await findAssignedOrInboundMigratingOrConfiguredUserByAgentId(
    store,
    gatewayId,
    podName,
    body.agentId,
  );
  if (!assigned) {
    res.status(403).json(FORBIDDEN);
    return;
  }
  const ref = resolveUserByosubCredentialRefs(assigned.uid, await byosub.readIntegration(assigned.uid)).refs
    .find((candidate) => candidate.provider === "openai");
  if (!ref) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (await storedCodexCredentialIsNewer(readCredentialSecret, ref.secretName, body.credential)) {
    res.json({ changed: false, destroyed: 0 });
    return;
  }
  const result = await writeByosubCredential(ref.secretName, body.credential);
  if (!result.ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ changed: result.changed, destroyed: result.destroyed });
}

function registerCredentialMaterializationRoutes(
  router: Router,
  byosub: ByosubRecords,
  store: PlatformStateRepositories,
  readCredentialSecret: (name: string, version?: string) => Promise<string>,
  writeByosubCredential: (name: string, value: string) => Promise<SubscriptionSecretVersionResult>,
) {
  router.post("/byosub-cred-syncback", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    await handleByosubCredSyncback({
      byosub,
      store,
      readCredentialSecret,
      writeByosubCredential,
      gatewayId: bound.gatewayId,
      podName: bound.podName,
      body: (req.body ?? {}) as { agentId?: unknown; provider?: unknown; credential?: unknown },
      res,
    });
  });
  router.post("/byosub-cred", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const agentId = (req.body as { agentId?: unknown } | undefined)?.agentId;
    if (typeof agentId !== "string" || !isSafeAgentId(agentId)) {
      res.status(400).json(VALID_AGENT_ID_REQUIRED);
      return;
    }
    await handleByosubCred({
      byosub,
      store,
      readCredentialSecret,
      gatewayId: bound.gatewayId,
      podName: bound.podName,
      agentId,
      res,
    });
  });
  router.post("/api-key", async (req, res) => {
    await handleApiKeyCredential(store, readCredentialSecret, req, res);
  });
}

function registerAgentUsageStatusRoute(
  router: Router,
  readers: UsageReaders,
  now: () => number,
  verifyOwnerWorkspaceTurn: OwnerWorkspaceTurnVerifier,
) {
  router.post("/agent-usage-status", brokerRequestLimit(3600), async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const agentId = (req.body as { agentId?: unknown } | undefined)?.agentId;
    if (typeof agentId !== "string" || !isSafeAgentId(agentId)) {
      res.status(400).json(VALID_AGENT_ID_REQUIRED);
      return;
    }
    if (parseAgentId(agentId).kind !== "coach") {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const assigned =
      await findAssignedOrInboundMigratingOrConfiguredUserByAgentId(
        readers.store,
        bound.gatewayId,
        bound.podName,
        agentId,
      );
    if (!assigned) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    try {
      if (!(await verifyOwnerWorkspaceTurn({
        req,
        gatewayId: bound.gatewayId,
        agentId,
        ownerUid: assigned.uid,
        owner: assigned,
      }))) {
        logger.warn("[byok-broker] rejected unverified owner status turn", {
          gatewayId: bound.gatewayId,
          agentId,
        });
        res.status(403).json(FORBIDDEN);
        return;
      }
    } catch (error) {
      logger.error("[byok-broker] owner status turn verification failed", {
        gatewayId: bound.gatewayId,
        agentId,
        error,
      });
      res.status(403).json(FORBIDDEN);
      return;
    }
    res.json(
      await agentUsageStatusPayload(
        readers,
        bound.gatewayId,
        { uid: assigned.uid, account: await requireUserAccount(readers.accounts, assigned.uid) },
        now(),
      ),
    );
  });
}

async function fundedBudgetInspectionFields(
  readers: Pick<UsageReaders, "usage" | "rails">,
  assigned: { uid: string; account: UserAccount },
  nowMs: number,
): Promise<Record<string, unknown>> {
  const budget = readers.rails.resolveOwnerProfile({ ...assigned.account.planInputs }, assigned.uid, nowMs)?.fundedBudget ?? null;
  if (!budget) return readers.rails.budgetInspection(null, null);
  const ledger = await readers.usage.readFundedBudgetLedger(budget);
  if (!ledger) throw new Error("funded budget accounting unavailable");
  return readers.rails.budgetInspection(budget, ledger);
}

async function privateBrokerInspectionPayload(
  readers: Pick<UsageReaders, "records" | "store" | "usage" | "rails">,
  gatewayId: string,
  assigned: { uid: string; account: UserAccount },
  agentId: string,
  nowMs: number,
): Promise<Record<string, unknown>> {
  const status = await agentUsageStatusPayload(readers, gatewayId, assigned, nowMs);
  const budgetFields = await fundedBudgetInspectionFields(readers, assigned, nowMs);
  return { schemaVersion: 1, agentId, ...status, observedAt: new Date(nowMs).toISOString(), ...budgetFields,
    periods: {
      burst: { kind: "fixed", durationMs: MODEL_BROKER_USAGE_WINDOW_MS, startsAt: new Date(usageWindowStartMs(nowMs)).toISOString(),
        resetAt: new Date(usageWindowStartMs(nowMs) + MODEL_BROKER_USAGE_WINDOW_MS).toISOString() },
      week: { kind: "fixed", durationMs: MODEL_BROKER_WEEK_WINDOW_MS, startsAt: new Date(weekWindowStartMs(nowMs)).toISOString(),
        resetAt: new Date(weekWindowStartMs(nowMs) + MODEL_BROKER_WEEK_WINDOW_MS).toISOString() },
    } };
}

function registerPrivateBrokerInspection(
  router: Router,
  readers: UsageReaders,
  now: () => number,
): void {
  const { store, accounts } = readers;
  const verifyCanonicalOwner = createAgentSupportTurnVerifier(store);
  router.post("/broker-inspect", brokerRequestLimit(3600), async (req, res) => {
    res.setHeader("cache-control", "no-store");
    const bound = boundGateway(req, res);
    if (!bound) return;
    const { agentId, requesterUid } = req.body ?? {};
    if (Object.keys(req.body ?? {}).length !== 2 || typeof agentId !== "string" || !isSafeAgentId(agentId) ||
        typeof requesterUid !== "string" || requesterUid.length === 0 || requesterUid.length > 128) {
      res.status(400).json({ error: "valid agentId and attested requester required" });
      return;
    }
    const authorize = async () => {
      const assigned = await findAssignedOrInboundMigratingOrConfiguredUserByAgentId(store, bound.gatewayId, bound.podName, agentId);
      if (!assigned || assigned.uid !== requesterUid || bound.ownerUid !== undefined && bound.ownerUid !== assigned.uid ||
          !userAllowsInteractiveAccess(assigned) ||
          !await verifyCanonicalOwner({ req, gatewayId: bound.gatewayId, agentId, ownerUid: assigned.uid, owner: assigned })) return null;
      return assigned;
    };
    try {
      const assigned = await authorize();
      if (!assigned) { res.status(403).json(FORBIDDEN); return; }
      const payload = await privateBrokerInspectionPayload(
        readers,
        bound.gatewayId,
        { uid: assigned.uid, account: await requireUserAccount(accounts, assigned.uid) },
        agentId,
        now(),
      );
      if (!await authorize()) { res.status(403).json(FORBIDDEN); return; }
      res.json(payload);
    } catch {
      logger.warn("[byok-broker] private broker inspection unavailable");
      res.status(503).json({ error: "broker inspection unavailable" });
    }
  });
}

function registerByosubUserRoute(router: Router, byosub: ByosubRecords, store: PlatformStateRepositories): void {
  router.post("/byosub-user", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const uid = (req.body as { uid?: unknown } | undefined)?.uid;
    if (typeof uid !== "string" || uid.length === 0 || uid.length > 128) {
      res.status(400).json({ error: "valid uid required" });
      return;
    }
    const userRecord = await store.users.records.get(uid);
    const slug = userRecord ? ownerSlug(userRecord) : null;
    if (
      !userRecord ||
      !userAllowsInteractiveAccess(userRecord) ||
      !slug ||
      userRecord.gateway?.gatewayId !== bound.gatewayId
    ) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const refs = resolveUserByosubCredentialRefs(uid, await byosub.readIntegration(uid)).refs;
    let refProvider: "openai" | "anthropic" | null = null;
    if (refs.some((ref) => ref.provider === "openai")) refProvider = "openai";
    else if (refs.some((ref) => ref.provider === "anthropic")) refProvider = "anthropic";
    res.json({ user: { uid, slug, gatewayId: bound.gatewayId, refProvider } });
  });
}

class AgentModelTokenForbiddenError extends Error {}

function registerAgentModelTokenRoute(
  router: Router,
  store: PlatformStateStore,
  accounts: UserAccountReader,
  now: () => number,
  rails: ModelBrokerRailRegistry,
): void {
  const coordinator = createAgentModelTokenIssueCoordinator({ now });
  const tokenStore = createModelBrokerTokenStore(store);
  router.post("/agent-model-token", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;

    const agentId = (req.body as { agentId?: unknown } | undefined)?.agentId;
    if (typeof agentId !== "string" || !isSafeAgentId(agentId)) {
      res.status(400).json(VALID_AGENT_ID_REQUIRED);
      return;
    }
    const provider = requestedModelProvider(
      (req.body as { provider?: unknown } | undefined)?.provider,
    );
    if (!provider) {
      res.status(400).json(UNSUPPORTED_PROVIDER);
      return;
    }
    const purpose = requestedTokenPurpose(
      (req.body as { purpose?: unknown } | undefined)?.purpose,
    );
    if (!purpose || (purpose === "embeddings" && provider !== "openai")) {
      res.status(400).json(UNSUPPORTED_PURPOSE);
      return;
    }

    const issueKey = agentModelTokenIssueKey({
      gatewayId: bound.gatewayId,
      podName: bound.podName,
      agentId,
      provider,
      purpose,
    });
    try {
      const response = await coordinator.issue(issueKey, async () => {
        const assigned =
          (await findAssignedOrInboundMigratingOrConfiguredUserByAgentId(
            store,
            bound.gatewayId,
            bound.podName,
            agentId,
          )) ??
          (await findRunningOutboundMigrationUserByAgentId(
            store,
            bound.gatewayId,
            agentId,
          ));
        if (!assigned || !userAllowsInteractiveAccess(assigned)) {
          logger.warn("[byok-broker] refused agent model token", {
            gatewayId: bound.gatewayId,
            agentId,
            provider,
            purpose,
            reason: assigned ? "account-not-interactive" : "agent-not-assigned",
            ...(assigned
              ? { uid: assigned.uid, accountLifecycleStatus: assigned.accountLifecycle?.status ?? null }
              : {}),
          });
          throw new AgentModelTokenForbiddenError();
        }
        const grant =
          purpose === "embeddings"
            ? {
                limits: {
                  spendWindowUsd: null,
                  spendWeekUsd: null,
                  requestsPerMinute: AGENT_EMBEDDING_REQUESTS_PER_MINUTE,
                },
                policy: { freeTier: false, houseFallback: true },
              }
            : await resolveOwnerModelBrokerGrant({
                state: store,
                accounts,
                gatewayId: bound.gatewayId,
                ownerUid: assigned.uid,
                now: now(),
                defaults: envDefaultModelBrokerLimits(),
                rails,
              });
        const issued = await tokenStore.issueToken({
          gatewayId: bound.gatewayId,
          ownerUid: assigned.uid,
          provider,
          purpose,
          secretName: agentModelTokenSecretName({
            gatewayId: bound.gatewayId,
            ownerUid: assigned.uid,
            provider,
            purpose,
          }),
          skipPointer: true,
          ttlSeconds: AGENT_MODEL_TOKEN_TTL_SECONDS,
          now: now(),
          limits: grant.limits,
          policy: grant.policy,
          trace: {
            source: "shared_agent_model_token",
            ownerSlug: ownerSlug(assigned),
            agentId,
          },
        });
        if (typeof issued.record.expiresAt !== "number") {
          throw new Error("agent model token was issued without an expiry");
        }
        return {
          value: issued.token,
          expiresAt: issued.record.expiresAt,
          provider,
          purpose,
        };
      });
      res.json(response);
    } catch (error) {
      if (error instanceof AgentModelTokenForbiddenError) {
        res.status(403).json(FORBIDDEN);
        return;
      }
      throw error;
    }
  });
}

export function createByokBrokerRoutes(opts: {
  store: PlatformStateStore;
  records?: BrokerRecords;
  now?: () => number;
  readSecret?: (name: string, version?: string) => Promise<string>;
  writeByosubCredential?: (name: string, value: string) => Promise<SubscriptionSecretVersionResult>;
  verifyOwnerWorkspaceTurn?: OwnerWorkspaceTurnVerifier;
  rails?: ModelBrokerRailRegistry;
}): Router {
  const router = Router();
  const { store } = opts;
  const records = opts.records ?? NO_BROKER_RECORDS;
  const { byosub } = records;
  const now = opts.now ?? Date.now;
  const readCredentialSecret = opts.readSecret ?? readSecret;
  const writeByosubCredential = opts.writeByosubCredential ?? addSecretVersionKeepingLatest;
  const rails = opts.rails ?? operatorRailRegistry();
  const readers: UsageReaders = { records, store, accounts: records.accounts, usage: records.usage, rails };

  registerCredentialMaterializationRoutes(router, byosub, store, readCredentialSecret, writeByosubCredential);
  registerAgentModelTokenRoute(router, store, readers.accounts, now, rails);
  registerPrivateBrokerInspection(router, readers, now);

  registerAgentUsageStatusRoute(
    router,
    readers,
    now,
    opts.verifyOwnerWorkspaceTurn ?? createOwnerWorkspaceTurnVerifier(store),
  );

  // Record a byosub OAuth flow's owner mapping for a agent assigned to
  // this gateway. The sidecar /connect handler starts the in-pod auth flow
  // locally (its OPENCLAW_GATEWAY_TOKEN matches the in-pod manager), then brokers
  // the flowId->owner mapping here because cattle pods have no Firestore. The
  // in-pod /capture callback later reads byosubFlows to persist the captured
  // credential. Roster-scoped via findAssignedUserByAgentId — a gateway can only
  // record flows for a user assigned to it, and the owner uid is DERIVED from
  // the assignment, never trusted from the caller.
  router.post("/byosub-flow", brokerRequestLimit(600), async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;

    const body = (req.body || {}) as {
      flowId?: unknown;
      agentId?: unknown;
      provider?: unknown;
    };
    if (typeof body.agentId !== "string" || !isSafeAgentId(body.agentId)) {
      res.status(400).json(VALID_AGENT_ID_REQUIRED);
      return;
    }
    if (typeof body.flowId !== "string" || !SAFE_FLOW_ID_RE.test(body.flowId)) {
      res.status(400).json({ error: "valid flowId required" });
      return;
    }
    const entry =
      typeof body.provider === "string"
        ? modelCredentialOAuthEntryBySubscriptionProvider(body.provider)
        : null;
    if (!entry) {
      res.status(400).json({
        error: `unsupported subscription provider: ${String(body.provider)}`,
      });
      return;
    }

    const assigned = await findAssignedUserByAgentId(
      store,
      bound.gatewayId,
      body.agentId,
    );
    if (!assigned || !userAllowsInteractiveAccess(assigned)) {
      res.status(403).json(FORBIDDEN);
      return;
    }

    const now = Date.now();
    await byosub.startFlow(body.flowId, {
      uid: assigned.uid,
      gatewayId: bound.gatewayId,
      agentId: body.agentId,
      provider: entry.oauth.subscriptionProvider,
      modelCredentialProvider: entry.id,
      createdAt: now,
      expireAt: now + BYOSUB_FLOW_TTL_MS,
    });
    res.json({ ok: true });
  });

  registerByosubUserRoute(router, byosub, store);

  router.post("/byosub-flow-read", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const flowId = (req.body as { flowId?: unknown } | undefined)?.flowId;
    if (typeof flowId !== "string" || !SAFE_FLOW_ID_RE.test(flowId)) {
      res.status(400).json({ error: "valid flowId required" });
      return;
    }
    const data = await byosub.readFlow(flowId);
    if (
      !data ||
      data.gatewayId !== bound.gatewayId ||
      typeof data.uid !== "string" ||
      typeof data.agentId !== "string" ||
      typeof data.provider !== "string"
    ) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const owner = await store.users.records.get(data.uid);
    if (!owner || !userAllowsInteractiveAccess(owner)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      flow: {
        uid: data.uid,
        gatewayId: data.gatewayId,
        agentId: data.agentId,
        provider: data.provider,
        ...(typeof data.modelCredentialProvider === "string"
          ? { modelCredentialProvider: data.modelCredentialProvider }
          : {}),
      },
    });
  });

  return router;
}
