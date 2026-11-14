import type { MigrationProgressRecord } from "./glm.js";
import { createHash } from "node:crypto";
import type {
  GatewayPodPlacement,
  GatewayPodReplacements,
} from "./gateway-pod-replacements.js";
import {
  projectGatewayMutableConfigForGateway,
  type GatewayMutableConfig,
} from "./gateway-mutable-config.js";
import { IMAGE_TAG_PATTERN } from "./image-tag.js";
import {
  dualReadGatewayClassValue,
  type GatewayDesiredStatus,
} from "./glm.js";

// Simple-roll model (GATEWAY-SIMPLE-ROLL-SPEC): durable identity
// (gateways/{id}) + immutable releases (releases/{n}) + ONE stable-name
// realization per gateway (glmGateways/{gatewayId} runtime doc). A roll is a
// desiredRelease write; Kubernetes surge replacement is the only mechanism.

// gateways/{gatewayId}/releases/{n} and gateways/{gatewayId}/assignments/{uid}
// are subcollections of the durable gateway identity doc.
export const GATEWAY_RELEASES_SUBCOLLECTION = "releases";
export const GATEWAY_ASSIGNMENTS_SUBCOLLECTION = "assignments";

// gateways/{gatewayId} desired-identity lifecycle. Pausing scales the gateway
// to zero; retirement is its own terminal state.
export type GatewayLifecycleStatus = GatewayDesiredStatus;

export interface GatewayRetirementClaim {
  operationId: string;
  version: number;
  claimedAt: number;
  phase: "claimed";
  liveRelease: number | null;
  liveRuntimeIdentity: {
    startedAt: number;
    version: string;
    openclawVersion: string;
  } | null;
  previousDesiredStatus: Exclude<GatewayLifecycleStatus, "retired">;
}

// gateways/{gatewayId} — durable desired gateway identity. Gateways have no
// reservation mirror or persistent volume.
export interface GatewayDoc {
  gatewayId: string;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  latestRelease: number;
  desiredRelease: number;
  liveRelease: number | null;
  desiredStatus: GatewayLifecycleStatus;
  retireAfter?: number | null;
  retirementVersion?: number;
  retirementClaim?: GatewayRetirementClaim | null;
}

export interface GatewayEdgeImage {
  imageRepository: string;
  imageTag: string;
}

export interface GatewayProfileImage {
  imageRepository: string;
  imageTag: string;
}

export type GatewayProfileImages = { builder: GatewayProfileImage } | { isolated: GatewayProfileImage };

export function dualReadIsolatedProfileImage(images: GatewayProfileImages): GatewayProfileImage {
  return "isolated" in images ? images.isolated : images.builder;
}

const DIGEST_BOUND_IMAGE_TAG_PATTERN =
  /^[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/;
// Immutable release payload. Gateway policy lives exclusively on
// gateways/{gatewayId}, never in a release or revision.
export interface ReleasePayload {
  imageRepository: string;
  imageTag: string;
  openclawSourceSha?: string;
  profileImages?: GatewayProfileImages;
  gatewayEdgeImage?: GatewayEdgeImage;
}

const RELEASE_PAYLOAD_FIELD_NAMES = new Set<string>([
  "imageRepository",
  "imageTag",
  "openclawSourceSha",
  "profileImages",
  "gatewayEdgeImage",
]);

const RELEASE_PAYLOAD_REQUIRED_FIELDS = [
  "imageRepository",
  "imageTag",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isReleasePayload(value: unknown): value is ReleasePayload {
  if (!isPlainRecord(value)) return false;
  if (!hasReleasePayloadShape(value) || !hasReleasePayloadIdentity(value)) return false;
  if (
    value.openclawSourceSha !== undefined &&
    (typeof value.openclawSourceSha !== "string" || !/^[a-f0-9]{40}$/.test(value.openclawSourceSha))
  ) {
    return false;
  }
  if (
    value.profileImages !== undefined &&
    !isGatewayProfileImages(value.profileImages, value.imageRepository, value.imageTag)
  ) {
    return false;
  }
  return value.gatewayEdgeImage === undefined ||
    isGatewayEdgeImage(value.gatewayEdgeImage, value.imageRepository);
}

function isGatewayProfileImages(
  value: unknown,
  gatewayImageRepository: string,
  gatewayImageTag: string,
): value is GatewayProfileImages {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1) return false;
  const [profile] = Object.keys(value);
  if (dualReadGatewayClassValue(profile) !== "isolated") return false;
  const isolatedImage = value[profile];
  if (!isPlainRecord(isolatedImage) || Object.keys(isolatedImage).length !== 2) return false;
  const gatewayPackageSuffix = "/octogee-gateway";
  const expectedRepository = gatewayImageRepository.endsWith(gatewayPackageSuffix)
    ? `${gatewayImageRepository.slice(0, -gatewayPackageSuffix.length)}/octogee-gateway-builder`
    : "";
  return (
    isolatedImage.imageRepository === expectedRepository &&
    typeof isolatedImage.imageTag === "string" &&
    DIGEST_BOUND_IMAGE_TAG_PATTERN.test(isolatedImage.imageTag) &&
    isolatedImage.imageTag.split("@", 1)[0] === gatewayImageTag.split("@", 1)[0]
  );
}

export function isGatewayEdgeImage(
  value: unknown,
  gatewayImageRepository: string,
): value is GatewayEdgeImage {
  const gatewayPackageSuffix = "/octogee-gateway";
  const expectedRepository = gatewayImageRepository.endsWith(gatewayPackageSuffix)
    ? `${gatewayImageRepository.slice(0, -gatewayPackageSuffix.length)}/gateway-edge`
    : "";
  return (
    isPlainRecord(value) &&
    value.imageRepository === expectedRepository &&
    typeof value.imageTag === "string" &&
    IMAGE_TAG_PATTERN.test(value.imageTag)
  );
}

export type ReleasePayloadSchemaUpgrade =
  | {
      status: "current";
      payload: ReleasePayload;
      payloadHash: string;
    }
  | {
      status: "upgraded";
      migration: "remove-retired-mac-ops-token-protocol";
      payload: ReleasePayload;
      payloadHash: string;
    }
  | {
      status: "unsupported";
      reason: "payload-hash-mismatch" | "unsupported-payload-schema";
    };

export function upgradeReleasePayloadSchema(
  payload: unknown,
  persistedPayloadHash: unknown,
): ReleasePayloadSchemaUpgrade {
  if (
    typeof persistedPayloadHash !== "string" ||
    persistedPayloadHash !== releasePayloadValueHash(payload)
  ) {
    return { status: "unsupported", reason: "payload-hash-mismatch" };
  }
  if (isReleasePayload(payload)) {
    return { status: "current", payload, payloadHash: persistedPayloadHash };
  }
  if (
    !isPlainRecord(payload) ||
    !Object.prototype.hasOwnProperty.call(payload, "macOpsTokenProtocol")
  ) {
    return { status: "unsupported", reason: "unsupported-payload-schema" };
  }
  const upgraded = { ...payload };
  delete upgraded.macOpsTokenProtocol;
  if (!isReleasePayload(upgraded)) {
    return { status: "unsupported", reason: "unsupported-payload-schema" };
  }
  return {
    status: "upgraded",
    migration: "remove-retired-mac-ops-token-protocol",
    payload: upgraded,
    payloadHash: releasePayloadValueHash(upgraded),
  };
}

function hasReleasePayloadShape(value: Record<string, unknown>): boolean {
  return !(
    Object.keys(value).some((field) => !RELEASE_PAYLOAD_FIELD_NAMES.has(field)) ||
    RELEASE_PAYLOAD_REQUIRED_FIELDS.some(
      (field) => !Object.prototype.hasOwnProperty.call(value, field),
    )
  );
}

function hasReleasePayloadIdentity(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { imageRepository: string; imageTag: string } {
  return (
    typeof value.imageRepository === "string" &&
    value.imageRepository.length > 0 &&
    typeof value.imageTag === "string" &&
    value.imageTag.length > 0 &&
    IMAGE_TAG_PATTERN.test(value.imageTag)
  );
}

// gateways/{gatewayId}/releases/{n} — append-only. Rollback cuts a NEW release
// whose payload equals a prior release; it never rewrites history.
export interface ReleaseDoc {
  gatewayId: string;
  release: number;
  createdAt: number;
  createdBy: string;
  sourceRelease: number | null;
  note: string | null;
  payloadHash: string;
  payload: ReleasePayload;
}

export type AssignmentSource =
  | "onboarding"
  | "migrate-user"
  | "repair";

// Migration-plane routing state for one user's assignment. serving = the
// assigned gateway answers service-addressed traffic; quiescing/migrating =
// the user is being moved between gateways (the edge answers 503 +
// Retry-After until the cutover lands). The cutover writes serving on the
// target gateway's assignment and bumps `epoch`.
export type AssignmentState = "serving" | "quiescing" | "migrating";

export function isAssignmentState(value: unknown): value is AssignmentState {
  return value === "serving" || value === "quiescing" || value === "migrating";
}

// Internal-only headers a forwarded intra-family hop carries between two
// gateways/{gatewayId}/assignments/{uid} — which users a gateway serves.
// `epoch` is monotonic per user, bumped at each migration cutover; `state`
// gates serving while a user moves between gateways.
export interface AssignmentDoc {
  uid: string;
  slug: string;
  gatewayId: string;
  source: AssignmentSource;
  state: AssignmentState;
  epoch: number;
  // When this user started serving on this gateway; a cutover restarts it.
  createdAt: number;
  updatedAt: number;
  updatedByOperationId: string | null;
  handoffProgress?: MigrationProgressRecord[];
  sharedSurgeForwardRecovery?: { operationId: string; targetPodUid: string; receivingPodUid: string };
}

export type GatewayRuntimeLifecycle =
  | "provisioning"
  | "serving"
  | "failed";

export type GatewayHeartbeatStatus =
  | "unknown"
  | "booting"
  | "ready"
  | "unreachable"
  | "error";

export interface GatewayHelmObservation {
  releaseName: string;
  deploymentName: string;
  gatewayServiceName: string;
  gatewayEdgeServiceName: string;
  serviceAccountName: string;
  imageRepository: string | null;
  imageTag: string | null;
  replicas: number | null;
  availableReplicas: number | null;
  lastAppliedAt: number | null;
}

export interface GatewayHeartbeatObservation {
  status: GatewayHeartbeatStatus;
  lastHeartbeatAt: number | null;
  version: string | null;
  openclawVersion: string | null;
  internalUrl: string | null;
  startedAt: number | null;
  mountedCustomers: string[];
  migratingIn: string[];
  configStatus?: import("./fleet-controller.js").GatewayConfigStatus;
  configuredBuilder?: import("./fleet-controller.js").ConfiguredUserReport | null;
  openclawProcess?: import("./fleet-controller.js").OpenClawProcessReport | null;
}

// glmGateways/{gatewayId} — the controller-owned runtime observation record for the
// gateway's single stable-name realization: which release is applied, what the
// pod last reported. Never desired configuration (that is gateways/{id}).
export interface GatewayRuntimeDoc {
  docKind: "runtime";
  gatewayId: string;
  release: number;
  lifecycle: GatewayRuntimeLifecycle;
  createdAt: number;
  createdByOperationId: string | null;
  helm: GatewayHelmObservation;
  heartbeat: GatewayHeartbeatObservation;
  kubernetes?: GatewayKubernetesObservation;
  podReplacements?: GatewayPodReplacements;
  lastError: { message: string | null; at: number | null };
}

export interface GatewayKubernetesObservation {
  status: "ready" | "not-ready" | "missing" | "unknown";
  totalPods: number;
  readyPods: number;
  observedAt: number;
  // The pods observed, each with its owning ReplicaSet and node placement. The
  // next observation diffs against this to notice a pod that vanished, asks the
  // ReplicaSet whether it still wanted that pod, and names the vacated GCE
  // instance — which is unrecoverable once the node is gone.
  pods?: GatewayPodPlacement[];
}

export function hasFreshReadyKubernetesObservation(
  runtime: Pick<GatewayRuntimeDoc, "kubernetes">,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  const observation = runtime.kubernetes;
  return observation?.status === "ready" &&
    Number.isSafeInteger(observation.totalPods) &&
    observation.totalPods > 0 &&
    Number.isSafeInteger(observation.readyPods) &&
    observation.readyPods > 0 &&
    Number.isFinite(observation.observedAt) &&
    nowMs >= observation.observedAt &&
    nowMs - observation.observedAt <= maxAgeMs;
}

export function isGatewayRuntimeDoc(data: unknown): data is GatewayRuntimeDoc {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    d.docKind === "runtime" &&
    typeof d.gatewayId === "string" &&
    typeof d.release === "number" &&
    typeof d.lifecycle === "string"
  );
}

// A gateways/{id} durable desired doc (GatewayDoc), distinct from a legacy
// GatewayDesiredState (no desiredRelease/latestRelease).
export function isGatewayDesiredDoc(data: unknown): data is GatewayDoc {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.gatewayId === "string" &&
    typeof d.desiredRelease === "number" &&
    typeof d.latestRelease === "number" &&
    (d.desiredStatus === "running" ||
      d.desiredStatus === "paused" ||
      d.desiredStatus === "draining" ||
      d.desiredStatus === "retired")
  );
}

export function projectGatewayDesiredRootForGateway(
  value: unknown,
  gatewayId: string,
): (GatewayDoc & GatewayMutableConfig) | null {
  if (!isGatewayDesiredDoc(value) || value.gatewayId !== gatewayId) return null;
  const projected = projectGatewayMutableConfigForGateway(value, gatewayId);
  return projected as (GatewayDoc & GatewayMutableConfig) | null;
}

export function helmReleaseNameForGateway(gatewayId: string): string {
  return `octogee-gw-${gatewayId}`;
}

// Kubernetes Service DNS names for the gateway's stable-name resources.
// Service-addressed `/g/{gatewayId}/…` targets `gateway-edge-{gatewayId}`;
// the chart renders both names directly from the bare gateway id.
export function gatewayEdgeServiceName(id: string): string {
  return `gateway-edge-${id}`;
}

// The gateway pod Service (preview surface, port 9080).
export function gatewayPodServiceName(id: string): string {
  return `octogee-gateway-${id}`;
}

// Deterministic, order-independent hash of a release payload. Used to reject a
// no-op release (payload equals the previous release) and to fingerprint a
// revision's rendered config. Non-cryptographic identity is not required; the
// only contract is: same normalized value → same hash, any change → different.
export function releasePayloadHash(payload: ReleasePayload): string {
  return releasePayloadValueHash(payload);
}

export const PLATFORM_RELEASE_RECORD_DOC_PATH = "glmControllerState/platformRelease";

export interface PlatformReleaseRecord {
  schemaVersion: 1;
  payloadHash: string;
  imageTag: string;
  openclawSourceSha: string | null;
  writtenAt: number;
}

export function platformReleaseRecord(
  payload: ReleasePayload,
  writtenAt: number,
): PlatformReleaseRecord {
  return {
    schemaVersion: 1,
    payloadHash: releasePayloadHash(payload),
    imageTag: payload.imageTag,
    openclawSourceSha: payload.openclawSourceSha ?? null,
    writtenAt,
  };
}

export function parsePlatformReleaseRecord(value: unknown): PlatformReleaseRecord | null {
  if (!isPlainRecord(value)) return null;
  const { schemaVersion, payloadHash, imageTag, openclawSourceSha, writtenAt } = value;
  if (
    schemaVersion !== 1 ||
    typeof payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(payloadHash) ||
    typeof imageTag !== "string" || imageTag.length === 0 ||
    (openclawSourceSha !== null && typeof openclawSourceSha !== "string") ||
    typeof writtenAt !== "number" || !Number.isSafeInteger(writtenAt) || writtenAt < 0
  ) {
    return null;
  }
  return { schemaVersion, payloadHash, imageTag, openclawSourceSha, writtenAt };
}

function releasePayloadValueHash(payload: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(payload))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareKeys(a, b));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export type GatewayFieldClassification =
  | "release"
  | "gateway-mutable";

// Release-payload fields — audited via an immutable release; changing one is a
// roll. Listed for documentation + testing; the classifier does not need them
// because the conservative default already returns "release" for anything
// unlisted.
export const RELEASE_FIELDS = [
  "imageRepository",
  "imageTag",
] as const;

// gateways/{gatewayId} DOC fields that mutate without cutting a release.
// Separate-collection observations (assignment docs, runtime heartbeat /
// lastError) are not gateway-doc fields and are not enumerated here.
export const GATEWAY_MUTABLE_FIELDS = [
  "profile",
  "gatewayClass",
  "imageProfile",
  "sizingTier",
  "gcpProject",
  "gatewayContainerSecurityContext",
  "serviceAccountName",
  "serviceAccount",
  "builderAccess",
  "ownerUid",
  "builderSlug",
  "modelBrokerLimits",
  "allocation",
  "desiredStatus",
  "liveRelease",
  "retireAfter",
] as const;

const GATEWAY_MUTABLE_SET = new Set<string>(GATEWAY_MUTABLE_FIELDS);

// Conservative classifier over gateway-DOC and release-PAYLOAD field NAMES.
// Only explicitly enumerated gateway-mutable fields escape the default; every
// other field — including any new field added to the payload later — is
// release-audited. That default is the safety property the spec pins
// (operator, 2026-07-08).
export function classifyGatewayField(field: string): GatewayFieldClassification {
  if (GATEWAY_MUTABLE_SET.has(field)) return "gateway-mutable";
  return "release";
}

export type PlacementRejectReason =
  | "builder-missing"
  | "builder-operator-managed"
  | "account-not-interactive"
  | "restore-in-progress"
  | "source-transfer-in-progress"
  | "gateway-root-invalid"
  | "gateway-not-running"
  | "gateway-not-serving"
  | "gateway-target-not-accepting"
  | "assigned-elsewhere";

export type CommitPlacementResult =
  | { kind: "mirror-only" }
  | { kind: "assignment-preserved" }
  | { kind: "assigned"; release: number | null }
  | { kind: "rejected"; reason: PlacementRejectReason };

export function userRestoreFencePresent(user: unknown): boolean {
  if (!isPlainRecord(user) || !isPlainRecord(user.provisioning)) return false;
  const openclaw = user.provisioning.openclaw;
  return isPlainRecord(openclaw) && openclaw.restoreFence !== undefined;
}

export function userRuntimeMutationFenced(user: unknown): boolean {
  if (userRestoreFencePresent(user)) return true;
  if (!isPlainRecord(user) || !isPlainRecord(user.provisioning)) return false;
  const openclaw = user.provisioning.openclaw;
  return isPlainRecord(openclaw) && openclaw.sourceTransferFence !== undefined;
}

