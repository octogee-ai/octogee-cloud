import { createHash } from "node:crypto";
import {
  isolatedGatewayServiceAccountName,
  resolveGatewayClass,
  resolveGatewayImageProfile,
  resolveIsolatedGatewayAccess,
  GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME,
  type HelmInstanceValue,
} from "@octogee/shared/types/glm";
import {
  dualReadIsolatedProfileImage,
  type GatewayDoc,
  type GatewayRuntimeDoc,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import type { GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
import { withoutGatewayWorkloadIdentity } from "./gateway-service-account-policy.js";

// The simple-roll convergence arm (GATEWAY-SIMPLE-ROLL-SPEC): every gateway has
// ONE stable-name Helm release; a roll is a desiredRelease write that surfaces
// here as image drift and applies in place (the chart's surge strategy replaces
// the pod). No revisions or durable roll state machine; readiness opens only
// after the surge user handoff converges.

export type DurableGateway = GatewayDoc & GatewayMutableConfig;

export function fleetControllerMayMarkGatewayLive(
  gateway: GatewayDoc | null,
  desiredRelease: number,
): boolean {
  return gateway !== null && gateway.desiredRelease === desiredRelease;
}

export function requiresSurgeUserMigration(gateway: DurableGateway): boolean {
  return (gateway.desiredStatus === "running" || gateway.desiredStatus === "draining") &&
    gateway.liveRelease !== null &&
    gateway.liveRelease !== gateway.desiredRelease;
}

export function gatewayReleaseAuthorizesChartDrift(
  gateway: Pick<DurableGateway, "desiredRelease" | "liveRelease">,
): boolean {
  return gateway.liveRelease !== gateway.desiredRelease;
}

export function orderGatewaysForConvergence(
  gateways: readonly DurableGateway[],
): DurableGateway[] {
  return [...gateways].sort((left, right) => left.gatewayId.localeCompare(right.gatewayId));
}

function classKnobs(gateway: DurableGateway): {
  gatewayClass?: "isolated" | "shared";
  profile?: "isolated" | "standard";
  imageProfile?: "isolated" | "standard";
} {
  return {
    gatewayClass: gateway.gatewayClass ?? undefined,
    profile: gateway.profile ?? undefined,
    imageProfile: gateway.imageProfile ?? undefined,
  };
}

type GatewayImage = { imageRepository: string; imageTag: string };

function gatewayImageIn(
  gateway: DurableGateway,
  artifact: ReleasePayload,
): GatewayImage | null {
  if (resolveGatewayImageProfile(classKnobs(gateway)) === "standard") {
    return {
      imageRepository: artifact.imageRepository,
      imageTag: artifact.imageTag,
    };
  }
  return artifact.profileImages === undefined ? null : dualReadIsolatedProfileImage(artifact.profileImages);
}

export function gatewayImageFor(
  gateway: DurableGateway,
  artifact: ReleasePayload,
): GatewayImage {
  const image = gatewayImageIn(gateway, artifact);
  if (!image) {
    throw new Error(
      `gateway ${gateway.gatewayId} release is missing its immutable isolated gateway image reference`,
    );
  }
  return image;
}

// A release recorded past desiredRelease is a rollout the queue has yet to apply;
// a different image there means the pods standing today are already condemned.
export function supersedingGatewayImageTag(input: {
  gateway: DurableGateway;
  desiredImage: GatewayImage;
  pendingArtifact: ReleasePayload | null;
  observedImage?: GatewayImage | null;
}): string | undefined {
  const { gateway, desiredImage, pendingArtifact, observedImage = null } = input;
  if (!pendingArtifact || gateway.latestRelease <= gateway.desiredRelease) return undefined;
  const pendingImage = gatewayImageIn(gateway, pendingArtifact);
  if (!pendingImage) return undefined;
  const pendingDiffersFromDesired = pendingImage.imageTag !== desiredImage.imageTag ||
    pendingImage.imageRepository !== desiredImage.imageRepository;
  if (!pendingDiffersFromDesired) return undefined;
  const pendingAlreadyObserved = observedImage !== null &&
    pendingImage.imageTag === observedImage.imageTag &&
    pendingImage.imageRepository === observedImage.imageRepository;
  return pendingAlreadyObserved ? undefined : pendingImage.imageTag;
}

export interface ObservedHelmInstance {
  imageRepository: string | null;
  imageTag: string | null;
  replicas: number | null;
  chartFingerprint?: string;
  deploymentIntentFingerprint?: string | null;
}

export interface GatewayConvergencePlanInput {
  gateway: DurableGateway;
  artifact: ReleasePayload | null;
  helm: ObservedHelmInstance | null;
  desiredChartFingerprint?: string;
  desiredDeploymentIntentFingerprint?: string;
  deploymentReady: boolean;
}

export type GatewayConvergenceAction =
  | { kind: "uninstall" }
  | { kind: "hold-missing-release"; error: string }
  | { kind: "hold-unreleased-chart"; error: string }
  | { kind: "upsert"; replicas: number }
  | { kind: "mark-live"; prelaunchRefresh?: true }
  | { kind: "steady" };

export function markLiveRuntimePatch(
  gateway: DurableGateway,
): Pick<GatewayRuntimeDoc, "lifecycle" | "release"> | null {
  return gateway.desiredStatus === "running" || gateway.desiredStatus === "draining"
    ? { lifecycle: "serving", release: gateway.desiredRelease }
    : null;
}

function desiredReplicas(gateway: DurableGateway): number {
  return gateway.desiredStatus === "paused" ? 0 : 1;
}

export function planGatewayConvergence(
  input: GatewayConvergencePlanInput,
): GatewayConvergenceAction {
  const { gateway, artifact, helm } = input;
  if (gateway.desiredStatus === "retired") {
    return helm ? { kind: "uninstall" } : { kind: "steady" };
  }
  if (!artifact) {
    return {
      kind: "hold-missing-release",
      error:
        `gateway ${gateway.gatewayId} desired release ${gateway.desiredRelease} has no ` +
        `readable payload at gateways/${gateway.gatewayId}/releases/${gateway.desiredRelease}`,
    };
  }
  const replicas = desiredReplicas(gateway);
  if (gatewayDeploymentDrifted(input, artifact, replicas)) {
    if (gatewayUpsertHasUnreleasedChartDrift(input)) {
      return {
        kind: "hold-unreleased-chart",
        error:
          `gateway ${gateway.gatewayId} deployment mutation waits for a journaled release ` +
          "before applying chart drift",
      };
    }
    return { kind: "upsert", replicas };
  }
  if (
    gateway.liveRelease !== gateway.desiredRelease &&
    (gateway.desiredStatus === "paused" || input.deploymentReady)
  ) {
    return { kind: "mark-live" };
  }
  return { kind: "steady" };
}

function gatewayUpsertHasUnreleasedChartDrift(
  input: GatewayConvergencePlanInput,
): boolean {
  return !gatewayReleaseAuthorizesChartDrift(input.gateway) &&
    input.helm?.chartFingerprint !== undefined &&
    input.desiredChartFingerprint !== undefined &&
    input.helm.chartFingerprint !== input.desiredChartFingerprint;
}

function gatewayDeploymentDrifted(
  input: GatewayConvergencePlanInput,
  artifact: ReleasePayload,
  replicas: number,
): boolean {
  const { gateway, helm } = input;
  const image = gatewayImageFor(gateway, artifact);
  return (
    !helm ||
    helm.imageTag !== image.imageTag ||
    helm.imageRepository !== image.imageRepository ||
    helm.replicas !== replicas ||
    (input.desiredDeploymentIntentFingerprint !== undefined &&
      helm.deploymentIntentFingerprint !== input.desiredDeploymentIntentFingerprint)
  );
}

export interface GatewayUpsertOpts {
  namespace: string;
  gatewayId: string;
  imageRepository: string;
  imageTag: string;
  gatewayEdgeImageRepository?: string;
  gatewayEdgeImageTag?: string;
  serviceAccountName?: string;
  serviceAccount?: HelmInstanceValue["serviceAccount"];
  gatewayContainerSecurityContext?: Record<string, unknown>;
  builderAccess?: HelmInstanceValue["builderAccess"];
  chartPath: string;
  valuesFile?: string;
  chartFingerprint?: string;
  profile?: HelmInstanceValue["profile"];
  gatewayClass?: HelmInstanceValue["gatewayClass"];
  imageProfile?: HelmInstanceValue["imageProfile"];
  sizingTier?: HelmInstanceValue["sizingTier"];
  replicas?: number;
  gcpProject?: string;
  kmsKeyName?: string;
  deploymentTargetId?: string;
  deploymentProjectId?: string;
  gatewayServiceAccount?: string;
  rollStrategy: "surge" | "recreate";
  waitForReady: false;
  deploymentIntentFingerprint: string;
}

type GatewayIntentInput =
  | GatewayUpsertOpts
  | (Omit<GatewayUpsertOpts, "deploymentIntentFingerprint"> & {
      deploymentIntentFingerprint?: undefined;
    });

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
}

export function gatewayDeploymentIntentFingerprint(opts: GatewayIntentInput): string {
  const intent = Object.fromEntries(
    Object.entries(opts).filter(([key]) =>
      key !== "deploymentIntentFingerprint" && key !== "waitForReady"),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(intent)))
    .digest("hex");
}

export function deploymentIntentFingerprintForComparison(input: {
  desired: GatewayUpsertOpts;
  observedChartFingerprint: string | undefined;
  observedDeploymentIntentFingerprint: string | undefined;
  applyChartDrift: boolean;
}): string | undefined {
  if (input.applyChartDrift || !input.observedChartFingerprint) {
    return input.desired.deploymentIntentFingerprint;
  }
  return gatewayDeploymentIntentFingerprint({
    ...input.desired,
    chartFingerprint: input.observedChartFingerprint,
    deploymentIntentFingerprint: undefined,
  });
}

// Tenant identity (KSA, secrets, GATEWAY_ID) and every resource name key off
// the bare gatewayId — the chart's revisionId value defaults to it.
export function gatewayUpsertOptsFromRelease(input: {
  namespace: string;
  gateway: DurableGateway;
  artifact: ReleasePayload;
  replicas: number;
  chartPath: string;
  valuesFile?: string;
  chartFingerprint?: string;
  kmsKeyName?: string;
  deploymentTargetId?: string;
  deploymentProjectId?: string;
  gatewayServiceAccount?: string;
}): GatewayUpsertOpts {
  const { gateway, artifact } = input;
  if (!artifact.gatewayEdgeImage) {
    throw new Error(
      `gateway ${gateway.gatewayId} release is missing its immutable gateway-edge image reference`,
    );
  }
  const gatewayClass = resolveGatewayClass(classKnobs(gateway));
  const gatewayImage = gatewayImageFor(gateway, artifact);
  const intent: Omit<GatewayUpsertOpts, "deploymentIntentFingerprint"> = {
    namespace: input.namespace,
    gatewayId: gateway.gatewayId,
    imageRepository: gatewayImage.imageRepository,
    imageTag: gatewayImage.imageTag,
    gatewayEdgeImageRepository: artifact.gatewayEdgeImage.imageRepository,
    gatewayEdgeImageTag: artifact.gatewayEdgeImage.imageTag,
    serviceAccountName: gatewayServiceAccountName(gateway),
    serviceAccount: withoutGatewayWorkloadIdentity(gateway.serviceAccount),
    gatewayContainerSecurityContext: gateway.gatewayContainerSecurityContext ?? undefined,
    builderAccess: gatewayIsolatedAccess(gateway, gatewayClass),
    chartPath: input.chartPath,
    valuesFile: input.valuesFile,
    chartFingerprint: input.chartFingerprint,
    profile: gateway.profile ?? undefined,
    gatewayClass,
    imageProfile: resolveGatewayImageProfile(classKnobs(gateway)),
    sizingTier: gateway.sizingTier ?? undefined,
    replicas: input.replicas,
    gcpProject: gateway.gcpProject ?? undefined,
    kmsKeyName: input.kmsKeyName,
    deploymentTargetId: input.deploymentTargetId,
    deploymentProjectId: input.deploymentProjectId,
    gatewayServiceAccount: input.gatewayServiceAccount,
    rollStrategy: "surge",
    waitForReady: false,
  };
  return {
    ...intent,
    deploymentIntentFingerprint: gatewayDeploymentIntentFingerprint(intent),
  };
}

function gatewayServiceAccountName(gateway: DurableGateway): string {
  const configured = gateway.serviceAccountName;
  return configured && configured !== GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME
    ? configured
    : isolatedGatewayServiceAccountName(gateway.gatewayId);
}

function gatewayIsolatedAccess(
  gateway: DurableGateway,
  gatewayClass: "shared" | "isolated",
): HelmInstanceValue["builderAccess"] | undefined {
  if (gatewayClass === "shared") return gateway.builderAccess ?? undefined;
  return resolveIsolatedGatewayAccess(gateway.ownerUid, gateway.builderAccess ?? undefined);
}

function provisioningRuntimeObservations(
  gateway: DurableGateway,
  existing: Omit<GatewayRuntimeDoc, "docKind"> | null,
  now: number,
): {
  runtime: Pick<GatewayRuntimeDoc, "lifecycle" | "heartbeat" | "kubernetes">;
  availableReplicas: GatewayRuntimeDoc["helm"]["availableReplicas"];
} {
  const resuming = existing?.helm.replicas === 0 && gateway.desiredStatus === "running";
  return {
    availableReplicas: resuming ? null : existing?.helm.availableReplicas ?? null,
    runtime: {
      lifecycle: resuming ? "provisioning" : existing?.lifecycle ?? "provisioning",
      heartbeat: (resuming ? null : existing?.heartbeat) ?? {
        status: "unknown",
        lastHeartbeatAt: null,
        version: null,
        openclawVersion: null,
        internalUrl: null,
        startedAt: null,
        mountedCustomers: [],
        migratingIn: [],
      },
      ...(resuming ? {
        kubernetes: { status: "unknown" as const, totalPods: 0, readyPods: 0, observedAt: now, pods: [] },
      } : {}),
    },
  };
}

// The runtime doc the converge arm maintains at glmGateways/{gatewayId}.
export function provisioningRuntimeDoc(input: {
  gateway: DurableGateway;
  artifact: ReleasePayload;
  existing: Omit<GatewayRuntimeDoc, "docKind"> | null;
  now: number;
}): GatewayRuntimeDoc {
  const { gateway, artifact, existing } = input;
  const gatewayImage = gatewayImageFor(gateway, artifact);
  const observations = provisioningRuntimeObservations(gateway, existing, input.now);
  return {
    docKind: "runtime",
    gatewayId: gateway.gatewayId,
    release: gateway.desiredRelease,
    ...observations.runtime,
    createdAt: existing?.createdAt ?? input.now,
    createdByOperationId: existing?.createdByOperationId ?? null,
    helm: {
      releaseName: `octogee-gw-${gateway.gatewayId}`,
      deploymentName: `octogee-gateway-${gateway.gatewayId}`,
      gatewayServiceName: `octogee-gateway-${gateway.gatewayId}`,
      gatewayEdgeServiceName: `gateway-edge-${gateway.gatewayId}`,
      serviceAccountName: isolatedGatewayServiceAccountName(gateway.gatewayId),
      imageRepository: gatewayImage.imageRepository,
      imageTag: gatewayImage.imageTag,
      replicas: gateway.desiredStatus === "paused" ? 0 : 1,
      availableReplicas: observations.availableReplicas,
      lastAppliedAt: input.now,
    },
    lastError: existing?.lastError ?? { message: null, at: null },
  };
}
