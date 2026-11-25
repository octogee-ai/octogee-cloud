import {
  isValidGatewayId,
  type GatewayDesiredStatus,
} from "./glm.js";

export const SHARED_POOL_SLOT_ID_PATTERN = /^shared-[a-z0-9]+$/;
export const SHARED_POOL_SLOT_ID_REQUIREMENT =
  'a shared gatewayId must be "shared-" followed by lowercase letters or digits';
export const DEFAULT_SHARED_GATEWAY_AUTOSCALING_ENABLED = true;
export const DEFAULT_SHARED_GATEWAY_USERS_PER_GATEWAY = 10;
export const DEFAULT_SHARED_GATEWAY_MIN_GATEWAYS = 1;
export const DEFAULT_SHARED_GATEWAY_MAX_GATEWAYS = 32;
const SHARED_POOL_MEMBER_STATUSES: ReadonlySet<string> = new Set(["running", "draining", "paused"]);

export interface SharedGatewayAutoscalingConfig {
  enabled: boolean;
  buildersPerGateway: number;
  minGateways: number;
  maxGateways: number;
}

export interface SharedPoolScalingMember {
  gatewayId: string;
  desiredStatus: GatewayDesiredStatus;
  assignmentCount: number;
  mountedCount: number;
  incomingMigrationCount: number;
  converged: boolean;
  platformCurrent: boolean;
}

export const SHARED_POOL_REPLACEMENT_STALL_MS = 30 * 60_000;

export interface SharedPoolReplacement {
  sourceGatewayId: string;
  targetGatewayId: string;
  updatedAt: number;
}

function isSharedPoolReplacement(value: unknown): value is SharedPoolReplacement {
  return isRecord(value) &&
    isSharedPoolSlotId(value.sourceGatewayId) &&
    isSharedPoolSlotId(value.targetGatewayId) &&
    value.sourceGatewayId !== value.targetGatewayId &&
    typeof value.updatedAt === "number" && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0;
}

export function parseSharedPoolReplacements(value: unknown): SharedPoolReplacement[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(isSharedPoolReplacement)) {
    throw new Error("shared pool replacement state is malformed");
  }
  const sources = new Set(value.map((replacement) => replacement.sourceGatewayId));
  const targets = new Set(value.map((replacement) => replacement.targetGatewayId));
  if (
    sources.size !== value.length ||
    targets.size !== value.length ||
    [...sources].some((gatewayId) => targets.has(gatewayId))
  ) {
    throw new Error("shared pool replacement state pairs a gateway twice");
  }
  return value.map(({ sourceGatewayId, targetGatewayId, updatedAt }) => ({ sourceGatewayId, targetGatewayId, updatedAt }));
}

export interface SharedPoolScalingInput {
  config: SharedGatewayAutoscalingConfig;
  members: readonly SharedPoolScalingMember[];
  userDemandCount: number;
  now: number;
  replacements?: readonly SharedPoolReplacement[];
}

export type SharedPoolScalingDecision =
  | {
      kind: "hold";
      reason:
        | "disabled"
        | "steady"
        | "converging"
        | "draining"
        | "replica-ceiling"
        | "malformed-config"
        | "malformed-state";
    }
  | {
      kind: "resume-member";
      gatewayId: string;
      reason: "minimum-replicas" | "scale-out" | "cancel-drain";
    }
  | { kind: "mint-slot"; reason: "minimum-replicas" | "scale-out" }
  | { kind: "mint-slot"; reason: "platform-replacement"; replacesGatewayId: string }
  | { kind: "finish-replacement"; sourceGatewayId: string; targetGatewayId: string }
  | { kind: "supersede-replacement"; gatewayId: string }
  | { kind: "begin-drain"; gatewayId: string }
  | { kind: "retire-member"; gatewayId: string }
  | { kind: "max-capacity"; assignmentCount: number; hotMemberCount: number };

export interface SharedGatewayPoolConfig {
  defaultGatewayId: string;
  sharedGatewayIds: readonly string[];
  sharedGatewayAutoscaling?: SharedGatewayAutoscalingConfig;
}

export interface SharedGatewayPoolCandidate {
  gatewayId: string;
  gatewayClass: string;
  desiredStatus: string;
  ready: boolean;
  serving: boolean;
  heartbeatFresh: boolean;
  liveReleaseReady: boolean;
  rosterComplete: boolean;
  incomingMigrationCount: number;
  assignmentCount: number;
}

export type SharedGatewaySelection =
  | {
      kind: "selected";
      gatewayId: string;
      load: number;
      retainedCurrent: boolean;
    }
  | { kind: "blocked"; reason: "no-accepting-shared-gateway" };

export interface SharedGatewayRebalance {
  fromGatewayId: string;
  toGatewayId: string;
}

export interface SharedPoolMemberRoot {
  gatewayId: string;
  gatewayClass: unknown;
  desiredStatus: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function isSharedPoolSlotId(id: unknown): id is string {
  return typeof id === "string" && SHARED_POOL_SLOT_ID_PATTERN.test(id);
}

export function compareSharedGatewayIds(left: string, right: string): number {
  return left.localeCompare(right);
}

export function isSharedPoolMemberRoot(root: SharedPoolMemberRoot): boolean {
  return isValidGatewayId(root.gatewayId) &&
    root.gatewayClass === "shared" &&
    SHARED_POOL_MEMBER_STATUSES.has(String(root.desiredStatus));
}

export const SHARED_POOL_SCALER_CREATOR = "glm-controller-shared-pool-scaler";

export type SharedGatewayAddedBy = "automation" | "operator";

export function sharedGatewayAddedBy(root: { readonly createdBy: string }): SharedGatewayAddedBy {
  return root.createdBy === SHARED_POOL_SCALER_CREATOR ? "automation" : "operator";
}

export function sharedPoolMemberIds(roots: readonly SharedPoolMemberRoot[]): string[] {
  return [...new Set(roots.filter(isSharedPoolMemberRoot).map((root) => root.gatewayId))]
    .sort(compareSharedGatewayIds);
}

export function deriveSharedGatewayPoolConfig(
  roots: readonly SharedPoolMemberRoot[],
  sharedGatewayAutoscaling?: SharedGatewayAutoscalingConfig,
): SharedGatewayPoolConfig | null {
  const sharedGatewayIds = sharedPoolMemberIds(roots);
  if (sharedGatewayIds.length === 0) return null;
  const running = new Set(
    roots
      .filter((root) => isSharedPoolMemberRoot(root) && root.desiredStatus === "running")
      .map((root) => root.gatewayId),
  );
  const defaultGatewayId =
    sharedGatewayIds.find((gatewayId) => running.has(gatewayId)) ?? sharedGatewayIds[0]!;
  return {
    defaultGatewayId,
    sharedGatewayIds: [
      defaultGatewayId,
      ...sharedGatewayIds.filter((gatewayId) => gatewayId !== defaultGatewayId),
    ],
    ...(sharedGatewayAutoscaling ? { sharedGatewayAutoscaling } : {}),
  };
}

export function parseSharedGatewayPoolConfig(value: unknown): SharedGatewayPoolConfig | null {
  if (!isRecord(value) || !isValidGatewayId(value.defaultGatewayId)) return null;
  const rawSharedGatewayIds = value.sharedGatewayIds;
  if (!Array.isArray(rawSharedGatewayIds) || rawSharedGatewayIds.length === 0) return null;
  if (
    rawSharedGatewayIds[0] !== value.defaultGatewayId ||
    !rawSharedGatewayIds.every(isValidGatewayId) ||
    new Set(rawSharedGatewayIds).size !== rawSharedGatewayIds.length
  ) {
    return null;
  }
  const sharedGatewayAutoscaling = value.sharedGatewayAutoscaling === undefined
    ? undefined
    : parseSharedGatewayAutoscalingConfig(value.sharedGatewayAutoscaling);
  if (value.sharedGatewayAutoscaling !== undefined && sharedGatewayAutoscaling === null) {
    return null;
  }
  return {
    defaultGatewayId: value.defaultGatewayId,
    sharedGatewayIds: rawSharedGatewayIds,
    ...(sharedGatewayAutoscaling ? { sharedGatewayAutoscaling } : {}),
  };
}

function isValidUsersPerGateway(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 2;
}

function isGatewayCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseSharedGatewayAutoscalingConfig(
  value: unknown,
): SharedGatewayAutoscalingConfig | null {
  if (value !== undefined && !isRecord(value)) return null;
  const config = value ?? {};
  const enabled = config.enabled ?? DEFAULT_SHARED_GATEWAY_AUTOSCALING_ENABLED;
  const buildersPerGateway =
    config.buildersPerGateway ?? DEFAULT_SHARED_GATEWAY_USERS_PER_GATEWAY;
  const minGateways = config.minGateways ?? DEFAULT_SHARED_GATEWAY_MIN_GATEWAYS;
  const maxGateways = config.maxGateways ?? DEFAULT_SHARED_GATEWAY_MAX_GATEWAYS;
  if (
    typeof enabled !== "boolean" ||
    !isValidUsersPerGateway(buildersPerGateway) ||
    !isGatewayCount(minGateways) ||
    !isGatewayCount(maxGateways) ||
    maxGateways < 1 ||
    minGateways > maxGateways
  ) {
    return null;
  }
  return { enabled, buildersPerGateway, minGateways, maxGateways };
}

export function authoritativeSharedGatewayLoad(candidate: SharedGatewayPoolCandidate): number {
  return candidate.assignmentCount + candidate.incomingMigrationCount;
}

export function isAcceptingSharedGateway(
  config: SharedGatewayPoolConfig,
  candidate: SharedGatewayPoolCandidate,
): boolean {
  return (
    config.sharedGatewayIds.includes(candidate.gatewayId) &&
    candidate.gatewayClass === "shared" &&
    candidate.desiredStatus === "running" &&
    candidate.ready &&
    candidate.serving &&
    candidate.heartbeatFresh &&
    candidate.liveReleaseReady &&
    isNonNegativeInteger(candidate.assignmentCount) &&
    isNonNegativeInteger(candidate.incomingMigrationCount)
  );
}

export function isSettledSharedGateway(
  config: SharedGatewayPoolConfig,
  candidate: SharedGatewayPoolCandidate,
): boolean {
  return isAcceptingSharedGateway(config, candidate) && candidate.rosterComplete;
}

export type SharedGatewayPlacementPurpose = "initial-placement" | "migration";

function sharedGatewayAcceptsFor(
  purpose: SharedGatewayPlacementPurpose,
): (config: SharedGatewayPoolConfig, candidate: SharedGatewayPoolCandidate) => boolean {
  return purpose === "migration" ? isSettledSharedGateway : isAcceptingSharedGateway;
}

export interface SharedGatewayPlatformPreference {
  platformCurrentGatewayIds: readonly string[];
  buildersPerGateway: number;
}

export function platformPreferredSharedGatewayCandidates(input: {
  config: SharedGatewayPoolConfig;
  candidates: readonly SharedGatewayPoolCandidate[];
  purpose: SharedGatewayPlacementPurpose;
  preference: SharedGatewayPlatformPreference;
  currentGatewayId?: string | null;
}): SharedGatewayPoolCandidate[] {
  const accepts = sharedGatewayAcceptsFor(input.purpose);
  const platformCurrent = new Set(input.preference.platformCurrentGatewayIds);
  const currentWithHeadroom = input.candidates.filter((candidate) =>
    platformCurrent.has(candidate.gatewayId) &&
    accepts(input.config, candidate) &&
    authoritativeSharedGatewayLoad(candidate) < input.preference.buildersPerGateway);
  if (currentWithHeadroom.length === 0) return [...input.candidates];
  return input.candidates.filter((candidate) =>
    currentWithHeadroom.includes(candidate) || candidate.gatewayId === input.currentGatewayId);
}

export function stableGatewayUidHash(uid: string): number {
  let hash = 2166136261;
  for (let index = 0; index < uid.length; index += 1) {
    hash ^= uid.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function leastLoadedGatewayForUid(
  uid: string,
  candidates: readonly SharedGatewayPoolCandidate[],
): SharedGatewayPoolCandidate {
  const leastLoad = Math.min(...candidates.map(authoritativeSharedGatewayLoad));
  const ties = candidates
    .filter((candidate) => authoritativeSharedGatewayLoad(candidate) === leastLoad)
    .slice()
    .sort((left, right) => compareSharedGatewayIds(left.gatewayId, right.gatewayId));
  return ties[stableGatewayUidHash(uid) % ties.length]!;
}

export function selectSharedGateway(input: {
  uid: string;
  config: SharedGatewayPoolConfig;
  candidates: readonly SharedGatewayPoolCandidate[];
  purpose: SharedGatewayPlacementPurpose;
  currentGatewayId?: string | null;
  buildersPerGateway: number;
}): SharedGatewaySelection {
  const accepts = sharedGatewayAcceptsFor(input.purpose);
  const destinations = input.candidates.filter((candidate) =>
    accepts(input.config, candidate) &&
    (input.purpose !== "initial-placement" ||
      authoritativeSharedGatewayLoad(candidate) < input.buildersPerGateway));
  const current = input.currentGatewayId === undefined || input.currentGatewayId === null
    ? undefined
    : input.candidates.find((candidate) =>
      candidate.gatewayId === input.currentGatewayId && isAcceptingSharedGateway(input.config, candidate));
  const retained = (candidate: SharedGatewayPoolCandidate): SharedGatewaySelection => ({
    kind: "selected",
    gatewayId: candidate.gatewayId,
    load: authoritativeSharedGatewayLoad(candidate),
    retainedCurrent: true,
  });
  if (destinations.length === 0) {
    return current ? retained(current) : { kind: "blocked", reason: "no-accepting-shared-gateway" };
  }

  const selected = leastLoadedGatewayForUid(input.uid, destinations);
  if (
    current &&
    authoritativeSharedGatewayLoad(current) - authoritativeSharedGatewayLoad(selected) <= 1
  ) {
    return retained(current);
  }
  return {
    kind: "selected",
    gatewayId: selected.gatewayId,
    load: authoritativeSharedGatewayLoad(selected),
    retainedCurrent: false,
  };
}

export function planSharedGatewayRebalance(input: {
  config: SharedGatewayPoolConfig;
  candidates: readonly SharedGatewayPoolCandidate[];
}): SharedGatewayRebalance | null {
  const accepting = input.candidates
    .filter((candidate) => isSettledSharedGateway(input.config, candidate))
    .slice();
  if (accepting.length < 2) return null;
  accepting.sort((left, right) => {
    const loadDifference = authoritativeSharedGatewayLoad(left) - authoritativeSharedGatewayLoad(right);
    return loadDifference !== 0 ? loadDifference : compareSharedGatewayIds(left.gatewayId, right.gatewayId);
  });
  const to = accepting[0]!;
  const from = accepting[accepting.length - 1]!;
  return authoritativeSharedGatewayLoad(from) - authoritativeSharedGatewayLoad(to) >= 2
    ? { fromGatewayId: from.gatewayId, toGatewayId: to.gatewayId }
    : null;
}
