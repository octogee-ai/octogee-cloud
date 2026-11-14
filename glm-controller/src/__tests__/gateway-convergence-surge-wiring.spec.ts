import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import type { GatewayRuntimeDoc, ReleasePayload } from "@octogee/shared/types/gateway-releases";
import {
  refineGatewayConvergenceAction,
  shouldReconcileDisposablePrelaunch,
} from "../index.js";
import type { DurableGateway } from "../converge-gateway.js";

const openclawSourceSha = "a".repeat(40);

const repository = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
const userRepository = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder";

function gateway(): DurableGateway {
  return {
    gatewayId: "walter",
    latestRelease: 2,
    desiredStatus: "running",
    desiredRelease: 2,
    liveRelease: 1,
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    modelBrokerLimits: null,
    preemption: null,
  } as DurableGateway;
}

const artifact: ReleasePayload = {
  imageRepository: repository,
  imageTag: "def5678-oc2026.7.1",
  openclawSourceSha,
};

function runtime(version: string, openclawVersion?: string): GatewayRuntimeDoc {
  return {
    heartbeat: {
      status: "ready",
      version,
      ...(openclawVersion === undefined
        ? {}
        : { openclawVersion: `OpenClaw ${openclawVersion} (aaaaaaaa)` }),
    },
  } as GatewayRuntimeDoc;
}

function passDeps(
  reconcileSurgeHandoff: () => Promise<{ ready: boolean }>,
  current = gateway(),
) {
  return {
    store: createDocumentFixtureStore({ [`gateways/${current.gatewayId}`]: { ...current } }),
    reconcileSurgeHandoff,
  };
}

describe("gateway convergence surge wiring", () => {
  it("rechecks an initial disposable isolated prelaunch after an unavailable poll", async () => {
    const prelaunch = {
      ...gateway(),
      gatewayClass: "isolated",
      imageProfile: "isolated",
      liveRelease: null,
      allocation: { kind: "disposable-builder" },
    } as DurableGateway;

    await expect(shouldReconcileDisposablePrelaunch({} as never, prelaunch)).resolves.toBe(true);
    await expect(shouldReconcileDisposablePrelaunch({} as never, gateway())).resolves.toBe(false);
    await expect(shouldReconcileDisposablePrelaunch({} as never, { ...prelaunch, liveRelease: 2 })).resolves.toBe(false);
  });

  it("marks a release live only after handoff and the desired-build heartbeat agree", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: true }));

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff),
      gateway: gateway(),
      artifact,
      runtime: runtime("def5678-oc2026.7.1", "2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });
    expect(reconcileSurgeHandoff).toHaveBeenCalledWith({
      gatewayId: "walter",
      desiredImageTag: "def5678-oc2026.7.1",
      requiresUserMigration: true,
      isolatedGateway: false,
      ownerlessOperatorPrewarm: false,
    });

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff),
      gateway: gateway(),
      artifact,
      runtime: runtime("def5678-oc2026.7.1", "2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });

    reconcileSurgeHandoff.mockResolvedValueOnce({ ready: false });
    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff),
      gateway: gateway(),
      artifact,
      runtime: runtime("def5678"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "steady" });

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff),
      gateway: gateway(),
      artifact,
      runtime: runtime("old-build"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "steady" });
  });

  it("restores a resumed same-release runtime to serving", async () => {
    const resumedGateway = { ...gateway(), liveRelease: 2 };
    const resumedRuntime = {
      ...runtime("def5678-oc2026.7.1"),
      lifecycle: "provisioning",
      release: 2,
    } as GatewayRuntimeDoc;

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(vi.fn(async () => ({ ready: true })), resumedGateway),
      gateway: resumedGateway,
      artifact,
      runtime: resumedRuntime,
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });
  });

  it("finishes an in-flight release after autoscaling marks the gateway draining", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: true }));
    const drainingGateway = { ...gateway(), desiredStatus: "draining" as const };

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff, drainingGateway),
      gateway: drainingGateway,
      artifact,
      runtime: runtime("def5678-oc2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });

    expect(reconcileSurgeHandoff).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "walter",
      requiresUserMigration: true,
    }));
  });

  it.each([null, 2])("publishes a verified draining release with prior live release %s", async (liveRelease) => {
    const current = { ...gateway(), desiredStatus: "draining" as const, liveRelease };
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: true }));
    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff, current), gateway: current, artifact,
      runtime: { ...runtime(artifact.imageTag), lifecycle: "provisioning" },
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });
    expect(reconcileSurgeHandoff).toHaveBeenCalledWith(expect.objectContaining({ requiresUserMigration: false }));
  });

  it.each([
    { ready: false, version: artifact.imageTag, status: "ready" },
    { ready: true, version: "other-build", status: "ready" },
    { ready: true, version: artifact.imageTag, status: "booting" },
  ])("holds an unverified draining publication: %j", async ({ ready, version, status }) => {
    const current = { ...gateway(), desiredStatus: "draining" as const, liveRelease: null };
    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(vi.fn(async () => ({ ready })), current), gateway: current, artifact,
      runtime: { ...runtime(version), lifecycle: "provisioning", heartbeat: { ...runtime(version).heartbeat, status } } as GatewayRuntimeDoc,
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "steady" });
  });

  it("does not start a new handoff for a fully converged draining gateway", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: true }));
    const drainingGateway = {
      ...gateway(),
      desiredStatus: "draining" as const,
      liveRelease: 2,
    };

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff, drainingGateway),
      gateway: drainingGateway,
      artifact,
      runtime: { ...runtime("def5678-oc2026.7.1"), lifecycle: "serving" },
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "steady" });

    expect(reconcileSurgeHandoff).not.toHaveBeenCalled();
  });

  it("uses the isolated image receipt for isolated gateway handoff and readiness", async () => {
    const standardImageTag = `def5678-oc2026.7.1@sha256:${"a".repeat(64)}`;
    const builderImageTag = `def5678-oc2026.7.1@sha256:${"b".repeat(64)}`;
    const isolatedGateway = {
      ...gateway(),
      gatewayClass: "isolated" as const,
      profile: "isolated" as const,
      imageProfile: "isolated" as const,
      ownerUid: "uid-walter",
      builderSlug: "walter",
      allocation: {
        kind: "disposable-builder" as const,
        schemaVersion: 1 as const,
        leaseId: "lease-walter",
        generation: 1,
        claimedByUid: "uid-walter",
      },
    };
    const userArtifact: ReleasePayload = {
      ...artifact,
      imageTag: standardImageTag,
      profileImages: {
        builder: {
          imageRepository: userRepository,
          imageTag: builderImageTag,
        },
      },
    };
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: true }));

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff, isolatedGateway),
      gateway: isolatedGateway,
      artifact: userArtifact,
      runtime: runtime(builderImageTag, "2026.7.1"),
      helmObserved: {
        imageRepository: userRepository,
        imageTag: builderImageTag,
        replicas: 1,
      },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });

    expect(reconcileSurgeHandoff).toHaveBeenCalledWith({
      gatewayId: "walter",
      desiredImageTag: builderImageTag,
      requiresUserMigration: true,
      isolatedGateway: true,
      ownerlessOperatorPrewarm: false,
    });
  });

  it("marks an empty held disposable isolated live from its boot heartbeat", async () => {
    const builderImageTag = `def5678-oc2026.7.1@sha256:${"b".repeat(64)}`;
    const isolatedGateway = {
      ...gateway(),
      latestRelease: 1,
      desiredRelease: 1,
      liveRelease: null,
      gatewayClass: "isolated" as const,
      profile: "isolated" as const,
      imageProfile: "isolated" as const,
      ownerUid: "uid-walter",
      builderSlug: "walter",
      allocation: {
        kind: "disposable-builder" as const,
        schemaVersion: 1 as const,
        leaseId: "lease-walter",
        generation: 1,
        claimedByUid: "uid-walter",
      },
    };
    const userArtifact: ReleasePayload = {
      ...artifact,
      profileImages: {
        builder: {
          imageRepository: userRepository,
          imageTag: builderImageTag,
        },
      },
    };
    const bootingRuntime = {
      ...runtime(builderImageTag, "2026.7.1"),
      heartbeat: {
        ...runtime(builderImageTag, "2026.7.1").heartbeat,
        status: "booting",
      },
    } as GatewayRuntimeDoc;
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: true }));

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff, isolatedGateway),
      gateway: isolatedGateway,
      artifact: userArtifact,
      runtime: bootingRuntime,
      helmObserved: {
        imageRepository: userRepository,
        imageTag: builderImageTag,
        replicas: 1,
      },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });

    expect(reconcileSurgeHandoff).toHaveBeenCalledWith(expect.objectContaining({
      requiresUserMigration: false,
      isolatedGateway: true,
    }));
  });

  it("marks an initial held user live after the fleet controller directly verifies prelaunch", async () => {
    const builderImageTag = `def5678-oc2026.7.1@sha256:${"c".repeat(64)}`;
    const isolatedGateway = {
      ...gateway(),
      latestRelease: 1,
      desiredRelease: 1,
      liveRelease: null,
      gatewayClass: "isolated" as const,
      profile: "isolated" as const,
      imageProfile: "isolated" as const,
      ownerUid: "uid-walter",
      builderSlug: "walter",
      allocation: {
        kind: "disposable-builder" as const,
        schemaVersion: 1 as const,
        leaseId: "lease-walter",
        generation: 1,
        claimedByUid: "uid-walter",
      },
    };
    const userArtifact: ReleasePayload = {
      ...artifact,
      profileImages: {
        builder: {
          imageRepository: userRepository,
          imageTag: builderImageTag,
        },
      },
    };

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(vi.fn(async () => ({ ready: true })), isolatedGateway),
      gateway: isolatedGateway,
      artifact: userArtifact,
      runtime: runtime("unknown"),
      helmObserved: {
        imageRepository: userRepository,
        imageTag: builderImageTag,
        replicas: 1,
      },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });
  });

  it("reads the source version from the runtime config status the pod reports", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: false }));
    const configured = {
      heartbeat: {
        status: "ready",
        version: "def5678-oc2026.7.1",
        openclawVersion: "unknown",
        configStatus: { openclawVersion: "2026.7.1", openclawForkSha: openclawSourceSha },
      },
    } as GatewayRuntimeDoc;

    await refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff),
      gateway: gateway(),
      artifact,
      runtime: configured,
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    });

    expect(reconcileSurgeHandoff).toHaveBeenCalledWith(expect.objectContaining({
    }));
  });

  it("does not mark a qualified release live from an ambiguous legacy SHA heartbeat", async () => {
    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(vi.fn(async () => ({ ready: true }))),
      gateway: gateway(),
      artifact,
      runtime: runtime("def5678"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
  })).resolves.toEqual({ kind: "steady" });
  });

  it("stands the handoff down when a queued rollout replaces the pod image", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: false }));
    const pendingRoll = { ...gateway(), latestRelease: 3 };

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff, pendingRoll),
      gateway: pendingRoll,
      artifact,
      pendingArtifact: { imageRepository: repository, imageTag: "ghi9012-oc2026.7.1" },
      runtime: runtime("def5678-oc2026.7.1", "2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "steady" });

    expect(reconcileSurgeHandoff).toHaveBeenCalledWith(expect.objectContaining({
      supersedingImageTag: "ghi9012-oc2026.7.1",
    }));
  });

  it("keeps an already-updated target handoff active while its release record catches up", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: false }));
    const pendingRoll = { ...gateway(), latestRelease: 3 };

    await refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff, pendingRoll),
      gateway: pendingRoll,
      artifact,
      pendingArtifact: { imageRepository: repository, imageTag: "ghi9012-oc2026.7.1" },
      runtime: runtime("def5678-oc2026.7.1", "2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: "ghi9012-oc2026.7.1", replicas: 1 },
      action: { kind: "steady" },
    });

    expect(reconcileSurgeHandoff).toHaveBeenCalledWith(expect.not.objectContaining({
      supersedingImageTag: expect.anything(),
    }));
  });

  it("keeps converging when the queued rollout keeps the same image", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: true }));
    const pendingRoll = { ...gateway(), latestRelease: 3 };

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff, pendingRoll),
      gateway: pendingRoll,
      artifact,
      pendingArtifact: artifact,
      runtime: runtime("def5678-oc2026.7.1", "2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });

    expect(reconcileSurgeHandoff).toHaveBeenCalledWith(expect.not.objectContaining({
      supersedingImageTag: expect.anything(),
    }));
  });
});
