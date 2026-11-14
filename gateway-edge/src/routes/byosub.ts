import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import * as fs from "fs";
import * as os from "os";
import { FieldValue, type DocumentSnapshot } from "firebase-admin/firestore";
import { requireAuth, requireInternalServiceAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";
import { platformStateStore } from "../lib/platform-state.js";
import type { UserActivationLease, PlatformUserRecord } from "@octogee/core/platform-state";
import {
  deleteSecret,
  writeSecret,
  addSecretVersionIfExists,
} from "@octogee/core/secret-store";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { accountActiveInStore, userDataWithUserState } from "../lib/user-platform-state.js";
import {
  byosubSecretName,
  validateCodexCredential,
  validateClaudeCliCredential,
  validateClaudeCliToken,
  userDefaultAgentId,
  byosubConnectionView,
  isSafeGatewayId,
  type ByosubProvider,
} from "../lib/byosub.js";
import { resolveUserGateway, rosteredAgentIdsForSlug } from "../lib/user-gateway.js";
import {
  claudeCliNativeCredentialsPath,
  codexAgentDir,
  codexAuthJsonPath,
  isSafeAgentId,
} from "@octogee/core/byosub-restore";
import {
  deleteAuthProfileStore,
  readAuthProfileStore,
  writeAuthProfileStore,
} from "@octogee/core/auth-profile-store";
import {
  CLAUDE_CLI_DEFAULT_PROFILE_ID,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
} from "@octogee/core/model-credential-materializer";
import { triggerGatewayModelCredentialSync } from "../lib/byot-sync-trigger.js";
import { pinSubscriptionModelAround, retargetSubscriptionModelPicks } from "../lib/subscription-model-pins.js";
import {
  claudeCliRuntimeConfig,
  codexRuntimeConfig,
} from "@octogee/core/model-credential-materializer";
import { logger } from "../middleware/logging.js";
import {
  modelCredentialOAuthState,
  modelCredentialOAuthEntryByProviderId,
  modelCredentialOAuthEntryBySubscriptionProvider,
  resolveUserByosubCredentialRefs,
  type ModelCredentialOAuthCatalogEntry,
  type ModelCredentialOAuthProviderId,
} from "@octogee/shared/types/model-credentials";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import { readGatewayAuthorizationInStore } from "@octogee/core/gateway-live-release";

const router = Router();
const BYOSUB_PROVIDER_ORDER: ByosubProvider[] = ["openai", "anthropic"];

type SubscriptionRuntimeState = "ready" | "paused" | "activating" | "shared" | "unavailable";

function activationIsPending(lease: UserActivationLease | null): boolean {
  const status = lease?.status;
  return status === "requested" || status === "provisioning" || status === "activating" || status === "returning";
}

async function subscriptionRuntimeFor(
  uid: string,
  resolved: { gatewayId: string },
): Promise<SubscriptionRuntimeState> {
  const [authorization, userRecord] = await Promise.all([
    readGatewayAuthorizationInStore(platformStateStore, resolved.gatewayId),
    platformStateStore.users.records.get(uid),
  ]);
  if (authorization?.kind !== "durable" || !userRecord) return "unavailable";
  if (authorization.config.gatewayClass !== "shared") {
    return authorization.gateway.desiredStatus === "paused" ? "paused" : "ready";
  }
  return activationIsPending(userRecord.activationLease) ? "activating" : "shared";
}

async function hasReadySubscriptionRuntime(
  uid: string,
  resolved: { gatewayId: string },
): Promise<boolean> {
  return await subscriptionRuntimeFor(uid, resolved) === "ready";
}

async function hasPrivateSubscriptionGateway(gatewayId: string): Promise<boolean> {
  const authorization = await readGatewayAuthorizationInStore(platformStateStore, gatewayId);
  return authorization?.kind === "durable" && authorization.config.gatewayClass !== "shared";
}

function providerEntryFromSubscriptionProvider(provider: unknown): ModelCredentialOAuthCatalogEntry | null {
  return typeof provider === "string"
    ? modelCredentialOAuthEntryBySubscriptionProvider(provider)
    : null;
}

function providerSetFromUserIntegration(data: unknown): Record<string, unknown> | null {
  const providers = (data as { providers?: unknown } | null | undefined)?.providers;
  return providers && typeof providers === "object" ? (providers as Record<string, unknown>) : null;
}

function isConnectedProvider(
  providers: Record<string, unknown>,
  provider: ByosubProvider,
): boolean {
  const raw = providers[provider];
  if (!raw || typeof raw !== "object") return false;
  const ref = raw as Record<string, unknown>;
  return ref.provider === provider && ref.connected === true && ref.status === "connected";
}

function firstRemainingConnectedProvider(
  providers: Record<string, unknown> | null,
  removedProvider: ByosubProvider,
): {
  provider: ByosubProvider;
  entry: ModelCredentialOAuthCatalogEntry;
} | null {
  if (!providers) return null;
  for (const provider of BYOSUB_PROVIDER_ORDER) {
    if (provider === removedProvider) continue;
    if (!isConnectedProvider(providers, provider)) continue;
    const entry = modelCredentialOAuthEntryBySubscriptionProvider(provider);
    if (!entry) continue;
    return { provider, entry };
  }
  return null;
}

function userIntegrationConnectionView(data: unknown) {
  const providers = providerSetFromUserIntegration(data);
  if (!providers) return byosubConnectionView(undefined);
  const visible: Record<string, unknown> = {};
  for (const provider of BYOSUB_PROVIDER_ORDER) {
    const raw = providers[provider];
    if (!raw || typeof raw !== "object") continue;
    const ref = raw as Record<string, unknown>;
    if (ref.provider !== provider) continue;
    if (ref.status === "needs_reauth" || (ref.status === "connected" && ref.connected === true)) {
      visible[provider] = ref;
    }
  }
  return byosubConnectionView({ providers: visible });
}

interface FlowDoc {
  uid: string;
  gatewayId: string;
  agentId: string;
  provider: string;
  modelCredentialProvider?: string;
  consumedAt?: number;
  expireAt?: number;
  captureClaimId?: string;
}

async function readFlow(flowId: string): Promise<FlowDoc | null> {
  const snap = await db.collection("byosubFlows").doc(flowId).get();
  if (!snap.exists) return null;
  return (snap.data() || null) as FlowDoc | null;
}

function agentBelongsToUser(userRecord: PlatformUserRecord, agentId: string): boolean {
  return userRecord.openclaw.agentId === agentId ||
    userRecord.agents.agentIds.includes(agentId) ||
    (userRecord.slug !== null && userDefaultAgentId(userRecord.slug) === agentId);
}

async function findGatewayUserByAgentId(gatewayId: string, agentId: string): Promise<string | null> {
  const userRecords = await platformStateStore.users.records.listByGateway(gatewayId);
  return userRecords.find((userRecord) => agentBelongsToUser(userRecord, agentId))?.uid ?? null;
}

function requestGatewayMatchesBinding(req: Request, gatewayId: string): boolean {
  const bound = (req as Request & { boundTenant?: { kind?: unknown; gatewayId?: unknown } }).boundTenant;
  return bound?.kind === "gateway" && bound.gatewayId === gatewayId;
}

function oauthEntryFromFlow(flow: FlowDoc): ModelCredentialOAuthCatalogEntry | null {
  if (flow.modelCredentialProvider) {
    try {
      return modelCredentialOAuthEntryByProviderId(
        flow.modelCredentialProvider as ModelCredentialOAuthProviderId,
      );
    } catch {
      return null;
    }
  }
  return modelCredentialOAuthEntryBySubscriptionProvider(flow.provider);
}

function validateCredentialForEntry(
  entry: ModelCredentialOAuthCatalogEntry,
  credential: string,
): { ok: true } | { ok: false; reason: string } {
  return entry.id === "claude-cli"
    ? validateClaudeCliCredential(credential)
    : validateCodexCredential(credential);
}

router.get(
  "/connection",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const resolved = await resolveUserGateway(req.uid!);
      if (!resolved) {
        res.json({ connected: false, providers: {} });
        return;
      }
      const [snap, runtime] = await Promise.all([
        db
          .collection("users")
          .doc(req.uid!)
          .collection("integrations")
          .doc("byosub")
          .get(),
        subscriptionRuntimeFor(req.uid!, resolved),
      ]);

      // gatewayId lets the client target the sidecar locality seam
      // (/api/g/<gatewayId>/byosub/*) for the connect/status/submit flow.
      res.json({
        ...userIntegrationConnectionView(snap.data()),
        gatewayId: resolved.gatewayId,
        runtime,
      });
    } catch (e) {
      next(e);
    }
  },
);

// signalProvider is the PROVIDERS-registry key byot-sync reads to drive
// materialization + the default-agent-model patch: "openai-codex" for ChatGPT Plus,
// "claude-cli" for a Claude subscription.
async function flipUnifiedByosSignal(
  uid: string,
  signalProvider: ModelCredentialOAuthProviderId,
  secretName: string,
  agentIds: readonly string[] = [],
): Promise<void> {
  const addedAt = FieldValue.serverTimestamp();
  await pinSubscriptionModelAround(platformStateStore.users, {
    uid,
    agentIds,
    model: subscriptionDefaultModel(signalProvider),
  }, () => writeUnifiedByosSignal(uid, signalProvider, secretName, addedAt));
}

async function writeUnifiedByosSignal(
  uid: string,
  signalProvider: ModelCredentialOAuthProviderId,
  secretName: string,
  addedAt: FieldValue,
): Promise<void> {
  await db
    .collection("users")
    .doc(uid)
    .collection("system")
    .doc("config")
    .set(
      {
        byot: {
          provider: signalProvider,
          secretName: FieldValue.delete(),
          fingerprint: FieldValue.delete(),
          keyHash: FieldValue.delete(),
          status: FieldValue.delete(),
          addedAt: FieldValue.delete(),
          lastUsedAt: FieldValue.delete(),
          baseUrl: FieldValue.delete(),
          model: FieldValue.delete(),
        },
        modelCredential: {
          ...modelCredentialOAuthState({
            provider: signalProvider,
            secretName,
            addedAt,
          }),
          fingerprint: FieldValue.delete(),
          keyHash: FieldValue.delete(),
          baseUrl: FieldValue.delete(),
          model: FieldValue.delete(),
        },
      },
      { merge: true },
    );
  await db.collection("users").doc(uid).set({ byotActive: true }, { merge: true });
}

function slugFromManagedAgentId(agentId: string): string | null {
  const prefix = "octogee-";
  const suffix = "-coach";
  if (!agentId.startsWith(prefix) || !agentId.endsWith(suffix)) return null;
  return agentId.slice(prefix.length, -suffix.length);
}

function triggerUnifiedByosSync(args: {
  gatewayId: string;
  slug: string;
  provider: ModelCredentialOAuthProviderId;
}): void {
  triggerGatewayModelCredentialSync({
    gatewayId: args.gatewayId,
    userData: {
      byotActive: true,
      username: args.slug,
      planInputs: {},
      provisioning: { openclaw: { status: "complete" } },
      systemConfig: { byot: { provider: args.provider } },
    },
  });
}

function triggerUnifiedByosOffSync(req: Request, resolved: { gatewayId: string; slug: string }): void {
  const user = (req.user ?? {}) as Record<string, unknown>;
  triggerGatewayModelCredentialSync({
    gatewayId: resolved.gatewayId,
    userData: {
      byotActive: false,
      username: resolved.slug,
      provisioning: { openclaw: { status: "complete" } },
      ...userEntitlements().previousImageFields("model-credential-push", user),
      planInputs: userEntitlements().pickInputs(user),
    },
  });
}

function triggerUnifiedByosSyncForFlow(
  flow: FlowDoc,
  provider: ModelCredentialOAuthProviderId,
): void {
  const slug = slugFromManagedAgentId(flow.agentId);
  if (!slug) {
    logger.warn(`BYOS sync trigger skipped for malformed agentId=${flow.agentId}`);
    return;
  }
  triggerUnifiedByosSync({ gatewayId: flow.gatewayId, slug, provider });
}

async function writeByosubIntegration(args: {
  uid: string;
  provider: ByosubProvider;
  modelCredentialProvider: ModelCredentialOAuthProviderId;
  status: string;
  connected: boolean;
  summaryConnected?: boolean;
  gatewayId?: string;
  flowId?: string;
  reason?: string;
}): Promise<void> {
  const providerLeaf = {
    provider: args.provider,
    modelCredentialProvider: args.modelCredentialProvider,
    status: args.status,
    connected: args.connected,
    ...(args.gatewayId ? { gatewayId: args.gatewayId } : { gatewayId: FieldValue.delete() }),
    ...(args.flowId ? { flowId: args.flowId } : { flowId: FieldValue.delete() }),
    ...(args.reason ? { reason: args.reason } : { reason: FieldValue.delete() }),
  };
  await db
    .collection("users")
    .doc(args.uid)
    .collection("integrations")
    .doc("byosub")
    .set(
      {
        connected: args.summaryConnected ?? args.connected,
        ...(args.gatewayId ? { gatewayId: args.gatewayId } : {}),
        providers: { [args.provider]: providerLeaf },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

function subscriptionDefaultModel(modelCredentialProvider: string): string | null {
  if (modelCredentialProvider === "openai-codex") return codexRuntimeConfig().model;
  if (modelCredentialProvider === "claude-cli") return claudeCliRuntimeConfig().model;
  return null;
}

function flowUnchangedForCommit(flow: FlowDoc, current: FlowDoc | undefined, captureClaimId: string | undefined): boolean {
  if (current === undefined) return false;
  if (current.uid !== flow.uid || current.gatewayId !== flow.gatewayId || current.agentId !== flow.agentId) return false;
  return captureClaimId
    ? current.consumedAt === undefined && current.captureClaimId === captureClaimId
    : Boolean(current.consumedAt);
}

async function commitByosubCapture(args: {
  flowId: string;
  flow: FlowDoc;
  provider: ByosubProvider;
  modelCredentialProvider: ModelCredentialOAuthProviderId;
  secretName: string;
  captureClaimId?: string;
}): Promise<void> {
  const ownerRef = db.collection("users").doc(args.flow.uid);
  const configRef = ownerRef.collection("system").doc("config");
  const integrationRef = ownerRef.collection("integrations").doc("byosub");
  const flowRef = db.collection("byosubFlows").doc(args.flowId);
  const addedAt = FieldValue.serverTimestamp();
  const agentIds = await captureAgentIds(args.flow, await ownerRef.get());
  await pinSubscriptionModelAround(platformStateStore.users, {
    uid: args.flow.uid,
    agentIds,
    model: subscriptionDefaultModel(args.modelCredentialProvider),
  }, () => db.runTransaction(async (tx) => {
    const [owner, currentFlowSnap] = await Promise.all([
      tx.get(ownerRef),
      tx.get(flowRef),
    ]);
    const currentFlow = currentFlowSnap.data() as FlowDoc | undefined;
    if (!flowUnchangedForCommit(args.flow, currentFlow, args.captureClaimId)) {
      throw new Error("BYOS credential flow changed before commit");
    }
    if (!sameAgentIds(await captureAgentIds(args.flow, owner), agentIds)) {
      throw new Error("BYOS credential owner's agents changed before commit");
    }
    tx.set(configRef, {
      byot: {
        provider: args.modelCredentialProvider,
        secretName: FieldValue.delete(),
        fingerprint: FieldValue.delete(),
        keyHash: FieldValue.delete(),
        status: FieldValue.delete(),
        addedAt: FieldValue.delete(),
        lastUsedAt: FieldValue.delete(),
        baseUrl: FieldValue.delete(),
        model: FieldValue.delete(),
      },
      modelCredential: {
        ...modelCredentialOAuthState({
          provider: args.modelCredentialProvider,
          secretName: args.secretName,
          addedAt,
        }),
        fingerprint: FieldValue.delete(),
        keyHash: FieldValue.delete(),
        baseUrl: FieldValue.delete(),
        model: FieldValue.delete(),
      },
    }, { merge: true });
    tx.set(ownerRef, { byotActive: true }, { merge: true });
    tx.set(integrationRef, {
      connected: true,
      gatewayId: args.flow.gatewayId,
      providers: {
        [args.provider]: {
          provider: args.provider,
          modelCredentialProvider: args.modelCredentialProvider,
          status: "connected",
          connected: true,
          gatewayId: args.flow.gatewayId,
          flowId: args.flowId,
          reason: FieldValue.delete(),
        },
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (!args.flow.consumedAt) {
      tx.set(flowRef, {
        consumedAt: Date.now(),
        captureClaimId: FieldValue.delete(),
        captureClaimedAt: FieldValue.delete(),
      }, { merge: true });
    }
  }));
}

async function captureAgentIds(flow: FlowDoc, owner: DocumentSnapshot): Promise<readonly string[]> {
  const userRecord = await platformStateStore.users.records.get(flow.uid);
  const ownerData = owner.exists ? userDataWithUserState(owner.data() ?? {}, userRecord) : undefined;
  if (!ownerData || !accountAllowsInteractiveAccess(ownerData)) {
    throw new Error("BYOS credential owner is not active");
  }
  const slug = slugFromManagedAgentId(flow.agentId);
  return slug ? rosteredAgentIdsForSlug(ownerData, slug) : [flow.agentId];
}

function sameAgentIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((agentId) => right.includes(agentId));
}

async function claimByosubCapture(flowId: string, flow: FlowDoc): Promise<string> {
  const claimId = randomUUID();
  const ownerRef = db.collection("users").doc(flow.uid);
  const flowRef = db.collection("byosubFlows").doc(flowId);
  await db.runTransaction(async (tx) => {
    const [owner, currentFlowSnap, ownerActive] = await Promise.all([
      tx.get(ownerRef),
      tx.get(flowRef),
      accountActiveInStore(flow.uid),
    ]);
    const currentFlow = currentFlowSnap.data() as FlowDoc | undefined;
    if (!owner.exists || !ownerActive) {
      throw new Error("BYOS credential owner is not active");
    }
    if (
      !currentFlowSnap.exists ||
      !currentFlow ||
      currentFlow.uid !== flow.uid ||
      currentFlow.gatewayId !== flow.gatewayId ||
      currentFlow.agentId !== flow.agentId ||
      currentFlow.consumedAt ||
      currentFlow.captureClaimId
    ) {
      throw new Error("BYOS credential flow is not claimable");
    }
    tx.set(flowRef, {
      captureClaimId: claimId,
      captureClaimedAt: Date.now(),
    }, { merge: true });
  });
  return claimId;
}

interface ResolvedUserGateway {
  gatewayId: string;
  slug: string;
  agentIds: string[];
}

interface RemainingByosubProvider {
  provider: ByosubProvider;
  entry: ModelCredentialOAuthCatalogEntry;
}

async function disconnectProviderFromUserIntegration(
  uid: string,
  provider: ByosubProvider,
): Promise<{ clearUserSignal: boolean; remainingProvider: RemainingByosubProvider | null }> {
  const snap = await db
    .collection("users")
    .doc(uid)
    .collection("integrations")
    .doc("byosub")
    .get();
  const remaining = firstRemainingConnectedProvider(providerSetFromUserIntegration(snap.data()), provider);
  return {
    clearUserSignal: !remaining,
    remainingProvider: remaining ? { provider: remaining.provider, entry: remaining.entry } : null,
  };
}

async function clearUserByosubSignal(uid: string): Promise<void> {
  await db.collection("users").doc(uid).set({ byotActive: false }, { merge: true });
  await db
    .collection("users")
    .doc(uid)
    .collection("system")
    .doc("config")
    .set(
      {
        byot: FieldValue.delete(),
        modelCredential: FieldValue.delete(),
      },
      { merge: true },
    );
}

async function retargetSubscriptionModels(
  uid: string,
  from: ModelCredentialOAuthProviderId,
  to: ModelCredentialOAuthProviderId | null,
): Promise<void> {
  const fromModel = subscriptionDefaultModel(from);
  if (!fromModel) return;
  await retargetSubscriptionModelPicks(platformStateStore.users, {
    uid,
    fromModel,
    toModel: to ? subscriptionDefaultModel(to) : null,
  });
}

async function applyRemainingByosubSignal(
  uid: string,
  resolved: ResolvedUserGateway,
  remainingProvider: RemainingByosubProvider,
): Promise<void> {
  await flipUnifiedByosSignal(
    uid,
    remainingProvider.entry.id,
    byosubSecretName(uid, remainingProvider.provider),
  );
  triggerUnifiedByosSync({
    gatewayId: resolved.gatewayId,
    slug: resolved.slug,
    provider: remainingProvider.entry.id,
  });
}

function localOpenclawDir(): string {
  return process.env.OPENCLAW_DIR || "/home/node/.openclaw";
}

async function removeAuthProfile(agentDir: string, profileId: string): Promise<void> {
  const store = await readAuthProfileStore(agentDir);
  const profiles = (store as { profiles?: unknown } | null)?.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return;
  if (!Object.prototype.hasOwnProperty.call(profiles, profileId)) return;
  const nextProfiles = { ...(profiles as Record<string, unknown>) };
  delete nextProfiles[profileId];
  if (Object.keys(nextProfiles).length === 0) {
    await deleteAuthProfileStore(agentDir);
    return;
  }
  await writeAuthProfileStore(agentDir, { ...(store as Record<string, unknown>), profiles: nextProfiles });
}

async function cleanupGeneratedByosubCredentials(provider: ByosubProvider, agentId: string): Promise<void> {
  const ocDir = localOpenclawDir();
  const agentDir = codexAgentDir(ocDir, agentId);
  if (provider === "openai") {
    fs.rmSync(codexAuthJsonPath(ocDir, agentId), { force: true });
    await removeAuthProfile(agentDir, OPENAI_CODEX_DEFAULT_PROFILE_ID);
    return;
  }
  await removeAuthProfile(agentDir, CLAUDE_CLI_DEFAULT_PROFILE_ID);
  fs.rmSync(claudeCliNativeCredentialsPath(os.homedir()), { force: true });
}

async function cleanupGeneratedByosubCredentialsBestEffort(
  provider: ByosubProvider,
  agentId: string,
): Promise<void> {
  try {
    await cleanupGeneratedByosubCredentials(provider, agentId);
  } catch (err) {
    logger.warn(
      `[byosub] generated credential cleanup failed provider=${provider} agentId=${agentId}: ${(err as Error).message}`,
    );
  }
}

// #1141 — let the user clear a connected BYOS credential. The inverse
// of /capture's unified-signal flip + user integration write. The
// Secret Manager secret is intentionally NOT destroyed (disconnect-only,
// not full-wipe); a future re-Connect rewrites a fresh version under the
// same owner-scoped name, so no orphan secret and no doubled-up cred.
// Idempotent end-state: clearing already-clear docs is a safe no-op.
router.post(
  "/disconnect",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.uid!;
      const b = (req.body || {}) as { provider?: unknown };
      const entry = providerEntryFromSubscriptionProvider(b.provider);
      if (!entry) {
        res.status(400).json({ error: "supported provider required" });
        return;
      }
      const provider = entry.oauth.secretProvider as ByosubProvider;
      const resolved = await resolveUserGateway(uid);
      const { clearUserSignal, remainingProvider } = await disconnectProviderFromUserIntegration(uid, provider);
      if (resolved) {
        for (const agentId of resolved.agentIds) {
          await cleanupGeneratedByosubCredentialsBestEffort(provider, agentId);
        }
      }
      if (resolved && clearUserSignal) triggerUnifiedByosOffSync(req, resolved);

      if (clearUserSignal) {
        await clearUserByosubSignal(uid);
      } else if (remainingProvider && resolved) {
        await applyRemainingByosubSignal(uid, resolved, remainingProvider);
      }
      await retargetSubscriptionModels(uid, entry.id, remainingProvider?.entry.id ?? null);
      await writeByosubIntegration({
        uid,
        provider,
        modelCredentialProvider: entry.id,
        status: "disconnected",
        connected: false,
        summaryConnected: !clearUserSignal,
        ...(resolved ? { gatewayId: resolved.gatewayId } : {}),
      });

      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

// Claude SUBSCRIPTION capture — paste-token, no device-auth ceremony. The user
// runs `claude setup-token` themselves and pastes the bearer here; we validate,
// store it owner-scoped in Secret Manager, write the user integration, and flip the
// unified BYOS signal to claude-cli. The pod's byot-sync watcher reacts to the
// signal: materializes the per-agent claude-cli store from SM and patches the
// agent model to the subscription's default on the customer's own plan. User-authed (the
// token is provided directly), unlike codex's internal /capture callback.
router.post(
  "/token",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.uid!;
      const b = (req.body || {}) as { provider?: string; token?: string };
      const provider = String(b.provider ?? "anthropic");
      const entry = modelCredentialOAuthEntryBySubscriptionProvider(provider);
      if (entry?.id !== "claude-cli") {
        res.status(400).json({
          error: `Unsupported subscription provider: ${provider}`,
          supported: ["anthropic"],
        });
        return;
      }
      if (typeof b.token !== "string") {
        res.status(400).json({ error: "token required" });
        return;
      }
      const v = validateClaudeCliToken(b.token);
      if (!v.ok) {
        res.status(400).json({ error: `invalid token: ${v.reason}` });
        return;
      }
      const resolved = await resolveUserGateway(uid);
      if (!resolved) {
        res.status(400).json({ error: "No provisioned workspace/gateway for this user" });
        return;
      }
      if (!await hasReadySubscriptionRuntime(uid, resolved)) {
        res.status(409).json({
          code: "subscription-runtime-required",
          error: "A private isolated runtime is required before connecting a personal subscription",
        });
        return;
      }
      const secretName = byosubSecretName(uid, entry.oauth.secretProvider);
      await writeSecret({
        name: secretName,
        value: b.token.trim(),
        labels: { byosub: "true", provider: entry.oauth.secretProvider },
      });
      await flipUnifiedByosSignal(uid, entry.id, secretName, resolved.agentIds);
      await writeByosubIntegration({
        uid,
        provider: entry.oauth.subscriptionProvider,
        modelCredentialProvider: entry.id,
        status: "connected",
        connected: true,
        gatewayId: resolved.gatewayId,
      });
      triggerUnifiedByosSync({
        gatewayId: resolved.gatewayId,
        slug: resolved.slug,
        provider: entry.id,
      });
      res.json({ ok: true, secretName });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/capture",
  requireInternalServiceAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = (req.body ?? {}) as { flowId?: unknown; credential?: unknown };
      if (typeof b.flowId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(b.flowId) || typeof b.credential !== "string") {
        res.status(400).json({ error: "flowId and credential required" });
        return;
      }
      const flow = await readFlow(b.flowId);
      if (!flow) {
        res.status(400).json({ error: "unknown flow" });
        return;
      }
      if (!requestGatewayMatchesBinding(req, flow.gatewayId)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      if (!await hasPrivateSubscriptionGateway(flow.gatewayId)) {
        res.status(409).json({
          code: "subscription-runtime-required",
          error: "A private isolated runtime is required before connecting a personal subscription",
        });
        return;
      }
      const entry = oauthEntryFromFlow(flow);
      if (!entry) {
        res
          .status(400)
          .json({ error: `Unsupported provider: ${flow.provider}` });
        return;
      }
      const signalProvider = entry.id;
      const secretProvider = entry.oauth.secretProvider;
      const secretName = byosubSecretName(flow.uid, secretProvider);

      if (flow.consumedAt) {
        await commitByosubCapture({
          flowId: b.flowId,
          flow,
          provider: secretProvider,
          modelCredentialProvider: signalProvider,
          secretName,
        });
        triggerUnifiedByosSyncForFlow(flow, signalProvider);
        res.json({ ok: true, secretName, alreadyConsumed: true });
        return;
      }
      const v = validateCredentialForEntry(entry, b.credential);
      if (!v.ok) {
        res.status(400).json({ error: `invalid credential: ${v.reason}` });
        return;
      }
      const captureClaimId = await claimByosubCapture(b.flowId, flow);
      await writeSecret({
        name: secretName,
        value: b.credential,
        labels: { byosub: "true", provider: secretProvider },
      });
      try {
        await commitByosubCapture({
          flowId: b.flowId,
          flow,
          provider: secretProvider,
          modelCredentialProvider: signalProvider,
          secretName,
          captureClaimId,
        });
      } catch (error) {
        try {
          await deleteSecret(secretName);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "BYOS credential commit and compensating deletion failed",
          );
        }
        throw error;
      }
      triggerUnifiedByosSyncForFlow(flow, signalProvider);
      res.json({ ok: true, secretName });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/auth-state",
  requireInternalServiceAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = (req.body || {}) as {
        gatewayId?: string;
        agentId?: string;
        provider?: string;
        state?: string;
      };
      const entry = providerEntryFromSubscriptionProvider(b.provider);
      if (
        !isSafeGatewayId(b.gatewayId) ||
        !b.agentId ||
        !isSafeAgentId(b.agentId) ||
        !entry ||
        b.state !== "needs_reauth"
      ) {
        res.status(400).json({
          error:
            "path-safe gatewayId, path-safe agentId, supported provider, state:'needs_reauth' required",
        });
        return;
      }
      if (!requestGatewayMatchesBinding(req, b.gatewayId)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const provider = entry.oauth.secretProvider as ByosubProvider;
      const assignedUid = await findGatewayUserByAgentId(b.gatewayId, b.agentId);
      if (!assignedUid) {
        res.json({ ok: true, noop: true });
        return;
      }
      const integrationSnap = await db
        .collection("users")
        .doc(assignedUid)
        .collection("integrations")
        .doc("byosub")
        .get();
      const providers = providerSetFromUserIntegration(integrationSnap.data());
      if (!providers || !isConnectedProvider(providers, provider)) {
        res.json({ ok: true, noop: true });
        return;
      }
      const updatedProviders = {
        ...providers,
        [provider]: { ...(providers[provider] as Record<string, unknown>), status: "needs_reauth", connected: false },
      };
      await writeByosubIntegration({
        uid: assignedUid,
        provider,
        modelCredentialProvider: entry.id,
        status: "needs_reauth",
        connected: false,
        summaryConnected: userIntegrationConnectionView({ providers: updatedProviders }).connected,
        gatewayId: b.gatewayId,
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/sync-back",
  requireInternalServiceAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = (req.body || {}) as {
        gatewayId?: string;
        agentId?: string;
        provider?: string;
        credential?: string;
      };
      if (
        !isSafeGatewayId(b.gatewayId) ||
        !b.agentId ||
        !isSafeAgentId(b.agentId) ||
        b.provider !== "openai" ||
        typeof b.credential !== "string"
      ) {
        res.status(400).json({
          error:
            "path-safe gatewayId, path-safe agentId, provider:'openai', credential string required",
        });
        return;
      }
      const v = validateCodexCredential(b.credential);
      if (!v.ok) {
        res.status(400).json({ error: `invalid credential: ${v.reason}` });
        return;
      }
      if (!requestGatewayMatchesBinding(req, b.gatewayId)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const assignedUid = await findGatewayUserByAgentId(b.gatewayId, b.agentId);
      if (!assignedUid) {
        res.json({ ok: true, noop: true });
        return;
      }
      const integrationSnap = await db
        .collection("users")
        .doc(assignedUid)
        .collection("integrations")
        .doc("byosub")
        .get();
      const ref = resolveUserByosubCredentialRefs(assignedUid, integrationSnap.data()).refs.find(
        (candidate) => candidate.provider === "openai",
      );
      if (!ref) {
        res.json({ ok: true, noop: true });
        return;
      }

      const w = await addSecretVersionIfExists(ref.secretName, b.credential);
      if (!w.ok) {
        res.json({ ok: true, noop: true });
        return;
      }
      res.json({ ok: true, secretName: ref.secretName });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
