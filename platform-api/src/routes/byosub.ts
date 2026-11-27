import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import * as fs from "fs";
import * as os from "os";
import { requireAuth, requireInternalServiceAuth } from "@octogee/core/http/auth";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import type {
  ModelCredentialInput,
  PlatformStateTransaction,
  PlatformUserRecord,
  SubscriptionFlowRecord,
  SubscriptionLinkStatus,
  UserActivationLease,
} from "@octogee/core/platform-state";
import { readSubscriptionIntegration, subscriptionIntegration } from "@octogee/core/model-credential-records";
import {
  deleteSecret,
  writeSecret,
  addSecretVersionIfExists,
} from "@octogee/core/secret-store";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import {
  byosubSecretName,
  validateCodexCredential,
  validateClaudeCliCredential,
  validateClaudeCliToken,
  userDefaultAgentId,
  byosubConnectionView,
  isSafeGatewayId,
  type ByosubProvider,
} from "@octogee/core/model-credentials/byosub";
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
import { pinSubscriptionModel, pinUnpickedSubscriptionModel, retargetSubscriptionModelPicks, SubscriptionModelPinError } from "../lib/subscription-model-pins.js";
import {
  claudeCliRuntimeConfig,
  codexRuntimeConfig,
} from "@octogee/core/model-credential-materializer";
import { logger } from "@octogee/core/http/logging";
import {
  modelCredentialOAuthEntryByProviderId,
  modelCredentialOAuthEntryBySubscriptionProvider,
  resolveUserByosubCredentialRefs,
  type ModelCredentialOAuthCatalogEntry,
  type ModelCredentialOAuthProviderId,
} from "@octogee/shared/types/model-credentials";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import { readGatewayAuthorizationInStore } from "@octogee/core/gateway-live-release";

const router: Router = Router();
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

type FlowDoc = SubscriptionFlowRecord;

async function readFlow(flowId: string): Promise<FlowDoc | null> {
  return platformStateStore.users.subscriptionFlows.get(flowId);
}

function ownerAllowsInteractiveAccess(user: PlatformUserRecord | null): boolean {
  return user !== null && accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle ?? undefined });
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
      const [integration, runtime] = await Promise.all([
        readSubscriptionIntegration(platformStateStore.users, req.uid!),
        subscriptionRuntimeFor(req.uid!, resolved),
      ]);

      // gatewayId lets the client target the sidecar locality seam
      // (/api/g/<gatewayId>/byosub/*) for the connect/status/submit flow.
      res.json({
        ...userIntegrationConnectionView(integration),
        gatewayId: resolved.gatewayId,
        runtime,
      });
    } catch (e) {
      next(e);
    }
  },
);

function oauthModelCredential(
  uid: string,
  provider: ModelCredentialOAuthProviderId,
  secretName: string,
): ModelCredentialInput {
  return {
    uid,
    active: true,
    provider,
    mode: "oauth",
    status: "active",
    reasonCode: "ok",
    secretName,
    fingerprint: null,
    keyHash: null,
    baseUrl: null,
    model: null,
    addedAt: { serverNow: true },
    lastUsedAt: null,
  };
}

async function flipUnifiedByosSignal(
  uid: string,
  signalProvider: ModelCredentialOAuthProviderId,
  secretName: string,
): Promise<void> {
  await platformStateStore.users.modelCredentials.put(oauthModelCredential(uid, signalProvider, secretName));
}

async function pinFailure(
  uid: string,
  provider: ModelCredentialOAuthProviderId,
  agentIds: readonly string[],
  pin: typeof pinSubscriptionModel = pinSubscriptionModel,
): Promise<SubscriptionModelPinError | null> {
  try {
    await pin(platformStateStore.users, { uid, agentIds, model: subscriptionDefaultModel(provider) });
    return null;
  } catch (error) {
    if (error instanceof SubscriptionModelPinError) return error;
    throw error;
  }
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

interface SubscriptionLinkWrite {
  uid: string;
  provider: ByosubProvider;
  modelCredentialProvider: ModelCredentialOAuthProviderId;
  status: SubscriptionLinkStatus;
  gatewayId?: string;
  flowId?: string;
  reason?: string;
}

function subscriptionLink(args: SubscriptionLinkWrite) {
  return {
    uid: args.uid,
    provider: args.provider,
    modelCredentialProvider: args.modelCredentialProvider,
    status: args.status,
    gatewayId: args.gatewayId ?? null,
    flowId: args.flowId ?? null,
    reason: args.reason ?? null,
    updatedAt: { serverNow: true },
  } as const;
}

async function writeByosubIntegration(args: SubscriptionLinkWrite): Promise<void> {
  await platformStateStore.users.subscriptionLinks.put(subscriptionLink(args));
}

function subscriptionDefaultModel(modelCredentialProvider: string): string | null {
  if (modelCredentialProvider === "openai-codex") return codexRuntimeConfig().model;
  if (modelCredentialProvider === "claude-cli") return claudeCliRuntimeConfig().model;
  return null;
}

function sameFlowOwner(flow: FlowDoc, current: FlowDoc | null): current is FlowDoc {
  return current !== null && current.uid === flow.uid && current.gatewayId === flow.gatewayId && current.agentId === flow.agentId;
}

function flowUnchangedForCommit(flow: FlowDoc, current: FlowDoc | null, captureClaimId: string | undefined): boolean {
  if (!sameFlowOwner(flow, current)) return false;
  return captureClaimId
    ? current.consumedAt === null && current.captureClaimId === captureClaimId
    : current.consumedAt !== null;
}

async function commitByosubCapture(args: {
  flowId: string;
  flow: FlowDoc;
  provider: ByosubProvider;
  modelCredentialProvider: ModelCredentialOAuthProviderId;
  secretName: string;
  captureClaimId?: string;
}): Promise<readonly string[]> {
  return platformStateStore.transaction({ label: "byosub.capture.commit" }, async (tx: PlatformStateTransaction) => {
    const [currentFlow, owner] = await Promise.all([
      tx.users.subscriptionFlows.get(args.flowId),
      tx.users.records.get(args.flow.uid),
    ]);
    if (!owner || !ownerAllowsInteractiveAccess(owner)) {
      throw new Error("BYOS credential owner is not active");
    }
    if (!flowUnchangedForCommit(args.flow, currentFlow, args.captureClaimId)) {
      throw new Error("BYOS credential flow changed before commit");
    }
    const slug = slugFromManagedAgentId(args.flow.agentId);
    const agentIds = slug
      ? rosteredAgentIdsForSlug({ provisioning: { openclaw: { agentIds: owner.agents.agentIds } } }, slug)
      : [args.flow.agentId];
    await tx.users.modelCredentials.put(oauthModelCredential(args.flow.uid, args.modelCredentialProvider, args.secretName));
    await tx.users.subscriptionLinks.put(subscriptionLink({
      uid: args.flow.uid,
      provider: args.provider,
      modelCredentialProvider: args.modelCredentialProvider,
      status: "connected",
      gatewayId: args.flow.gatewayId,
      flowId: args.flowId,
    }));
    if (args.flow.consumedAt === null) {
      await tx.users.subscriptionFlows.update(args.flowId, {
        consumedAt: Date.now(),
        captureClaimId: null,
        captureClaimedAt: null,
      });
    }
    return agentIds;
  });
}

async function recordModelPinned(flowId: string): Promise<void> {
  await platformStateStore.users.subscriptionFlows.update(flowId, { modelPinnedAt: Date.now() });
}

async function pinAndRecord(
  flowId: string,
  uid: string,
  provider: ModelCredentialOAuthProviderId,
  agentIds: readonly string[],
  pin: typeof pinSubscriptionModel,
): Promise<SubscriptionModelPinError | null> {
  const unpinned = await pinFailure(uid, provider, agentIds, pin);
  if (!unpinned) await recordModelPinned(flowId);
  return unpinned;
}

async function replayConsumedCapture(args: {
  flowId: string;
  flow: FlowDoc;
  provider: ByosubProvider;
  modelCredentialProvider: ModelCredentialOAuthProviderId;
  secretName: string;
}): Promise<void> {
  const agentIds = await commitByosubCapture(args);
  const unpinned = args.flow.modelPinnedAt
    ? null
    : await pinAndRecord(args.flowId, args.flow.uid, args.modelCredentialProvider, agentIds, pinUnpickedSubscriptionModel);
  triggerUnifiedByosSyncForFlow(args.flow, args.modelCredentialProvider);
  if (unpinned) throw unpinned;
}

async function claimByosubCapture(flowId: string, flow: FlowDoc): Promise<string> {
  const claimId = randomUUID();
  await platformStateStore.transaction({ label: "byosub.capture.claim" }, async (tx: PlatformStateTransaction) => {
    const [currentFlow, owner] = await Promise.all([
      tx.users.subscriptionFlows.get(flowId),
      tx.users.records.get(flow.uid),
    ]);
    if (!ownerAllowsInteractiveAccess(owner)) {
      throw new Error("BYOS credential owner is not active");
    }
    if (!sameFlowOwner(flow, currentFlow) || currentFlow.consumedAt !== null || currentFlow.captureClaimId !== null) {
      throw new Error("BYOS credential flow is not claimable");
    }
    await tx.users.subscriptionFlows.update(flowId, {
      captureClaimId: claimId,
      captureClaimedAt: Date.now(),
    });
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
  const integration = await readSubscriptionIntegration(platformStateStore.users, uid);
  const remaining = firstRemainingConnectedProvider(providerSetFromUserIntegration(integration), provider);
  return {
    clearUserSignal: !remaining,
    remainingProvider: remaining ? { provider: remaining.provider, entry: remaining.entry } : null,
  };
}

async function clearUserByosubSignal(uid: string): Promise<void> {
  await platformStateStore.users.modelCredentials.delete(uid);
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
      await flipUnifiedByosSignal(uid, entry.id, secretName);
      const unpinned = await pinFailure(uid, entry.id, resolved.agentIds);
      await writeByosubIntegration({
        uid,
        provider: entry.oauth.subscriptionProvider,
        modelCredentialProvider: entry.id,
        status: "connected",
        gatewayId: resolved.gatewayId,
      });
      triggerUnifiedByosSync({
        gatewayId: resolved.gatewayId,
        slug: resolved.slug,
        provider: entry.id,
      });
      if (unpinned) throw unpinned;
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
        await replayConsumedCapture({
          flowId: b.flowId,
          flow,
          provider: secretProvider,
          modelCredentialProvider: signalProvider,
          secretName,
        });
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
      let agentIds: readonly string[];
      try {
        agentIds = await commitByosubCapture({
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
      const unpinned = await pinAndRecord(b.flowId, flow.uid, signalProvider, agentIds, pinSubscriptionModel);
      triggerUnifiedByosSyncForFlow(flow, signalProvider);
      if (unpinned) throw unpinned;
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
        observedAt?: unknown;
      };
      const entry = providerEntryFromSubscriptionProvider(b.provider);
      if (
        !isSafeGatewayId(b.gatewayId) ||
        !b.agentId ||
        !isSafeAgentId(b.agentId) ||
        !entry ||
        b.state !== "needs_reauth" ||
        typeof b.observedAt !== "number" ||
        !Number.isFinite(b.observedAt)
      ) {
        res.status(400).json({
          error:
            "path-safe gatewayId, path-safe agentId, supported provider, state:'needs_reauth', numeric observedAt required",
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
      const links = await platformStateStore.users.subscriptionLinks.list(assignedUid);
      const providers = providerSetFromUserIntegration(subscriptionIntegration(links));
      const link = links.find((candidate) => candidate.provider === provider);
      if (!providers || !isConnectedProvider(providers, provider) || !link || link.updatedAt >= b.observedAt) {
        res.json({ ok: true, noop: true });
        return;
      }
      await writeByosubIntegration({
        uid: assignedUid,
        provider,
        modelCredentialProvider: entry.id,
        status: "needs_reauth",
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
      const integration = await readSubscriptionIntegration(platformStateStore.users, assignedUid);
      const ref = resolveUserByosubCredentialRefs(assignedUid, integration).refs.find(
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
