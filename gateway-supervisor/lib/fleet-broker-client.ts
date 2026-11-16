import { watchFleetAssignments } from "./fleet-assignment-watch.js";
import type {
  FleetBrokerAgentAnchor,
  FleetBrokerAuxiliaryAnchor,
  FleetBrokerAgentAnchorMigration,
  FleetBrokerAgentAnchors,
  FleetBrokerGatewayStateAnchor,
  FleetBrokerAssignmentRosterEntry,
  FleetBrokerBlobSignedUrl,
  FleetBrokerIsolatedRuntimeStatePruneResult,
  FleetBrokerIsolatedRuntimeStateSnapshotUrls,
  BuilderRuntimeStateRecoveryTier,
  FleetBrokerConfiguredUserBootstrap,
  FleetBrokerMattermostUpdate,
  FleetBrokerNpmRegistryCredentials,
  FleetBrokerOpenClawBootClaim,
  FleetBrokerPreStopFlushEvent,
  FleetBrokerProjectAgentReadiness,
  FleetBrokerProvisioningStatus,
  FleetBrokerUsageData,
  FleetBrokerUserSnapshot,
} from "@octogee/shared/types/fleet-broker";
import { isAssignmentState } from "@octogee/shared/types/gateway-releases";
import {
  USER_IDENTITY_ROUTE,
  parseUserIdentity,
  type UserIdentity,
} from "@octogee/shared/types/user-identity";
import { RETIRED_VM_BINDING_DENIAL_REASON } from "@octogee/shared/types/fleet-broker";
import { internalFetch } from "./internal-fetch.js";
import { gatewayCredentialHeaders as defaultGatewayCredentialHeaders } from "@octogee/core/internal-fetch";
import type { SystemConfigObservedStatus } from "./system-config-status.js";
import type { DeveloperToolchainStatus } from "@octogee/shared/types/developer-toolchain";
import type { ServiceProvisioningAnswer } from "@octogee/core/user-lifecycle";

function baseUrl(): string {
  if (process.env.FLEET_BROKER_URL) return process.env.FLEET_BROKER_URL;
  // In-cluster service URL; the projected gateway KSA token is the auth boundary.
  return process.env.OCTOGEE_API_URL || "http://octogee-api.octogee.svc.cluster.local:3001";
}

export class FleetBrokerHttpError extends Error {
  readonly status: number;
  readonly denialReason: string | null;

  constructor(message: string, status: number, denialReason: string | null) {
    super(message);
    this.name = "FleetBrokerHttpError";
    this.status = status;
    this.denialReason = denialReason;
  }
}

const TENANT_DENIAL_PREFIX = "forbidden: ";

function tenantDenialReason(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  return typeof error === "string" && error.startsWith(TENANT_DENIAL_PREFIX)
    ? error.slice(TENANT_DENIAL_PREFIX.length)
    : null;
}

async function brokerHttpError(
  path: string,
  resp: Response,
  redactErrorBody = false,
): Promise<FleetBrokerHttpError> {
  const text = (await resp.text().catch(() => "")).slice(0, 300);
  const message = redactErrorBody
    ? `fleet-broker POST ${path} → ${resp.status}`
    : `fleet-broker POST ${path} → ${resp.status} ${text}`;
  return new FleetBrokerHttpError(
    message,
    resp.status,
    resp.status === 403 ? tenantDenialReason(text) : null,
  );
}

export function isRetiredVmBindingDenial(error: unknown): boolean {
  return error instanceof FleetBrokerHttpError && error.status === 403 &&
    error.denialReason === RETIRED_VM_BINDING_DENIAL_REASON;
}

async function postJson<T>(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  options: { redactErrorBody?: boolean } = {},
): Promise<T> {
  const resp = await internalFetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await brokerHttpError(path, resp, options.redactErrorBody);
  return (await resp.json()) as T;
}

async function postNoContent(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<void> {
  const resp = await internalFetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await brokerHttpError(path, resp);
}

export interface FleetBrokerBlobMaterialization {
  download: FleetBrokerBlobSignedUrl;
  generation: string;
  size: number;
  md5Hash: string;
}

export interface FleetBrokerClient {
  watchAssignments(wake: () => void, log: (message: string) => void): () => void;
  assignedUsers(opts?: { completeOnly?: boolean }): Promise<FleetBrokerUserSnapshot[]>;
  provisionedUserSlugs(): Promise<string[]>;
  assignmentRoster(): Promise<FleetBrokerAssignmentRosterEntry[]>;
  builderIdentity(opts?: { nativeBoot?: true }): Promise<UserIdentity>;
  configuredUserBootstrap(slug: string): Promise<FleetBrokerConfiguredUserBootstrap>;
  npmRegistryCredentials(slug: string): Promise<FleetBrokerNpmRegistryCredentials>;
  uidForSlug(slug: string): Promise<string | null>;
  githubTokenForSync(uid: string): Promise<string | null>;
  userSnapshot(uid: string): Promise<FleetBrokerUserSnapshot | null>;
  reconcileProjectAgentMembership(uid: string): Promise<void>;
  setProvisioningStatus(
    uid: string,
    status: Exclude<FleetBrokerProvisioningStatus, "">,
  ): Promise<void>;
  setToolchainStatus(uid: string, status: DeveloperToolchainStatus): Promise<void>;
  setRepoUrl(uid: string, repoUrl: string): Promise<void>;
  provisionMattermost(uid: string): Promise<FleetBrokerMattermostUpdate>;
  setMattermostFields(uid: string, mmUpdate: FleetBrokerMattermostUpdate): Promise<void>;
  ensureAgentIds(uid: string, agentIds: string[]): Promise<void>;
  setMounted(uid: string, mounted: boolean): Promise<void>;
  reportProjectAgentReadiness(uid: string, projects: FleetBrokerProjectAgentReadiness[]): Promise<void>;
  acknowledgeRuntimeReset(uid: string, operationId: string, generation: number): Promise<void>;
  recordReconcileError(slug: string, message: string): Promise<void>;
  clearReconcileError(slug: string): Promise<void>;
  reportProvisioned(uid: string, report: { first: boolean }): Promise<void>;
  recordUsageEvent(input: {
    agentId: string;
    usage: FleetBrokerUsageData;
  }): Promise<void>;
  recordPreStopFlush(input: FleetBrokerPreStopFlushEvent): Promise<void>;
  recordSystemConfigStatus(input: SystemConfigObservedStatus): Promise<void>;
  blobDownloadUrl(input: {
    slug: string;
    path: string;
  }): Promise<FleetBrokerBlobSignedUrl>;
  blobMaterializationReadUrl(input: { slug: string; path: string; size: number; sha256?: string }): Promise<FleetBrokerBlobMaterialization>;
  blobUploadUrl(input: {
    slug: string;
    path: string;
    mimeType: string;
    size: number;
  }): Promise<FleetBrokerBlobSignedUrl>;
  workspaceManifestReadUrl(input: {
    slug: string;
    projectSlug?: string;
  }): Promise<FleetBrokerBlobSignedUrl>;
  workspaceManifestWriteUrl(input: {
    slug: string;
    ifGenerationMatch: string;
  }): Promise<FleetBrokerBlobSignedUrl>;
  isolatedRuntimeStateDownloadUrl(input: {
    slug: string;
  }): Promise<FleetBrokerBlobSignedUrl>;
  isolatedRuntimeStateSnapshotUrls(input: {
    slug: string;
    size: number;
    recoveryTiers: BuilderRuntimeStateRecoveryTier[];
  }): Promise<FleetBrokerIsolatedRuntimeStateSnapshotUrls>;
  isolatedRuntimeStatePrune(input: {
    slug: string;
  }): Promise<FleetBrokerIsolatedRuntimeStatePruneResult>;
  reportAgentAnchors(input: { slug: string; uid?: string; migration?: FleetBrokerAgentAnchorMigration; assignmentEpoch?: number; assignmentState?: "serving" | "quiescing"; anchors: FleetBrokerAgentAnchor[]; configuredAgentIds: string[]; state?: FleetBrokerGatewayStateAnchor; auxiliary?: FleetBrokerAuxiliaryAnchor[] }): Promise<void>;
  readAgentAnchors(input: { slug: string; uid?: string; migrationId?: string }): Promise<FleetBrokerAgentAnchors>;
  claimOpenClawBoot(input: { releaseKey: string; openclawBuild?: string }): Promise<FleetBrokerOpenClawBootClaim>;
  completeOpenClawBoot(input: { releaseKey: string; openclawBuild?: string }): Promise<void>;
  completeOpenClawDoctor(input: { releaseKey: string; requestId: string; verifiedAgentIds: string[] }): Promise<void>;
  assertOpenClawDoctor(input: { releaseKey: string; requestId: string }): Promise<void>;
  provisioningReadiness(uid: string): Promise<ServiceProvisioningAnswer>;
  registerGitKey(uid: string, publicKey: string): Promise<ServiceProvisioningAnswer>;
  releaseGitKey(uid: string): Promise<void>;
}

export async function resolveGithubTokenForSlug(
  client: Pick<FleetBrokerClient, "uidForSlug" | "githubTokenForSync">,
  slug: string,
): Promise<string | null> {
  const uid = await client.uidForSlug(slug);
  return uid ? client.githubTokenForSync(uid) : null;
}

const DEFAULT_PENDING_RETRY_MS = 5_000;

async function serviceProvisioningAnswer(path: string, body: unknown): Promise<ServiceProvisioningAnswer> {
  const resp = await internalFetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (resp.ok) return { ready: true };
  if (resp.status !== 503 && resp.status !== 422) throw await brokerHttpError(path, resp);
  const text = await resp.text().catch(() => "");
  let answer: { error?: unknown; reason?: unknown } | null = null;
  try {
    answer = JSON.parse(text) as { error?: unknown; reason?: unknown } | null;
  } catch {
    answer = null;
  }
  const reason = typeof answer?.reason === "string" && answer.reason
    ? answer.reason
    : `fleet-broker POST ${path} answered ${resp.status} without a reason`;
  if (resp.status === 422) {
    if (answer?.error !== "provisioning_refused") throw new FleetBrokerHttpError(`fleet-broker POST ${path} → 422 ${text.slice(0, 300)}`, 422, null);
    return { ready: false, refused: true, reason };
  }
  const seconds = Number(resp.headers.get("retry-after"));
  return {
    ready: false,
    reason,
    retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_PENDING_RETRY_MS,
  };
}

function serviceProvisioningClient(
  gatewayId: string,
): Pick<FleetBrokerClient, "provisioningReadiness" | "registerGitKey" | "releaseGitKey"> {
  return {
    provisioningReadiness: (uid) => serviceProvisioningAnswer("/internal/fleet/provisioning-readiness", { gatewayId, uid }),
    registerGitKey: (uid, publicKey) => serviceProvisioningAnswer("/internal/fleet/git-key", { gatewayId, uid, publicKey }),
    releaseGitKey: (uid) => postNoContent("/internal/fleet/git-key/release", { gatewayId, uid }),
  };
}

export interface FleetBrokerClientOptions {
  gatewayCredentialHeaders?: () => Promise<Record<string, string>>;
}

function npmRegistryCredentialClient(
  gatewayId: string,
  gatewayCredentialHeaders: () => Promise<Record<string, string>>,
): Pick<FleetBrokerClient, "npmRegistryCredentials"> {
  return {
    async npmRegistryCredentials(slug) {
      return postJson<FleetBrokerNpmRegistryCredentials>(
        "/internal/fleet/npm-registry-credentials",
        { gatewayId, slug },
        await gatewayCredentialHeaders(),
        { redactErrorBody: true },
      );
    },
  };
}

function isolatedRuntimeStateClient(
  gatewayId: string,
  revisionId: string,
  gatewayCredentialHeaders: () => Promise<Record<string, string>>,
): Pick<
  FleetBrokerClient,
  | "isolatedRuntimeStateDownloadUrl"
  | "isolatedRuntimeStateSnapshotUrls"
  | "isolatedRuntimeStatePrune"
> {
  return {
    async isolatedRuntimeStateDownloadUrl(input) {
      return postJson<FleetBrokerBlobSignedUrl>(
        "/internal/fleet/builder-runtime-state/download-url",
        { gatewayId, revisionId, ...input },
        await gatewayCredentialHeaders(),
      );
    },
    async isolatedRuntimeStateSnapshotUrls(input) {
      return postJson<FleetBrokerIsolatedRuntimeStateSnapshotUrls>(
        "/internal/fleet/builder-runtime-state/snapshot-urls",
        { gatewayId, revisionId, ...input },
        await gatewayCredentialHeaders(),
      );
    },
    async isolatedRuntimeStatePrune(input) {
      return postJson<FleetBrokerIsolatedRuntimeStatePruneResult>(
        "/internal/fleet/builder-runtime-state/prune",
        { gatewayId, revisionId, ...input },
        await gatewayCredentialHeaders(),
      );
    },
  };
}

function agentAnchorClient(
  gatewayId: string,
  revisionId: string,
  gatewayCredentialHeaders: () => Promise<Record<string, string>>,
): Pick<FleetBrokerClient, "reportAgentAnchors" | "readAgentAnchors"> {
  return {
    async reportAgentAnchors(input) {
      await postNoContent("/internal/fleet/agent-anchors/report", { gatewayId, revisionId, ...input }, await gatewayCredentialHeaders());
    },
    async readAgentAnchors(input) {
      return postJson<FleetBrokerAgentAnchors>("/internal/fleet/agent-anchors/read", { gatewayId, revisionId, ...input }, await gatewayCredentialHeaders());
    },
  };
}

function isolatedPodClient(
  gatewayId: string,
  revisionId: string,
  gatewayCredentialHeaders: () => Promise<Record<string, string>>,
) {
  return {
    ...isolatedRuntimeStateClient(gatewayId, revisionId, gatewayCredentialHeaders),
    ...agentAnchorClient(gatewayId, revisionId, gatewayCredentialHeaders),
    ...openClawBootClient(gatewayId, revisionId, gatewayCredentialHeaders),
  };
}

function openClawBootClient(
  gatewayId: string,
  revisionId: string,
  gatewayCredentialHeaders: () => Promise<Record<string, string>>,
): Pick<FleetBrokerClient, "claimOpenClawBoot" | "completeOpenClawBoot" | "completeOpenClawDoctor" | "assertOpenClawDoctor"> {
  return {
    async claimOpenClawBoot(input) {
      return postJson<FleetBrokerOpenClawBootClaim>(
        "/internal/fleet/openclaw-boot/claim",
        { gatewayId, revisionId, ...input },
        await gatewayCredentialHeaders(),
      );
    },
    async completeOpenClawDoctor(input) {
      return postNoContent(
        "/internal/fleet/openclaw-boot/doctor-complete",
        { gatewayId, revisionId, ...input },
        await gatewayCredentialHeaders(),
      );
    },
    async assertOpenClawDoctor(input) {
      return postNoContent("/internal/fleet/openclaw-boot/doctor-current", { gatewayId, revisionId, ...input }, await gatewayCredentialHeaders());
    },
    async completeOpenClawBoot(input) {
      return postNoContent(
        "/internal/fleet/openclaw-boot/healthy",
        { gatewayId, revisionId, ...input },
        await gatewayCredentialHeaders(),
      );
    },
  };
}

async function readUserIdentity(
  gatewayId: string,
  gatewayCredentialHeaders: () => Promise<Record<string, string>>,
  opts?: { nativeBoot?: true },
): Promise<UserIdentity> {
  const data = await postJson<{ identity?: unknown }>(
    USER_IDENTITY_ROUTE,
    { gatewayId, ...opts },
    await gatewayCredentialHeaders(),
  );
  const identity = parseUserIdentity(data.identity, gatewayId);
  if (!identity) throw new Error(`fleet-broker returned a malformed user identity for ${gatewayId}`);
  return identity;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function userSnapshotFromResponse(value: unknown): FleetBrokerUserSnapshot {
  if (!isPlainRecord(value) || !isPlainRecord(value.planInputs)) {
    throw new Error("fleet-broker user snapshot carries no planInputs; the API predates this gateway image");
  }
  if (typeof value.contextTemplateKey !== "string" || value.contextTemplateKey.length === 0) {
    throw new Error("fleet-broker user snapshot carries no contextTemplateKey; the API predates this gateway image");
  }
  if (value.persona !== null && !isPlainRecord(value.persona)) {
    throw new Error("fleet-broker user snapshot carries no persona; the API predates this gateway image");
  }
  return value as unknown as FleetBrokerUserSnapshot;
}

function assignedUserRoster(data: unknown): unknown[] {
  const users = (data as { users?: unknown } | null)?.users;
  if (!Array.isArray(users)) throw new Error("fleet-broker invalid assigned-user roster");
  return users;
}

function userSlugFromResponse(user: unknown): string {
  const slug = isPlainRecord(user) ? user.slug : undefined;
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("fleet-broker assigned-user roster entry carries no slug");
  }
  return slug;
}

function assignedUserClient(
  gatewayId: string,
  revisionId: string,
  gatewayCredentialHeaders: () => Promise<Record<string, string>>,
): Pick<FleetBrokerClient, "assignedUsers" | "provisionedUserSlugs"> {
  const roster = async (completeOnly: boolean) => assignedUserRoster(await postJson<unknown>(
    "/internal/fleet/assigned-users",
    { gatewayId, revisionId, completeOnly },
    await gatewayCredentialHeaders(),
  ));
  return {
    assignedUsers: async (opts = {}) => (await roster(opts.completeOnly === true)).map(userSnapshotFromResponse),
    provisionedUserSlugs: async () => (await roster(true)).map(userSlugFromResponse),
  };
}

function assignmentRosterFromResponse(data: unknown): FleetBrokerAssignmentRosterEntry[] {
  const assignments = (data as { assignments?: unknown } | null)?.assignments;
  if (!Array.isArray(assignments)) throw new Error("fleet-broker invalid assignment roster");
  const seen = new Set<string>();
  return assignments.map((value: unknown) => {
    const row = value as Partial<FleetBrokerAssignmentRosterEntry> | null;
    if (!row || typeof row.uid !== "string" || !row.uid || seen.has(row.uid) ||
        !isAssignmentState(row.state) || typeof row.epoch !== "number" ||
        !Number.isSafeInteger(row.epoch) || row.epoch < 0) {
      throw new Error("fleet-broker invalid assignment roster");
    }
    seen.add(row.uid);
    return { uid: row.uid, state: row.state, epoch: row.epoch };
  });
}

export function createFleetBrokerClient(
  gatewayId: string,
  revisionId = gatewayId,
  opts: FleetBrokerClientOptions = {},
): FleetBrokerClient {
  const gatewayCredentialHeaders = opts.gatewayCredentialHeaders
    ?? defaultGatewayCredentialHeaders;
  return {
    ...npmRegistryCredentialClient(gatewayId, gatewayCredentialHeaders),
    ...serviceProvisioningClient(gatewayId),
    builderIdentity: (opts) => readUserIdentity(gatewayId, gatewayCredentialHeaders, opts),
    watchAssignments: (wake, log) => watchFleetAssignments({
      url: `${baseUrl()}/internal/fleet/assignment-watch`,
      gatewayId, revisionId, headers: gatewayCredentialHeaders, wake, log,
    }),
    ...assignedUserClient(gatewayId, revisionId, gatewayCredentialHeaders),
    async assignmentRoster() {
      return assignmentRosterFromResponse(await postJson<unknown>(
        "/internal/fleet/assignment-roster",
        { gatewayId, revisionId },
        await gatewayCredentialHeaders(),
      ));
    },
    async configuredUserBootstrap(slug) {
      const data = await postJson<{ bootstrap: FleetBrokerConfiguredUserBootstrap }>(
        "/internal/fleet/configured-builder-bootstrap",
        { gatewayId, revisionId, slug },
        await gatewayCredentialHeaders(),
      );
      return data.bootstrap;
    },
    async uidForSlug(slug) {
      try {
        const data = await postJson<{ uid: string }>("/internal/fleet/uid-for-slug", {
          gatewayId,
          slug,
        });
        return data.uid;
      } catch (err) {
        if (err instanceof Error && err.message.includes("→ 404")) return null;
        throw err;
      }
    },
    async githubTokenForSync(uid) {
      const credentialHeaders = await gatewayCredentialHeaders();
      try {
        const data = await postJson<{ accessToken?: unknown }>(
          "/internal/connectors/access-token",
          { gatewayId, uid, connectorId: "github" },
          credentialHeaders,
        );
        return typeof data.accessToken === "string" && data.accessToken ? data.accessToken : null;
      } catch (err) {
        if (
          err instanceof Error
          && ["→ 404", "→ 409", "→ 403"].some((code) => err.message.includes(code))
        ) {
          return null;
        }
        throw err;
      }
    },
    async userSnapshot(uid) {
      try {
        const data = await postJson<{ user?: unknown }>(
          "/internal/fleet/user-snapshot",
          { gatewayId, uid },
          await gatewayCredentialHeaders(),
        );
        return userSnapshotFromResponse(data.user);
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.includes("→ 404") || err.message.includes("→ 403"))
        ) {
          return null;
        }
        throw err;
      }
    },
    reconcileProjectAgentMembership(uid) {
      return postNoContent("/internal/fleet/reconcile-project-coach-membership", {
        gatewayId,
        uid,
      });
    },
    setProvisioningStatus(uid, status) {
      return postNoContent("/internal/fleet/set-provisioning-status", {
        gatewayId,
        uid,
        status,
      });
    },
    setToolchainStatus(uid, status) {
      return postNoContent("/internal/fleet/set-toolchain-status", {
        gatewayId,
        uid,
        status,
      });
    },
    setRepoUrl(uid, repoUrl) {
      return postNoContent("/internal/fleet/set-repo-url", { gatewayId, uid, repoUrl });
    },
    async provisionMattermost(uid) {
      const data = await postJson<{ mmUpdate: FleetBrokerMattermostUpdate }>(
        "/internal/fleet/provision-mattermost",
        { gatewayId, uid },
        await gatewayCredentialHeaders(),
      );
      return data.mmUpdate;
    },
    setMattermostFields(uid, mmUpdate) {
      return postNoContent("/internal/fleet/set-mattermost-fields", {
        gatewayId,
        uid,
        mmUpdate,
      });
    },
    ensureAgentIds(uid, agentIds) {
      return postNoContent("/internal/fleet/set-agent-ids", { gatewayId, uid, agentIds });
    },
    reportProjectAgentReadiness(uid, projects) {
      return postNoContent("/internal/fleet/project-agent-readiness", { gatewayId, uid, projects });
    },
    setMounted(uid, mounted) {
      return postNoContent("/internal/fleet/mounted", { gatewayId, uid, mounted });
    },
    async acknowledgeRuntimeReset(uid, operationId, generation) {
      return postNoContent(
        "/internal/fleet/runtime-reset-ack",
        { gatewayId, uid, operationId, generation },
        await gatewayCredentialHeaders(),
      );
    },
    recordReconcileError(slug, message) {
      return postNoContent("/internal/fleet/reconcile-error", { gatewayId, slug, message });
    },
    clearReconcileError(slug) {
      return postNoContent("/internal/fleet/clear-reconcile-error", { gatewayId, slug });
    },
    reportProvisioned(uid, report) {
      return postNoContent("/internal/fleet/provisioned", { gatewayId, uid, first: report.first });
    },
    recordUsageEvent(input) {
      return postNoContent("/internal/fleet/usage-event", { gatewayId, ...input });
    },
    recordPreStopFlush(input) {
      return postNoContent("/internal/fleet/prestop-flush", { gatewayId, ...input });
    },
    recordSystemConfigStatus(status) {
      return postNoContent("/internal/fleet/system-config-status", {
        gatewayId,
        revisionId,
        status,
      });
    },
    blobDownloadUrl(input) {
      return postJson<FleetBrokerBlobSignedUrl>(
        "/internal/fleet/blob/download-url",
        { gatewayId, ...input },
      );
    },
    async blobMaterializationReadUrl(input) {
      return postJson<FleetBrokerBlobMaterialization>(
        "/internal/fleet/blob/materialization/read-url", { gatewayId, ...input }, await gatewayCredentialHeaders(),
      );
    },
    blobUploadUrl(input) {
      return postJson<FleetBrokerBlobSignedUrl>(
        "/internal/fleet/blob/upload-url",
        { gatewayId, ...input },
      );
    },
    async workspaceManifestReadUrl(input) {
      const project = input.projectSlug !== undefined;
      return postJson<FleetBrokerBlobSignedUrl>(
        project ? "/internal/fleet/blob/materialization/manifest/read-url" : "/internal/fleet/blob/manifest/read-url",
        { gatewayId, ...input }, project ? await gatewayCredentialHeaders() : {},
      );
    },
    workspaceManifestWriteUrl(input) {
      return postJson<FleetBrokerBlobSignedUrl>(
        "/internal/fleet/blob/manifest/write-url",
        { gatewayId, ...input },
      );
    },
    ...isolatedPodClient(gatewayId, revisionId, gatewayCredentialHeaders),
  };
}
