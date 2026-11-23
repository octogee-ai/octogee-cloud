const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const POD_REPLACEMENT_RECENT_WINDOW_MS = 7 * DAY_MS;
export const POD_REPLACEMENT_WARNING_THRESHOLD_24H = 3;
export const POD_REPLACEMENT_MAX_RETAINED = 64;

export const GATEWAY_POD_REPLACEMENT_SCHEMA = "octogee.gateway-pod-replacement.v1" as const;

// A gateway pod as the fleet controller last saw it: its identity, the ReplicaSet that owns
// it, and the GCE identity of its node. The node facts are captured while the
// node still exists — a Spot preemption destroys the instance, so they can never
// be recovered afterwards, and they are what joins a lost pod to the
// octogee_spot_preemptions log metric by instance_id.
export interface GatewayPodPlacement {
  uid: string;
  name: string;
  replicaSetUid: string | null;
  nodeName: string | null;
  providerId?: string;
  instanceId: string | null;
  nodePool: string | null;
}

// glmGateways/{id}.podReplacements — gateway pods that vanished while their
// ReplicaSet still wanted them running. A Spot preemption deletes the pod object
// along with its node, so the container restart count stays 0 and the
// Kubernetes event expires within the hour; the vacated identity is the only
// surviving evidence.
export interface GatewayPodReplacements {
  recentAt: number[];
  lastAt: number | null;
  lastVacatedPodUid: string | null;
  lastVacatedNodeName: string | null;
  lastVacatedInstanceId: string | null;
  lastVacatedNodePool: string | null;
  total: number;
}

// Derived against the reader's clock, so it can never report a count that was
// only accurate when the document was last written.
export interface GatewayPodReplacementSummary {
  count24h: number;
  count7d: number;
  lastAgeMs: number | null;
  lastVacatedNodeName: string | null;
  lastVacatedInstanceId: string | null;
  lastVacatedNodePool: string | null;
  total: number;
  warn: boolean;
}

export const EMPTY_GATEWAY_POD_REPLACEMENTS: GatewayPodReplacements = {
  recentAt: [],
  lastAt: null,
  lastVacatedPodUid: null,
  lastVacatedNodeName: null,
  lastVacatedInstanceId: null,
  lastVacatedNodePool: null,
  total: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isGatewayPodPlacement(value: unknown): value is GatewayPodPlacement {
  if (!isRecord(value)) return false;
  return (
    typeof value.uid === "string" &&
    value.uid.length > 0 &&
    typeof value.name === "string" &&
    isNullableString(value.replicaSetUid) &&
    isNullableString(value.nodeName) &&
    (value.providerId === undefined || typeof value.providerId === "string") &&
    isNullableString(value.instanceId) &&
    isNullableString(value.nodePool)
  );
}

export function isGatewayPodReplacements(value: unknown): value is GatewayPodReplacements {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.recentAt) &&
    value.recentAt.every(isEpochMs) &&
    (value.lastAt === null || isEpochMs(value.lastAt)) &&
    isNullableString(value.lastVacatedPodUid) &&
    isNullableString(value.lastVacatedNodeName) &&
    isNullableString(value.lastVacatedInstanceId) &&
    isNullableString(value.lastVacatedNodePool) &&
    typeof value.total === "number" &&
    Number.isSafeInteger(value.total) &&
    value.total >= 0
  );
}

// A loss stamped ahead of `now` cannot be counted against a window that ends at
// `now`; clock skew must not inflate the indicator.
function countWithin(recentAt: readonly number[], now: number, windowMs: number): number {
  return recentAt.filter((at) => at <= now && now - at < windowMs).length;
}

export function summarizeGatewayPodReplacements(
  value: GatewayPodReplacements | null | undefined,
  now: number,
): GatewayPodReplacementSummary {
  if (!value) {
    return {
      count24h: 0,
      count7d: 0,
      lastAgeMs: null,
      lastVacatedNodeName: null,
      lastVacatedInstanceId: null,
      lastVacatedNodePool: null,
      total: 0,
      warn: false,
    };
  }
  const count24h = countWithin(value.recentAt, now, DAY_MS);
  return {
    count24h,
    count7d: countWithin(value.recentAt, now, POD_REPLACEMENT_RECENT_WINDOW_MS),
    lastAgeMs: value.lastAt === null ? null : Math.max(0, now - value.lastAt),
    lastVacatedNodeName: value.lastVacatedNodeName,
    lastVacatedInstanceId: value.lastVacatedInstanceId,
    lastVacatedNodePool: value.lastVacatedNodePool,
    total: value.total,
    warn: count24h >= POD_REPLACEMENT_WARNING_THRESHOLD_24H,
  };
}

// Only entries older than the window are dropped. An entry stamped ahead of
// `now` is excluded from the counts, not deleted — a reconcile pass that ran on
// an older clock must not erase a loss a newer pass already recorded.
export function pruneGatewayPodReplacementWindow(
  recentAt: readonly number[],
  now: number,
): number[] {
  return recentAt.filter((at) => now - at < POD_REPLACEMENT_RECENT_WINDOW_MS);
}
