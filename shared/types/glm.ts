import type { SizingTier } from "./sizing.js";

export type GatewayDesiredStatus = "running" | "paused" | "draining" | "retired";

export const GATEWAY_PROFILES = ["standard", "isolated"] as const;
export type GatewayProfile = (typeof GATEWAY_PROFILES)[number];

export const GATEWAY_CLASSES = ["shared", "isolated"] as const;
export type GatewayClass = (typeof GATEWAY_CLASSES)[number];

export const GATEWAY_IMAGE_PROFILES = ["standard", "isolated"] as const;
export type GatewayImageProfile = (typeof GATEWAY_IMAGE_PROFILES)[number];

export function dualReadGatewayClassValue<T>(value: T): T | "isolated" {
  return value === "builder" ? "isolated" : value;
}

export function isIsolatedGatewayClassValue(value: unknown): boolean {
  return dualReadGatewayClassValue(value) === "isolated";
}

export interface GatewayDesiredState {
  gatewayId: string;

  /**
   * Durable identity this instance belongs to (`shared-a`, `walter`) — bare,
   * never blue/green-suffixed. Explicit on every instance written after the
   * gateway field landed; older docs derive it from gatewayId by convention
   * via deriveGatewayIdentity until backfilled.
   */
  gateway?: string;

  imageRepository: string;
  imageTag: string;

  /**
   * Legacy overloaded image/capability selector. Keep for compatibility with
   * already-authored desired-state docs and API clients. New callers should set
   * gatewayClass + imageProfile explicitly.
   */
  profile?: GatewayProfile;
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
  desiredStatus: GatewayDesiredStatus;

  createdBy: string;

  retireAfter?: number;

  serviceAccountName?: string;
  serviceAccount?: GatewayServiceAccountSpec;

  gcpProject?: string;

  gatewayContainerSecurityContext?: Record<string, unknown>;

  builderAccess?: IsolatedGatewayAccessSpec;

  lastError?: { at: number; message: string } | null;

  ownerUid?: string;

  builderSlug?: string;

  sizingTier?: SizingTier;

  modelBrokerLimits?: GatewayModelBrokerLimits;

  runtime?: GatewayRuntime;

  vmSpec?: GatewayVmSpec;

  vm?: GatewayVmState | null;

  vmEgress?: GatewayVmEgressState;
}

export const GATEWAY_RUNTIMES = ["cluster", "gce-vm"] as const;
export type GatewayRuntime = (typeof GATEWAY_RUNTIMES)[number];

export function isGatewayRuntime(value: unknown): value is GatewayRuntime {
  return typeof value === "string" && (GATEWAY_RUNTIMES as readonly string[]).includes(value);
}

export function resolveGatewayRuntime(value: unknown): GatewayRuntime {
  return isGatewayRuntime(value) ? value : "cluster";
}

export const GATEWAY_VM_BOOT_DISK_TYPES = ["pd-ssd", "pd-balanced"] as const;
export type GatewayVmBootDiskType = (typeof GATEWAY_VM_BOOT_DISK_TYPES)[number];

export function isGatewayVmBootDiskType(value: unknown): value is GatewayVmBootDiskType {
  return typeof value === "string" && (GATEWAY_VM_BOOT_DISK_TYPES as readonly string[]).includes(value);
}

export const GATEWAY_VM_DESKTOPS = ["omarchy", "x11"] as const;
export type GatewayVmDesktop = (typeof GATEWAY_VM_DESKTOPS)[number];

export function isGatewayVmDesktop(value: unknown): value is GatewayVmDesktop {
  return typeof value === "string" && (GATEWAY_VM_DESKTOPS as readonly string[]).includes(value);
}

export const GATEWAY_VM_PROVISIONING_MODELS = ["SPOT", "STANDARD"] as const;
export type GatewayVmProvisioningModel = (typeof GATEWAY_VM_PROVISIONING_MODELS)[number];

export interface GatewayVmSpec {
  zones: readonly string[];
  machineType: string;
  imageFamily: string;
  imageProject?: string;
  diskSizeGb: number;
  bootDiskType: GatewayVmBootDiskType;
  homeDiskSizeGb: number;
  provisioningModel: GatewayVmProvisioningModel;
  desktop: GatewayVmDesktop;
  serviceAccountEmail: string;
  subnetwork: string;
}

export interface RetainedUserHome {
  projectId: string;
  zone: string;
  name: string;
  id: string;
  sizeGb: number;
  diskType: "pd-balanced" | "pd-ssd";
  source: string;
}

export const GATEWAY_VM_STOP_REASONS = ["idle", "preempted", "operator"] as const;
export type GatewayVmStopReason = (typeof GATEWAY_VM_STOP_REASONS)[number];

export function isGatewayVmStopReason(value: unknown): value is GatewayVmStopReason {
  return typeof value === "string" && (GATEWAY_VM_STOP_REASONS as readonly string[]).includes(value);
}

export interface GatewayVmState {
  instanceName: string;
  zone: string;
  instanceId: string | null;
  internalIp: string | null;
  status: string | null;
  startedAt: number | null;
  provisioningModel: GatewayVmProvisioningModel | null;
  stopReason: GatewayVmStopReason | null;
  parkedCheckpoint?: GatewayVmParkedCheckpoint;
  updatedAt: number;
}

export const GATEWAY_EGRESS_MODES = ["cloud", "desktop"] as const;
export type GatewayEgressMode = (typeof GATEWAY_EGRESS_MODES)[number];

export function isGatewayEgressMode(value: unknown): value is GatewayEgressMode {
  return typeof value === "string" && (GATEWAY_EGRESS_MODES as readonly string[]).includes(value);
}

export interface GatewayVmEgressState {
  mode: GatewayEgressMode;
  updatedAt: number;
}

export function isGatewayVmEgressState(value: unknown): value is GatewayVmEgressState {
  const c = value as Partial<GatewayVmEgressState> | null;
  return !!c && typeof c === "object" && isGatewayEgressMode(c.mode) && typeof c.updatedAt === "number" && Number.isFinite(c.updatedAt);
}

export const GATEWAY_EGRESS_SOCKS_HOST = "127.0.0.1";
export const GATEWAY_EGRESS_SOCKS_PORT = 1080;

export const GATEWAY_VM_PARKED_CHECKPOINT_OUTCOMES = ["fresh", "stale"] as const;
export type GatewayVmParkedCheckpointOutcome = (typeof GATEWAY_VM_PARKED_CHECKPOINT_OUTCOMES)[number];

export interface GatewayVmParkedCheckpoint {
  outcome: GatewayVmParkedCheckpointOutcome;
  requestedAt: number | null;
  completedAt: number | null;
}

export function isGatewayVmParkedCheckpoint(value: unknown): value is GatewayVmParkedCheckpoint {
  const c = value as Partial<GatewayVmParkedCheckpoint> | null;
  return !!c
    && typeof c.outcome === "string" && (GATEWAY_VM_PARKED_CHECKPOINT_OUTCOMES as readonly string[]).includes(c.outcome)
    && (c.requestedAt === null || typeof c.requestedAt === "number")
    && (c.completedAt === null || typeof c.completedAt === "number");
}

export const USER_PARKED_VM_FIELD = "provisioning.computer";

export interface UserParkedVm {
  instanceName: string;
  zone: string;
  instanceId: string | null;
  gatewayId: string;
  parkedAt: number;
  checkpoint: GatewayVmParkedCheckpoint;
  homeCheckpoint?: GatewayVmHomeCheckpoint;
  bootRecovery?: GatewayVmBootRecoverySample & { instanceId: string; observedAt: number };
  vmSpec?: GatewayVmSpec;
  disposable?: true;
}

function parkedVmRecoveryValid(p: Partial<UserParkedVm>): boolean {
  return (p.homeCheckpoint === undefined || isGatewayVmHomeCheckpoint(p.homeCheckpoint))
    && (p.disposable === undefined || (p.disposable === true && isDisposableHomeCheckpoint(p.homeCheckpoint)))
    && (p.bootRecovery === undefined || isGatewayVmBootRecoverySample(p.bootRecovery)
      && typeof p.bootRecovery.instanceId === "string" && Number.isFinite(p.bootRecovery.observedAt));
}

export function isUserParkedVm(value: unknown): value is UserParkedVm {
  const p = value as Partial<UserParkedVm> | null;
  return !!p
    && typeof p.instanceName === "string" && p.instanceName.length > 0
    && typeof p.zone === "string" && p.zone.length > 0
    && (p.instanceId === null || typeof p.instanceId === "string")
    && typeof p.gatewayId === "string" && p.gatewayId.length > 0
    && typeof p.parkedAt === "number" && Number.isFinite(p.parkedAt)
    && isGatewayVmParkedCheckpoint(p.checkpoint)
    && parkedVmRecoveryValid(p);
}

export function readUserParkedVm(userData: Record<string, unknown> | undefined): UserParkedVm | null {
  const provisioning = userData?.provisioning;
  if (!provisioning || typeof provisioning !== "object" || Array.isArray(provisioning)) return null;
  const computer = (provisioning as Record<string, unknown>).computer;
  return isUserParkedVm(computer) ? computer : null;
}

export const GLM_GATEWAY_VM_SUBCOLLECTION = "vm";
export const GLM_GATEWAY_VM_RUNTIME_DOC = "runtime";

export function gatewayVmRuntimeDocPath(gatewayId: string): string {
  return `${GLM_GATEWAYS_COLLECTION}/${gatewayId}/${GLM_GATEWAY_VM_SUBCOLLECTION}/${GLM_GATEWAY_VM_RUNTIME_DOC}`;
}

export interface GatewayVmRuntimeMount {
  volume: string;
  mountPath: string;
  readOnly: boolean;
  subPath: string | null;
}

export interface GatewayVmRuntimeContainer {
  name: string;
  image: string;
  env: Record<string, string>;
  command: string[] | null;
  args: string[] | null;
  mounts: GatewayVmRuntimeMount[];
}

export type GatewayVmRuntimeVolume =
  | { name: string; kind: "emptyDir" | "ephemeral" }
  | { name: string; kind: "identityToken"; audience: string }
  | { name: string; kind: "kubernetesApi" };

export interface RuntimeUserIdentity {
  ownerUid: string;
  builderSlug: string;
}

export function isRuntimeUserIdentity(value: unknown): value is RuntimeUserIdentity {
  const identity = value as Partial<RuntimeUserIdentity> | null;
  return !!identity && typeof identity === "object" &&
    typeof identity.ownerUid === "string" && identity.ownerUid.length > 0 &&
    typeof identity.builderSlug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(identity.builderSlug);
}

export interface GatewayVmRuntimeBundle {
  version: string;
  gatewayId: string;
  builderIdentity?: RuntimeUserIdentity;
  namespace?: string;
  imageRepository: string;
  imageTag: string;
  /** Absent on bundles rendered before VMs named their desktop; those VMs run Omarchy. */
  desktop?: GatewayVmDesktop;
  init: GatewayVmRuntimeContainer | null;
  containers: GatewayVmRuntimeContainer[];
  volumes: GatewayVmRuntimeVolume[];
  hostAliases: Record<string, string>;
  kubernetes: { apiHost: string; apiPort: string; caCert: string };
  renderedAt: number;
  homeRestoreCheckpoint?: GatewayVmHomeCheckpoint;
}

function runtimeBundleImageValid(b: Partial<GatewayVmRuntimeBundle>): boolean {
  return typeof b.imageRepository === "string" && typeof b.imageTag === "string"
    && (b.desktop === undefined || isGatewayVmDesktop(b.desktop));
}

function runtimeBundleHostsValid(b: Partial<GatewayVmRuntimeBundle>): boolean {
  return !!b.hostAliases && typeof b.hostAliases === "object" && !!b.kubernetes && typeof b.kubernetes.apiHost === "string";
}

export function isGatewayVmRuntimeBundle(value: unknown): value is GatewayVmRuntimeBundle {
  const b = value as Partial<GatewayVmRuntimeBundle> | null;
  return !!b
    && typeof b.version === "string" && b.version.length > 0
    && typeof b.gatewayId === "string" && b.gatewayId.length > 0
    && runtimeBundleImageValid(b)
    && Array.isArray(b.containers) && b.containers.length > 0
    && Array.isArray(b.volumes)
    && runtimeBundleHostsValid(b)
    && (b.builderIdentity === undefined || isRuntimeUserIdentity(b.builderIdentity))
    && (b.homeRestoreCheckpoint === undefined || isDisposableHomeCheckpoint(b.homeRestoreCheckpoint));
}

export interface GatewayVmRuntimeResponse {
  bundle: GatewayVmRuntimeBundle;
  homeCheckpoint: { requestedAt: number | null; completedAt: number | null };
}

export interface GatewayVmDiskSample {
  sizeBytes: number;
  freeBytes: number;
}

export interface GatewayVmRuntimeRequest {
  disk?: GatewayVmDiskSample;
  images?: GatewayVmImageSample;
  preempted?: true;
  bootRecovery?: GatewayVmBootRecoverySample;
}

export const GATEWAY_VM_IMAGE_SERVICES = ["gateway", "gateway-edge"] as const;

export interface GatewayVmContainerImage {
  name: typeof GATEWAY_VM_IMAGE_SERVICES[number];
  imageReference: string;
  digests: string[];
  running: boolean;
}

export interface GatewayVmImageSample {
  containers: GatewayVmContainerImage[];
}

export interface GatewayVmImageObservation extends GatewayVmImageSample {
  instanceId: string;
  observedAt: number;
}

function isGatewayVmContainerImage(value: unknown): value is GatewayVmContainerImage {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<GatewayVmContainerImage>;
  return GATEWAY_VM_IMAGE_SERVICES.some(name => name === c.name)
    && typeof c.running === "boolean"
    && typeof c.imageReference === "string" && c.imageReference.length <= 1024
    && (c.imageReference === "" ? !c.running && Array.isArray(c.digests) && c.digests.length === 0 : /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(c.imageReference))
    && Array.isArray(c.digests) && c.digests.length <= 16
    && c.digests.every(digest => typeof digest === "string" && digest.length <= 1024 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(digest));
}

export function isGatewayVmImageSample(value: unknown): value is GatewayVmImageSample {
  const sample = value as Partial<GatewayVmImageSample> | null;
  return !!sample && Array.isArray(sample.containers)
    && sample.containers.length === GATEWAY_VM_IMAGE_SERVICES.length
    && sample.containers.every(isGatewayVmContainerImage)
    && new Set(sample.containers.map(c => c.name)).size === GATEWAY_VM_IMAGE_SERVICES.length;
}

export function isGatewayVmImageObservation(value: unknown): value is GatewayVmImageObservation {
  const observation = value as Partial<GatewayVmImageObservation> | null;
  return isGatewayVmImageSample(value) && !!observation
    && typeof observation.instanceId === "string" && observation.instanceId.length > 0
    && typeof observation.observedAt === "number" && Number.isSafeInteger(observation.observedAt) && observation.observedAt >= 0;
}

export interface GatewayVmPreemptionNotice {
  instanceId: string;
  announcedAt: number;
}

export function isGatewayVmPreemptionNotice(value: unknown): value is GatewayVmPreemptionNotice {
  const n = value as Partial<GatewayVmPreemptionNotice> | null;
  return !!n && typeof n === "object"
    && typeof n.instanceId === "string" && n.instanceId.length > 0
    && typeof n.announcedAt === "number" && Number.isFinite(n.announcedAt);
}

export interface GatewayVmDiskObservation extends GatewayVmDiskSample {
  instanceId: string;
  observedAt: number;
}

export function isGatewayVmDiskSample(value: unknown): value is GatewayVmDiskSample {
  const d = value as Partial<GatewayVmDiskSample> | null;
  return !!d && typeof d === "object"
    && typeof d.sizeBytes === "number" && Number.isSafeInteger(d.sizeBytes) && d.sizeBytes > 0
    && typeof d.freeBytes === "number" && Number.isSafeInteger(d.freeBytes) && d.freeBytes >= 0 && d.freeBytes <= d.sizeBytes;
}

export function isGatewayVmDiskObservation(value: unknown): value is GatewayVmDiskObservation {
  const o = value as Partial<GatewayVmDiskObservation> | null;
  return isGatewayVmDiskSample(o)
    && typeof (o as Partial<GatewayVmDiskObservation>).instanceId === "string"
    && typeof (o as Partial<GatewayVmDiskObservation>).observedAt === "number"
    && Number.isFinite((o as Partial<GatewayVmDiskObservation>).observedAt);
}

export function vmDiskFreePercent(sample: GatewayVmDiskSample): number {
  return Math.floor((sample.freeBytes / sample.sizeBytes) * 100);
}

export const VM_HOME_CHECKPOINT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const VM_HOME_CHECKPOINT_KEEP = 5;
export const VM_HOME_CHECKPOINT_NAME_RE = /^\d{8}T\d{6}Z\.tar\.gz$/u;
export const VM_HOME_CHECKPOINT_CONTENT_TYPE = "application/gzip";

export interface GatewayVmHomeCheckpoint {
  generation?: string;
  coverage?: "builder-home-v2";
  writerProtocol?: 2 | 3;
  name: string;
  size: number;
  sha256: string;
  instanceId: string | null;
  completedAt: number;
}

export interface GatewayVmHomeState {
  checkpointRequestedAt: number | null;
  checkpointAcknowledgedAt?: number | null;
  parkRequestedAt?: number;
  restoreCheckpoint?: GatewayVmHomeCheckpoint;
  lastCheckpoint: GatewayVmHomeCheckpoint | null;
}

export function homeCheckpointOutstanding(home: Partial<GatewayVmHomeState> | null | undefined): boolean {
  const requestedAt = home?.checkpointRequestedAt;
  if (typeof requestedAt !== "number") return false;
  const completedAt = home?.lastCheckpoint?.completedAt;
  return typeof completedAt !== "number" || completedAt < requestedAt
    || typeof home?.checkpointAcknowledgedAt !== "number" || home.checkpointAcknowledgedAt < requestedAt;
}

function homeCheckpointProtocolValid(c: Partial<GatewayVmHomeCheckpoint>): boolean {
  return (c.coverage === undefined || c.coverage === "builder-home-v2")
    && (c.writerProtocol === undefined || c.writerProtocol === 2 || c.writerProtocol === 3)
    && (c.generation === undefined || (typeof c.generation === "string" && /^[1-9]\d*$/u.test(c.generation)));
}

export function isGatewayVmHomeCheckpoint(value: unknown): value is GatewayVmHomeCheckpoint {
  const c = value as Partial<GatewayVmHomeCheckpoint> | null;
  return !!c
    && typeof c.name === "string" && VM_HOME_CHECKPOINT_NAME_RE.test(c.name)
    && typeof c.size === "number" && Number.isSafeInteger(c.size) && c.size > 0 && c.size <= VM_HOME_CHECKPOINT_MAX_BYTES
    && typeof c.sha256 === "string" && /^[a-f0-9]{64}$/u.test(c.sha256)
    && (c.instanceId === null || typeof c.instanceId === "string")
    && typeof c.completedAt === "number" && Number.isFinite(c.completedAt)
    && homeCheckpointProtocolValid(c);
}

export function isDisposableHomeCheckpoint(value: unknown): value is GatewayVmHomeCheckpoint & { generation: string; instanceId: string } {
  return isGatewayVmHomeCheckpoint(value) && typeof value.generation === "string" && typeof value.instanceId === "string" && value.instanceId.length > 0;
}

export function sameHomeCheckpoint(a: GatewayVmHomeCheckpoint, b: GatewayVmHomeCheckpoint): boolean {
  return a.name === b.name && a.generation === b.generation && a.size === b.size
    && a.sha256 === b.sha256 && a.instanceId === b.instanceId && a.completedAt === b.completedAt
    && a.coverage === b.coverage && a.writerProtocol === b.writerProtocol;
}

export function vmHomeCheckpointName(at: number): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new Error("vm-home checkpoint time is invalid");
  return `${date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}.tar.gz`;
}

export function gatewayVmPodName(gatewayId: string, instanceId: string): string {
  if (!/^\d+$/.test(instanceId)) throw new Error(`gatewayVmPodName: instance id must be numeric, got ${instanceId}`);
  return `octogee-gateway-${gatewayId}-vm-${instanceId}`;
}

export const GATEWAY_VM_INSTANCE_PREFIX = "octogee-computer-";
export const GATEWAY_DESKTOP_NODE_CONTAINER = "desktop-node";
export const GATEWAY_DESKTOP_NODE_STATE_VOLUME = "desktop-node-state";
export const GATEWAY_DESKTOP_NODE_IDENTITY_VOLUME = "desktop-node-identity";
export const GATEWAY_DESKTOP_NODE_IDENTITY_DIR = "/run/octogee/desktop-node-identity";
export const GATEWAY_DESKTOP_NODE_IDENTITY_PATH = `${GATEWAY_DESKTOP_NODE_IDENTITY_DIR}/identity.json`;
export const GATEWAY_DESKTOP_NODE_NAME = "octogee-desktop";
export const GATEWAY_DESKTOP_RUNTIME_DIR = "/run/user/1000";
const GCE_INSTANCE_NAME_MAX = 63;
const GCE_INSTANCE_NAME_HASH_LENGTH = 8;

function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function gceInstanceName(prefix: string, raw: string, what: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`${what} is empty`);
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized) throw new Error(`${what} ${JSON.stringify(raw)} has no usable characters`);
  const full = `${prefix}${normalized}`;
  if (full.length <= GCE_INSTANCE_NAME_MAX) return full;
  const suffix = fnv1a32Hex(trimmed).slice(0, GCE_INSTANCE_NAME_HASH_LENGTH);
  const budget = GCE_INSTANCE_NAME_MAX - prefix.length - suffix.length - 1;
  return `${prefix}${normalized.slice(0, budget).replace(/-$/, "")}-${suffix}`;
}

export function gatewayVmInstanceName(environment: string, ownerUid: string): string {
  const env = environment.trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(env)) throw new Error(`gatewayVmInstanceName: environment ${JSON.stringify(environment)} is not a name segment`);
  return gceInstanceName(`${GATEWAY_VM_INSTANCE_PREFIX}${env}-`, ownerUid, "gatewayVmInstanceName: ownerUid");
}

export interface GatewayModelBrokerLimits {
  spendWindowUsd?: number | null;
  spendWeekUsd?: number | null;
  requestsPerMinute?: number | null;
}

export interface GatewayServiceAccountSpec {
  create?: boolean;
  annotations?: Record<string, string>;
}

export const GATEWAY_CONTROL_IDENTITY_MODES = ["shared-operator", "per-user"] as const;
export type GatewayControlIdentity = (typeof GATEWAY_CONTROL_IDENTITY_MODES)[number];
export const DEFAULT_GATEWAY_CONTROL_IDENTITY: GatewayControlIdentity = "shared-operator";

export function isGatewayControlIdentity(value: unknown): value is GatewayControlIdentity {
  return (
    typeof value === "string" &&
    (GATEWAY_CONTROL_IDENTITY_MODES as readonly string[]).includes(value)
  );
}

export function resolveGatewayControlIdentity(value: unknown): GatewayControlIdentity {
  return value === "per-user" ? "per-user" : DEFAULT_GATEWAY_CONTROL_IDENTITY;
}

export interface IsolatedGatewayAccessSpec {
  controlUiEnabled?: boolean;
  controlIdentity?: GatewayControlIdentity;
  kubeApiServerEgressCidrs?: string[];
  reason?: string;
  verifiedAt?: number;
  verifiedBy?: string;
}

export const ISOLATED_GATEWAY_LOCKED_ACCESS: IsolatedGatewayAccessSpec = {
  controlUiEnabled: false,
  reason: "runtime-trust-boundary-not-provisioned",
};

export function defaultIsolatedGatewayAccess(
  ownerUid: string | null | undefined,
): IsolatedGatewayAccessSpec {
  return ownerUid
    ? {
      controlUiEnabled: true,
      reason: "owned-runtime-gateway",
    }
    : ISOLATED_GATEWAY_LOCKED_ACCESS;
}

export function resolveIsolatedGatewayAccess(
  ownerUid: string | null | undefined,
  builderAccess: IsolatedGatewayAccessSpec | null | undefined,
): IsolatedGatewayAccessSpec {
  return {
    ...defaultIsolatedGatewayAccess(ownerUid),
    ...(builderAccess ?? {}),
  };
}

export const ISOLATED_GATEWAY_SERVICE_ACCOUNT_PREFIX = "octogee-gw-";
export const GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME = "octogee-gateway";
export const GATEWAY_ID_MAX_LENGTH = 32;
export const GATEWAY_ID_REQUIREMENT =
  "gatewayId must be a lowercase DNS-safe id, 1-32 chars, starting and ending with a letter or digit";

export const ISOLATED_GATEWAY_LOCKED_SERVICE_ACCOUNT: GatewayServiceAccountSpec = {
  create: true,
};

export function isValidGatewayId(id: unknown): id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > GATEWAY_ID_MAX_LENGTH) {
    return false;
  }
  if (!isGatewayIdEndpoint(id.charCodeAt(0))) return false;
  if (!isGatewayIdEndpoint(id.charCodeAt(id.length - 1))) return false;
  for (let i = 1; i < id.length - 1; i += 1) {
    const code = id.charCodeAt(i);
    if (!isGatewayIdEndpoint(code) && code !== 45) return false;
  }
  return true;
}

function isGatewayIdEndpoint(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

const ROLL_ROLE_SUFFIXES = ["-blue", "-green"] as const;

export const NEW_GATEWAY_ID_REQUIREMENT =
  `${GATEWAY_ID_REQUIREMENT}; the -blue/-green suffixes are reserved for roll roles`;

// Creation-time validator: roll-role suffixes are reserved so the
// deriveGatewayIdentity convention fallback is safe by construction.
// Instance ids minted by the blue/green machinery (shared-a-blue) stay valid
// under isValidGatewayId for routing and reconciliation.
export function isValidNewGatewayId(id: unknown): id is string {
  if (!isValidGatewayId(id)) return false;
  return !ROLL_ROLE_SUFFIXES.some((suffix) => id.endsWith(suffix));
}

// Resolves the durable gateway identity for an instance: the explicit
// `gateway` field when present, else a naming-convention fallback that
// strips a trailing -blue/-green roll-role suffix. Instance ids without that
// suffix are their own bare identity (for example, a shared root or one-off runtime).
export function deriveGatewayIdentity(
  gatewayId: string,
  explicitGateway?: unknown,
): string {
  if (typeof explicitGateway === "string" && explicitGateway.length > 0) {
    return explicitGateway;
  }
  for (const suffix of ROLL_ROLE_SUFFIXES) {
    if (gatewayId.endsWith(suffix)) return gatewayId.slice(0, -suffix.length);
  }
  return gatewayId;
}

export function isolatedGatewayServiceAccountName(gatewayId: string): string {
  return `${ISOLATED_GATEWAY_SERVICE_ACCOUNT_PREFIX}${gatewayId}`;
}

export function isGatewayClassControlUiAccessEnabled(
  gatewayClass: GatewayClass | undefined,
  builderAccess: IsolatedGatewayAccessSpec | undefined,
): boolean {
  return gatewayClass === "isolated" && builderAccess?.controlUiEnabled === true;
}

export function resolveUserGatewayControlState(
  data:
    | {
        gatewayClass?: unknown;
        profile?: unknown;
        imageProfile?: unknown;
        ownerUid?: unknown;
        builderAccess?: IsolatedGatewayAccessSpec;
      }
    | undefined,
  uid: string,
): { gatewayProfile: GatewayProfile; controlUiEnabled: boolean } {
  const storedClass = dualReadGatewayClassValue(data?.gatewayClass);
  const storedProfile = dualReadGatewayClassValue(data?.profile);
  const storedImageProfile = dualReadGatewayClassValue(data?.imageProfile);
  const gatewayClass = resolveGatewayClass({
    gatewayClass: isGatewayClass(storedClass) ? storedClass : undefined,
    profile: isGatewayProfile(storedProfile) ? storedProfile : undefined,
    imageProfile: isGatewayProfile(storedImageProfile) ? storedImageProfile : undefined,
  });
  const userOwns = data?.ownerUid === uid;
  return {
    gatewayProfile: gatewayClass === "isolated" ? "isolated" : "standard",
    controlUiEnabled: userOwns && isGatewayClassControlUiAccessEnabled(gatewayClass, data?.builderAccess),
  };
}

export type OperationKind =
  | "add-gateway"
  | "gateway-vm"
  | "migrate-user"
  | "retire-gateway"
  | "restart-gateway"
  | "recycle-gateway"
  | "scale-shared-member"
  | "rollout"
  | "deprovision-user"
  | "suspend-user"
  | "erase-user";

export type OperationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "rolled-back";

export const OPERATION_ORIGINS = ["automatic", "operator"] as const;
export type OperationOrigin = (typeof OPERATION_ORIGINS)[number];

export function resolveOperationOrigin(value: unknown): OperationOrigin {
  return value === "automatic" ? "automatic" : "operator";
}

export const OPERATION_AUDIT_RECORD_TYPE = "audit" as const;
export const OPERATION_AUDIT_SCHEMA_VERSION = 1 as const;

export const OPERATION_AUDIT_LIFECYCLE_STAGES = [
  "intent-recorded",
  "action-started",
  "action-completed",
  "action-partial",
  "action-failed",
] as const;
export type OperationAuditLifecycleStage =
  (typeof OPERATION_AUDIT_LIFECYCLE_STAGES)[number];

export type OperationAuditStatus = "recorded" | "in-progress" | "completed" | "failed";
export type OperationAuditOutcome = "completed" | "partial" | "failed";

export interface OperationAuditAliasPlan {
  alias: string;
  expectedTarget?: string | null;
  intendedTarget: string;
}

export type OperationAuditAliasOutcomeStatus =
  | "applied"
  | "already-applied"
  | "skipped"
  | "failed";

export interface OperationAuditAliasOutcome {
  alias: string;
  status: OperationAuditAliasOutcomeStatus;
  observedTarget?: string | null;
  error?: string;
}

export interface OperationAuditReleaseRolloutLinkage {
  releaseId?: string;
  releaseTag?: string;
  rolloutOperationId?: string;
}

export interface OperationAuditTestProvenance {
  environment: "test";
  sourceCommit?: string;
  verifiedBy?: string;
  verifiedAt?: number;
}

export interface OperationAuditPartialOutcome {
  summary: string;
  details?: Record<string, unknown>;
}

export interface OperationAuditDocument {
  recordType: typeof OPERATION_AUDIT_RECORD_TYPE;
  schemaVersion: typeof OPERATION_AUDIT_SCHEMA_VERSION;
  status: OperationAuditStatus;
  lifecycleStage: OperationAuditLifecycleStage;
  idempotencyKey: string;
  mutationFingerprint: string;
  mutation: Record<string, unknown>;
  actor: string;
  forced: boolean;
  what: string;
  why: string;
  target: Record<string, unknown>;
  preActionStatus: Record<string, unknown>;
  aliasPlan: OperationAuditAliasPlan[];
  aliasOutcomes?: OperationAuditAliasOutcome[];
  releaseRollout?: OperationAuditReleaseRolloutLinkage;
  testProvenance?: OperationAuditTestProvenance;
  outcome?: OperationAuditOutcome;
  partialOutcome?: OperationAuditPartialOutcome;
  createdAt: number;
  actionClaimId?: string;
  actionStartedAt?: number;
  actionRecoveryCount?: number;
  completedAt: number | null;
  error?: string;
}

export interface OperationAuditRecord extends OperationAuditDocument {
  id: string;
}

export type GlmOperationRecord = Operation | OperationAuditRecord;

function isAuditObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyAuditString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteAuditNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isAuditAliasPlan(value: unknown): value is OperationAuditAliasPlan[] {
  return Array.isArray(value) && value.every((entry) =>
    isAuditObject(entry) &&
    isNonEmptyAuditString(entry.alias) &&
    isNonEmptyAuditString(entry.intendedTarget) &&
    (entry.expectedTarget === undefined || entry.expectedTarget === null ||
      typeof entry.expectedTarget === "string")
  );
}

function isAuditAliasOutcomes(value: unknown): value is OperationAuditAliasOutcome[] {
  const statuses: ReadonlySet<string> = new Set([
    "applied",
    "already-applied",
    "skipped",
    "failed",
  ]);
  return Array.isArray(value) && value.every((entry) =>
    isAuditObject(entry) &&
    isNonEmptyAuditString(entry.alias) &&
    typeof entry.status === "string" && statuses.has(entry.status) &&
    (entry.observedTarget === undefined || entry.observedTarget === null ||
      typeof entry.observedTarget === "string") &&
    (entry.error === undefined || typeof entry.error === "string")
  );
}

function isAuditReleaseRollout(value: unknown): boolean {
  return isAuditObject(value) &&
    (value.releaseId === undefined || isNonEmptyAuditString(value.releaseId)) &&
    (value.releaseTag === undefined || isNonEmptyAuditString(value.releaseTag)) &&
    (value.rolloutOperationId === undefined || isNonEmptyAuditString(value.rolloutOperationId));
}

function isAuditTestProvenance(value: unknown): boolean {
  return isAuditObject(value) && value.environment === "test" &&
    (value.sourceCommit === undefined || isNonEmptyAuditString(value.sourceCommit)) &&
    (value.verifiedBy === undefined || isNonEmptyAuditString(value.verifiedBy)) &&
    (value.verifiedAt === undefined || isFiniteAuditNumber(value.verifiedAt));
}

function isAuditPartialOutcome(value: unknown): boolean {
  return isAuditObject(value) && isNonEmptyAuditString(value.summary) &&
    (value.details === undefined || isAuditObject(value.details));
}

function hasAuditClaim(value: Record<string, unknown>): boolean {
  return isNonEmptyAuditString(value.actionClaimId) && isFiniteAuditNumber(value.actionStartedAt) &&
    typeof value.actionRecoveryCount === "number" &&
    Number.isInteger(value.actionRecoveryCount) && value.actionRecoveryCount >= 0;
}

function hasRecordedAuditState(value: Record<string, unknown>): boolean {
  return value.lifecycleStage === "intent-recorded" && value.completedAt === null &&
    value.actionClaimId === undefined && value.actionStartedAt === undefined &&
    value.outcome === undefined && value.partialOutcome === undefined && value.error === undefined;
}

function hasInProgressAuditState(value: Record<string, unknown>): boolean {
  return value.lifecycleStage === "action-started" && value.completedAt === null &&
    hasAuditClaim(value) && value.outcome === undefined &&
    value.partialOutcome === undefined && value.error === undefined;
}

function hasCompletedAuditState(value: Record<string, unknown>): boolean {
  if (!hasAuditClaim(value) || !isFiniteAuditNumber(value.completedAt)) return false;
  if (value.error !== undefined) return false;
  if (value.lifecycleStage === "action-completed") {
    return value.outcome === "completed" && value.partialOutcome === undefined;
  }
  return value.lifecycleStage === "action-partial" && value.outcome === "partial" &&
    isAuditObject(value.partialOutcome) && isNonEmptyAuditString(value.partialOutcome.summary);
}

function hasFailedAuditState(value: Record<string, unknown>): boolean {
  return value.lifecycleStage === "action-failed" && value.outcome === "failed" &&
    hasAuditClaim(value) && isFiniteAuditNumber(value.completedAt) &&
    isNonEmptyAuditString(value.error);
}

function hasLegalAuditState(value: Record<string, unknown>): boolean {
  if (value.status === "recorded") return hasRecordedAuditState(value);
  if (value.status === "in-progress") return hasInProgressAuditState(value);
  if (value.status === "completed") return hasCompletedAuditState(value);
  return value.status === "failed" && hasFailedAuditState(value);
}

export function isOperationAuditRow(value: unknown): value is Record<string, unknown> & {
  recordType: typeof OPERATION_AUDIT_RECORD_TYPE;
} {
  return (
    isAuditObject(value) && value.recordType === OPERATION_AUDIT_RECORD_TYPE
  );
}

function hasRequiredAuditRecordMetadata(value: Record<string, unknown>): boolean {
  return value.schemaVersion === OPERATION_AUDIT_SCHEMA_VERSION &&
    isNonEmptyAuditString(value.idempotencyKey) &&
    isNonEmptyAuditString(value.mutationFingerprint) &&
    isAuditObject(value.mutation) &&
    isNonEmptyAuditString(value.actor) &&
    typeof value.forced === "boolean" &&
    isNonEmptyAuditString(value.what) &&
    isNonEmptyAuditString(value.why) &&
    isAuditObject(value.target) &&
    isAuditObject(value.preActionStatus) &&
    isAuditAliasPlan(value.aliasPlan) &&
    isFiniteAuditNumber(value.createdAt);
}

function isOptionalAuditField(
  value: unknown,
  validator: (value: unknown) => boolean,
): boolean {
  return value === undefined || validator(value);
}

function hasValidOptionalAuditRecordFields(value: Record<string, unknown>): boolean {
  return isOptionalAuditField(value.aliasOutcomes, isAuditAliasOutcomes) &&
    isOptionalAuditField(value.releaseRollout, isAuditReleaseRollout) &&
    isOptionalAuditField(value.testProvenance, isAuditTestProvenance) &&
    isOptionalAuditField(value.partialOutcome, isAuditPartialOutcome);
}

function hasValidOptionalAuditRecoveryCount(value: Record<string, unknown>): boolean {
  return value.actionRecoveryCount === undefined ||
    (typeof value.actionRecoveryCount === "number" &&
      Number.isInteger(value.actionRecoveryCount) && value.actionRecoveryCount >= 0);
}

export function isOperationAuditRecord(value: unknown): value is OperationAuditDocument {
  if (!isOperationAuditRow(value)) return false;
  return hasRequiredAuditRecordMetadata(value) &&
    hasValidOptionalAuditRecordFields(value) &&
    hasValidOptionalAuditRecoveryCount(value) &&
    hasLegalAuditState(value);
}

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface MigrationProgressRecord {
  phase: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  at: number;
  elapsedMs?: number;
  migrationId: string;
  slug: string;
  source: string;
  attempt?: number;
}

const MIGRATION_PROGRESS_STATUSES = new Set(["pending", "running", "done", "failed", "skipped"]);

export function isMigrationProgressRecord(value: unknown): value is MigrationProgressRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.phase === "string" &&
    typeof record.status === "string" && MIGRATION_PROGRESS_STATUSES.has(record.status) &&
    typeof record.at === "number" &&
    typeof record.migrationId === "string" &&
    typeof record.slug === "string" &&
    typeof record.source === "string";
}

export interface OperationStep {
  name: string;
  status: StepStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  detail?: string;
}

export function readSchedulerMigrationIdentity(operationId: unknown, migrationId: unknown): { attempt: number; claimStartedAt: number } | null {
  if (typeof operationId !== "string" || !operationId || typeof migrationId !== "string") return null;
  const prefix = `mig-${operationId}:scheduler:`;
  if (!migrationId.startsWith(prefix)) return null;
  const parts = migrationId.slice(prefix.length).split(":");
  if (parts.length !== 3 || parts[1] !== "claim") return null;
  const attempt = Number(parts[0]);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || String(attempt) !== parts[0]) return null;
  const claimStartedAt = Number(parts[2]);
  if (!Number.isSafeInteger(claimStartedAt) || claimStartedAt < 1 || String(claimStartedAt) !== parts[2]) return null;
  return { attempt, claimStartedAt };
}

export interface UserActivationTargetRollbackProof {
  operationId: string;
  migrationId: string;
  uid: string;
  slug: string;
  sourceGatewayId: string;
  sourceEpoch: number;
  targetGatewayId: string;
  leaseId: string;
  generation: number;
  liveRelease: number;
  desiredRelease: number;
  latestRelease: number;
  retainedPodUid: string;
  discardedPodUid: string | null;
  rollOperationId: string;
  rollClaimStartedAt: number;
  completedAt: number;
}

export interface MigrationForwardRecovery {
  schemaVersion: 1;
  phase: "source-flushed";
  sourceEpoch: number;
  sourceSystemConfigCommit?: string;
  targetReleased?: true;
}

export interface SchedulerHandoffState {
  /** New user moves use best-effort schedule snapshots, not native handoff. */
  scheduleTransfer?: true;
  forwardRecovery?: MigrationForwardRecovery;
  migrationId: string;
  fromGatewayId: string;
  toGatewayId: string;
  uid: string;
  slug: string;
  stageAfterCutover?: true;
  stagedAt?: number;
  sourceRecovery?: {
    migrationId: string;
    sourceEpoch: number;
    steps: OperationStep[];
    targetRollback?: UserActivationTargetRollbackProof;
  };
}

export interface SourceTransferAuthority {
  targetIdentity: string;
  targetGatewayId: string;
  targetName: string;
  targetIp: string;
  targetVm: boolean;
  operationId: string;
  claimStartedAt: number;
  migrationId: string;
  uid: string;
  slug: string;
  sourceGatewayId: string;
  assignmentEpoch: number;
  namespace: string;
  podName: string;
  podUid: string;
  image: string;
}
export interface SourceTransferExecution extends SourceTransferAuthority {
  executionId: string;
  status: 'reserved' | 'preparing' | 'prepared' | 'dispatched' | 'transferred' | 'failed' | 'unresolved';
  exitCode?: number;
  failureReason?: 'not-dispatched';
  targetCleanup?: 'pending' | 'complete';
}

export interface Operation {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  createdBy: string;
  origin?: OperationOrigin;
  createdAt: number;
  startedAt: number | null;
  queuedAt?: number;
  firstStartedAt?: number | null;
  lastResumedAt?: number;
  completedAt: number | null;
  input: Record<string, unknown>;
  steps: OperationStep[];
  error?: string;
  rolledBack?: boolean;
  // Heartbeat for the stuck-op reaper: bumped every time a step is reported and on
  // resume-adoption. Lets a long or resumed roll keep proving liveness so it is reaped
  // only when progress genuinely stalls, not on absolute age since first claim.
  lastProgressAt?: number;
  // Incremented each time a controller re-adopts this op after a restart (observability).
  resumeCount?: number;
  // A serially-exclusive op (e.g. rollout) parked pending because a conflicting op of
  // the same kind is running. Human-readable, e.g. "walter-blue → walter-green". Cleared
  // once the op is claimed.
  waitingOn?: string | null;
  // Set when a transient failure schedules an automatic retry; the op stays `pending`
  // until this passes. Cleared once claimed.
  nextAttemptAt?: number | null;
  // Total handler invocations so far (first run = 1). Ordinary transient work
  // caps at MAX_OPERATION_ATTEMPTS; explicit level-triggered obligations may exceed it.
  attempts?: number;
  // One entry per FAILED attempt — retried or terminal — preserving that attempt's
  // steps/error/classification (the live `steps` field resets on retry). Successful
  // completions append nothing.
  attemptHistory?: OperationAttemptRecord[];
  output?: Record<string, unknown>;
  progress?: MigrationProgressRecord[];
  userMigrationV2?: UserMigrationV2State;
  sourceTransferExecution?: SourceTransferExecution;
  schedulerHandoff?: SchedulerHandoffState;
  schedulerHandoffReleased?: boolean;
  schedulerHandoffReleasedAt?: number;
  schedulerHandoffLost?: string;
  cutoverCommittedAt?: number;
}

export type UserMigrationV2Phase =
  | "initialized"
  | "keysSynced"
  | "preSynced"
  | "sourceQuiesced"
  | "finalSynced"
  | "targetVerified"
  | "cutover"
  | "sourceRetired"
  | "complete"
  | "abortIntent"
  | "abortTargetUnmounted"
  | "aborted";

export interface UserMigrationV2GatewayRootFence {
  gatewayId: string;
  updatedAt: number;
  latestRelease: number;
  desiredRelease: number;
  liveRelease: number;
  gatewayClass: "isolated";
  ownerUid: string;
  builderSlug: string;
  configHash: string;
}

export interface UserMigrationV2State {
  phase: UserMigrationV2Phase;
  operationId: string;
  migrationId: string;
  uid: string;
  slug: string;
  sourceGatewayId: string;
  sourceRelease: number;
  sourceEpoch: number;
  sourceAssignmentMode: "assigned" | "unassigned-live";
  sourceRootFence: UserMigrationV2GatewayRootFence;
  targetGatewayId: string;
  targetRelease: number;
  targetRootFence: UserMigrationV2GatewayRootFence;
  sourceSystemConfigCommit?: string;
  cutoverAt?: number;
  schedulerStagedAt?: number;
  sourceRetiredAt?: number;
  completedAt?: number;
  abortFromPhase?: UserMigrationV2Phase;
  abortReason?: string;
  abortIntentAt?: number;
  abortedAt?: number;
}

export interface OperationAttemptRecord {
  attempt: number;
  startedAt: number;
  completedAt: number;
  error: string;
  classification: "transient" | "terminal";
  steps: OperationStep[];
}

export interface HelmInstanceValue {
  enabled: boolean;
  image: { repository: string; tag: string };
  gatewayId: string;

  chartFingerprint?: string;
  deploymentIntentFingerprint?: string;
  serviceAccountName?: string;
  serviceAccount?: GatewayServiceAccountSpec;
  gatewayContainerSecurityContext?: Record<string, unknown>;
  builderAccess?: IsolatedGatewayAccessSpec;

  profile?: GatewayProfile;
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;

  sizingTier?: SizingTier;

  replicas?: number;
}

export type HelmInstancesMap = Record<string, HelmInstanceValue>;

export const GLM_GATEWAYS_COLLECTION = "glmGateways";
export const GLM_OPERATIONS_COLLECTION = "glmOperations";
export const GLM_MIGRATION_TRANSFER_TASKS_COLLECTION =
  "glmMigrationTransferTasks";

export function isGatewayClass(value: unknown): value is GatewayClass {
  return (
    typeof value === "string" &&
    (GATEWAY_CLASSES as readonly string[]).includes(value)
  );
}

export function isGatewayProfile(value: unknown): value is GatewayProfile {
  return (
    typeof value === "string" &&
    (GATEWAY_PROFILES as readonly string[]).includes(value)
  );
}

export function resolveGatewayClass(input: {
  gatewayClass?: GatewayClass;
  profile?: GatewayProfile;
  imageProfile?: GatewayImageProfile;
}): GatewayClass {
  return input.gatewayClass === "isolated" ? "isolated" : "shared";
}

export function resolveGatewayImageProfile(input: {
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
  profile?: GatewayProfile;
}): GatewayImageProfile {
  if (input.imageProfile === "isolated") return "isolated";
  if (input.imageProfile === "standard") return "standard";
  if (!input.gatewayClass && input.profile === "isolated") return "isolated";
  return resolveGatewayClass(input) === "isolated" ? "isolated" : "standard";
}

export interface GatewayVmBootRecoverySample {
  currentPointId: string | null;
  retainedPoints: number;
  ready: boolean;
  bundleVersion: string;
  freeBytes: number;
}

export function isGatewayVmBootRecoverySample(value: unknown): value is GatewayVmBootRecoverySample {
  const r = value as Partial<GatewayVmBootRecoverySample> | null;
  return !!r && typeof r.ready === "boolean" && typeof r.bundleVersion === "string" && r.bundleVersion.length > 0
    && Number.isSafeInteger(r.retainedPoints) && r.retainedPoints! >= 0 && r.retainedPoints! <= 1000
    && Number.isSafeInteger(r.freeBytes) && r.freeBytes! >= 0
    && (r.currentPointId === null || typeof r.currentPointId === "string" && /^[a-z][a-z0-9-]{0,62}-[a-f0-9]{32}$/u.test(r.currentPointId));
}
