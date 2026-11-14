import {
  GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME,
  resolveIsolatedGatewayAccess,
  ISOLATED_GATEWAY_LOCKED_SERVICE_ACCOUNT,
  isolatedGatewayServiceAccountName,
  resolveGatewayClass,
  resolveGatewayImageProfile,
  type GatewayDesiredState,
  type HelmInstanceValue,
  type HelmInstancesMap,
} from "@octogee/shared/types/glm";
import { resolveGatewayImageRepository } from "./gateway-profiles.js";
import { isSizingTier } from "@octogee/shared/types/sizing";
import { withoutGatewayWorkloadIdentity } from "./gateway-service-account-policy.js";

export type ReconcileChange =
  | { kind: "create"; gatewayId: string; to: HelmInstanceValue }
  | { kind: "update"; gatewayId: string; from: HelmInstanceValue; to: HelmInstanceValue }
  | { kind: "drift"; gatewayId: string; current: HelmInstanceValue };

export function buildInstancesMap(
  desired: GatewayDesiredState[],
  chartFingerprint?: string,
  apiServerEgressCidrs: readonly string[] = [],
): HelmInstancesMap {
  const out: HelmInstancesMap = {};
  for (const d of desired) {
    if (d.desiredStatus === "retired") continue;
    out[d.gatewayId] = buildHelmInstanceValue(
      d,
      chartFingerprint,
      apiServerEgressCidrs,
    );
  }
  return out;
}

export function buildHelmTargetMap(
  desired: GatewayDesiredState[],
  actual: HelmInstancesMap,
  mountedByGatewayId: Map<string, readonly string[]> = new Map(),
  chartFingerprint?: string,
  apiServerEgressCidrs: readonly string[] = [],
): HelmInstancesMap {
  const out: HelmInstancesMap = { ...actual };
  for (const d of desired) {
    if (d.desiredStatus === "retired") {
      const mounted = mountedByGatewayId.get(d.gatewayId);

      if (mounted === undefined || mounted.length === 0) {
        delete out[d.gatewayId];
      }
      continue;
    }
    out[d.gatewayId] = buildHelmInstanceValue(
      d,
      chartFingerprint,
      apiServerEgressCidrs,
    );
  }
  return out;
}

function resolveGatewayHelmKnobs(d: GatewayDesiredState): Pick<
  HelmInstanceValue,
  "serviceAccountName" | "serviceAccount" | "builderAccess"
> {
  const gatewayClass = resolveGatewayClass(d);
  let serviceAccountName = d.serviceAccountName;
  let serviceAccount = withoutGatewayWorkloadIdentity(d.serviceAccount);
  const generatedGatewayServiceAccountName = isolatedGatewayServiceAccountName(d.gatewayId);
  if (
    (!serviceAccountName || serviceAccountName === GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME)
  ) {
    serviceAccountName = generatedGatewayServiceAccountName;
  }
  if (
    gatewayClass === "isolated" &&
    serviceAccountName === generatedGatewayServiceAccountName &&
    !serviceAccount
  ) {
    serviceAccount = ISOLATED_GATEWAY_LOCKED_SERVICE_ACCOUNT;
  }
  if (
    gatewayClass !== "isolated" &&
    serviceAccountName === generatedGatewayServiceAccountName &&
    !serviceAccount
  ) {
    serviceAccount = { create: true };
  }
  const builderAccess =
    gatewayClass === "isolated"
      ? resolveIsolatedGatewayAccess(d.ownerUid, d.builderAccess)
      : d.builderAccess;
  return {
    serviceAccountName,
    serviceAccount,
    builderAccess,
  };
}

function injectApiServerEgress(
  builderAccess: HelmInstanceValue["builderAccess"],
  apiServerEgressCidrs: readonly string[],
): HelmInstanceValue["builderAccess"] {
  if (!builderAccess?.controlUiEnabled || apiServerEgressCidrs.length === 0) {
    return builderAccess;
  }
  return { ...builderAccess, kubeApiServerEgressCidrs: [...apiServerEgressCidrs] };
}

interface OptionalHelmFields {
  d: GatewayDesiredState;
  chartFingerprint?: string;
  serviceAccountName?: string;
  serviceAccount?: HelmInstanceValue["serviceAccount"];
  builderAccess?: HelmInstanceValue["builderAccess"];
  gatewayClass: ReturnType<typeof resolveGatewayClass>;
  imageProfile: ReturnType<typeof resolveGatewayImageProfile>;
}

function desiredReplicas(d: GatewayDesiredState): number {
  return d.desiredStatus === "paused" ? 0 : 1;
}

function withOptionalHelmFields(
  instance: HelmInstanceValue,
  fields: OptionalHelmFields,
): HelmInstanceValue {
  const out: HelmInstanceValue = { ...instance };
  if (fields.chartFingerprint) out.chartFingerprint = fields.chartFingerprint;
  if (fields.serviceAccountName) out.serviceAccountName = fields.serviceAccountName;
  if (fields.serviceAccount) out.serviceAccount = fields.serviceAccount;
  if (fields.d.gatewayContainerSecurityContext) {
    out.gatewayContainerSecurityContext = fields.d.gatewayContainerSecurityContext;
  }
  if (fields.builderAccess) out.builderAccess = fields.builderAccess;
  if (fields.gatewayClass !== "shared") out.gatewayClass = fields.gatewayClass;
  if (fields.imageProfile !== "standard") {
    out.imageProfile = fields.imageProfile;
    out.profile = fields.imageProfile;
  }
  if (isSizingTier(fields.d.sizingTier)) out.sizingTier = fields.d.sizingTier;
  return out;
}

function buildHelmInstanceValue(
  d: GatewayDesiredState,
  chartFingerprint?: string,
  apiServerEgressCidrs: readonly string[] = [],
): HelmInstanceValue {
  const gatewayClass = resolveGatewayClass(d);
  const imageProfile = resolveGatewayImageProfile(d);
  const {
    serviceAccountName,
    serviceAccount: resolvedServiceAccount,
    builderAccess: baseAccess,
  } = resolveGatewayHelmKnobs(d);
  const builderAccess = injectApiServerEgress(baseAccess, apiServerEgressCidrs);
  return withOptionalHelmFields(
    {
      enabled: true,
      image: { repository: resolveGatewayImageRepository(d), tag: d.imageTag },
      gatewayId: d.gatewayId,
      replicas: desiredReplicas(d),
    },
    {
      d,
      chartFingerprint,
      serviceAccountName,
      serviceAccount: resolvedServiceAccount,
      builderAccess,
      gatewayClass,
      imageProfile,
    },
  );
}

export interface DiffOptions {
  compareChartFingerprint?: boolean;
}

export function diffInstancesMap(
  actual: HelmInstancesMap,
  desired: HelmInstancesMap,
  opts: DiffOptions = {},
): ReconcileChange[] {
  const compareChartFingerprint = opts.compareChartFingerprint ?? true;
  const changes: ReconcileChange[] = [];
  const allNames = new Set([
    ...Object.keys(actual),
    ...Object.keys(desired),
  ]);
  const actualEntries = new Map(Object.entries(actual));
  const desiredEntries = new Map(Object.entries(desired));
  for (const name of allNames) {
    const a = actualEntries.get(name);
    const d = desiredEntries.get(name);
    if (!a && d) {
      changes.push({ kind: "create", gatewayId: name, to: d });
    } else if (a && !d) {
      changes.push({ kind: "drift", gatewayId: name, current: a });
    } else if (a && d && !instanceEqual(a, d, compareChartFingerprint)) {
      changes.push({ kind: "update", gatewayId: name, from: a, to: d });
    }
  }
  return changes;
}

function instanceEqual(
  a: HelmInstanceValue,
  b: HelmInstanceValue,
  compareChartFingerprint: boolean,
): boolean {
  const scalars: ReadonlyArray<[unknown, unknown]> = [
    [a.enabled, b.enabled],
    [a.image.repository, b.image.repository],
    [a.image.tag, b.image.tag],
    [a.gatewayId, b.gatewayId],
    [effectiveServiceAccountName(a), effectiveServiceAccountName(b)],
    [a.sizingTier, b.sizingTier],
    [a.replicas, b.replicas],
  ];
  for (const [x, y] of scalars) if (x !== y) return false;
  if (resolveGatewayClass(a) !== resolveGatewayClass(b)) return false;
  if (resolveGatewayImageProfile(a) !== resolveGatewayImageProfile(b)) return false;
  if (compareChartFingerprint && a.chartFingerprint !== b.chartFingerprint) return false;
  const objects: ReadonlyArray<[unknown, unknown]> = [
    [a.gatewayContainerSecurityContext, b.gatewayContainerSecurityContext],
    [effectiveServiceAccount(a), effectiveServiceAccount(b)],
    [a.builderAccess, b.builderAccess],
  ];
  for (const [x, y] of objects) {
    if (!stableEqual(x, y)) return false;
  }
  return true;
}

// True when a change rolls the pod's image (tag or repository) — the only kind
// of in-place reconcile that drops a live user's session. The reconciler
// refuses to apply one of these on a gateway with mounted users; such a roll
// must go through the blue/green orchestrator instead. Config-only and
// replicas-only updates are NOT image rolls and still apply in place.
export function isImageRoll(
  c: ReconcileChange,
): c is Extract<ReconcileChange, { kind: "update" }> {
  if (c.kind !== "update") return false;
  return (
    c.from.image.tag !== c.to.image.tag ||
    c.from.image.repository !== c.to.image.repository
  );
}

export function isReplicasOnlyUpdate(c: ReconcileChange): boolean {
  if (c.kind !== "update") return false;
  if (c.from.replicas === c.to.replicas) return false;
  if (c.from.enabled !== c.to.enabled) return false;
  if (c.from.image.repository !== c.to.image.repository) return false;
  if (c.from.image.tag !== c.to.image.tag) return false;
  if (c.from.gatewayId !== c.to.gatewayId) return false;
  if (effectiveServiceAccountName(c.from) !== effectiveServiceAccountName(c.to)) return false;
  if (resolveGatewayClass(c.from) !== resolveGatewayClass(c.to)) return false;
  if (resolveGatewayImageProfile(c.from) !== resolveGatewayImageProfile(c.to)) return false;
  if (c.from.sizingTier !== c.to.sizingTier) return false;
  if (c.from.chartFingerprint !== c.to.chartFingerprint) return false;
  const objects: ReadonlyArray<[unknown, unknown]> = [
    [c.from.gatewayContainerSecurityContext, c.to.gatewayContainerSecurityContext],
    [effectiveServiceAccount(c.from), effectiveServiceAccount(c.to)],
    [c.from.builderAccess, c.to.builderAccess],
  ];
  for (const [x, y] of objects) {
    if (!stableEqual(x, y)) return false;
  }
  return true;
}

function effectiveServiceAccountName(v: HelmInstanceValue): string | undefined {
  if (!v.gatewayId) return v.serviceAccountName;
  const requested = v.serviceAccountName ?? "";
  if (requested === "" || requested === GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME) {
    return isolatedGatewayServiceAccountName(v.gatewayId);
  }
  return requested;
}

function effectiveServiceAccount(v: HelmInstanceValue): HelmInstanceValue["serviceAccount"] {
  if (v.serviceAccount) return v.serviceAccount;
  if (
    resolveGatewayClass(v) === "shared" &&
    v.gatewayId &&
    effectiveServiceAccountName(v) === isolatedGatewayServiceAccountName(v.gatewayId)
  ) {
    return { create: true };
  }
  return undefined;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(
    ([a], [b]) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    },
  );
  return `{${entries
    .map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`)
    .join(",")}}`;
}

function stableEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}
