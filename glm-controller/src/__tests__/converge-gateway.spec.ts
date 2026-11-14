import { describe, expect, it } from "vitest";
import {
  gatewayDeploymentIntentFingerprint,
  fleetControllerMayMarkGatewayLive,
  deploymentIntentFingerprintForComparison,
  gatewayReleaseAuthorizesChartDrift,
  gatewayUpsertOptsFromRelease,
  markLiveRuntimePatch,
  orderGatewaysForConvergence,
  planGatewayConvergence,
  provisioningRuntimeDoc,
  requiresSurgeUserMigration,
  supersedingGatewayImageTag,
  type DurableGateway,
} from "../converge-gateway.js";
import type { ReleasePayload } from "@octogee/shared/types/gateway-releases";

const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
const USER_REPO =
  "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder";
const EDGE_REPO = "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge";

function gateway(overrides: Partial<DurableGateway> = {}): DurableGateway {
  return {
    gatewayId: "walter",
    createdAt: 1,
    createdBy: "op",
    updatedAt: 1,
    updatedBy: "op",
    latestRelease: 2,
    desiredRelease: 2,
    liveRelease: 1,
    desiredStatus: "running",
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
    ...overrides,
  } as DurableGateway;
}

function artifact(overrides: Partial<ReleasePayload> = {}): ReleasePayload {
  return {
    imageRepository: REPO,
    imageTag: "def5678",
    profileImages: {
      builder: {
        imageRepository: USER_REPO,
        imageTag: "def5678",
      },
    },
    gatewayEdgeImage: { imageRepository: EDGE_REPO, imageTag: "def5678" },
    ...overrides,
  };
}

describe("planGatewayConvergence", () => {
  it("upserts when no Helm release exists yet (first realization)", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway({ liveRelease: null, desiredRelease: 1 }),
        artifact: artifact(),
        helm: null,
        deploymentReady: false,
      }),
    ).toEqual({ kind: "upsert", replicas: 1 });
  });

  it("upserts on image drift — a roll is just desiredRelease drift applied in place", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway(),
        artifact: artifact({ imageTag: "def5678" }),
        helm: {
          imageRepository: REPO,
          imageTag: "abc1234",
          replicas: 1,
          deploymentIntentFingerprint: "old-intent",
        },
        desiredDeploymentIntentFingerprint: "new-intent",
        deploymentReady: true,
      }),
    ).toEqual({ kind: "upsert", replicas: 1 });
  });

  it("upserts when any rendered Helm intent changes without image or replica drift", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway({ liveRelease: 2 }),
        artifact: artifact(),
        helm: {
          imageRepository: REPO,
          imageTag: "def5678",
          replicas: 1,
          deploymentIntentFingerprint: "old-intent",
        },
        desiredDeploymentIntentFingerprint: "new-intent",
        deploymentReady: true,
      }),
    ).toEqual({ kind: "upsert", replicas: 1 });
  });

  it("upserts replicas 0 for a paused gateway", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway({ desiredStatus: "paused" }),
        artifact: artifact(),
        helm: { imageRepository: REPO, imageTag: "def5678", replicas: 1 },
        deploymentReady: true,
      }),
    ).toEqual({ kind: "upsert", replicas: 0 });
  });

  it("marks an applied paused release live without booting a pod", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway({ desiredStatus: "paused", liveRelease: 1, desiredRelease: 2 }),
        artifact: artifact(),
        helm: { imageRepository: REPO, imageTag: "def5678", replicas: 0 },
        deploymentReady: false,
      }),
    ).toEqual({ kind: "mark-live" });
  });

  it("does not advertise a paused zero-pod release as a serving runtime", () => {
    expect(markLiveRuntimePatch(gateway({ desiredStatus: "paused" }))).toBeNull();
    expect(markLiveRuntimePatch(gateway({ desiredStatus: "draining" }))).toEqual({ lifecycle: "serving", release: 2 });
    expect(markLiveRuntimePatch(gateway({ desiredStatus: "running" }))).toEqual({
      lifecycle: "serving",
      release: 2,
    });
  });

  it("uses the transaction-time release fence before marking a release live", () => {
    expect(fleetControllerMayMarkGatewayLive(gateway(), 1)).toBe(false);
    expect(fleetControllerMayMarkGatewayLive(gateway(), 2)).toBe(true);
    expect(markLiveRuntimePatch(gateway())).toEqual({ lifecycle: "serving", release: 2 });
  });

  it("marks the desired release live once the deployment is ready at the desired image", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway({ liveRelease: 1, desiredRelease: 2 }),
        artifact: artifact(),
        helm: { imageRepository: REPO, imageTag: "def5678", replicas: 1 },
        deploymentReady: true,
      }),
    ).toEqual({ kind: "mark-live" });
  });

  it("stays steady while converged, and while applied-but-not-ready", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway({ liveRelease: 2 }),
        artifact: artifact(),
        helm: { imageRepository: REPO, imageTag: "def5678", replicas: 1 },
        deploymentReady: true,
      }),
    ).toEqual({ kind: "steady" });
    expect(
      planGatewayConvergence({
        gateway: gateway({ liveRelease: 1, desiredRelease: 2 }),
        artifact: artifact(),
        helm: { imageRepository: REPO, imageTag: "def5678", replicas: 1 },
        deploymentReady: false,
      }),
    ).toEqual({ kind: "steady" });
  });

  it("uninstalls a retired gateway's release, then forgets it", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway({ desiredStatus: "retired" }),
        artifact: artifact(),
        helm: { imageRepository: REPO, imageTag: "def5678", replicas: 1 },
        deploymentReady: false,
      }),
    ).toEqual({ kind: "uninstall" });
    expect(
      planGatewayConvergence({
        gateway: gateway({ desiredStatus: "retired" }),
        artifact: null,
        helm: null,
        deploymentReady: false,
      }),
    ).toEqual({ kind: "steady" });
  });

  it("holds loudly when the desired release payload is unreadable", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway(),
        artifact: null,
        helm: null,
        deploymentReady: false,
      }),
    ).toMatchObject({
      kind: "hold-missing-release",
      error: expect.stringContaining("gateways/walter/releases/2"),
    });
  });
});

describe("surge user migration boundary", () => {
  it("requires transfer only when replacing a previously-live release", () => {
    expect(requiresSurgeUserMigration(gateway({ liveRelease: 1, desiredRelease: 2 }))).toBe(true);
    expect(requiresSurgeUserMigration(gateway({ liveRelease: null, desiredRelease: 1 }))).toBe(false);
    expect(requiresSurgeUserMigration(gateway({ liveRelease: 2, desiredRelease: 2 }))).toBe(false);
    expect(requiresSurgeUserMigration(gateway({
      liveRelease: 1,
      desiredRelease: 2,
      desiredStatus: "draining",
    }))).toBe(true);
    expect(requiresSurgeUserMigration(gateway({
      liveRelease: 1,
      desiredRelease: 2,
      desiredStatus: "paused",
    }))).toBe(false);
  });

});

describe("orderGatewaysForConvergence", () => {
  it("orders shared and isolated gateways by stable id", () => {
    expect(orderGatewaysForConvergence([
      gateway({ gatewayId: "zeta", gatewayClass: "shared" }),
      gateway({ gatewayId: "beta", gatewayClass: "isolated" }),
      gateway({ gatewayId: "alpha", gatewayClass: "isolated" }),
    ]).map((item) => item.gatewayId)).toEqual(["alpha", "beta", "zeta"]);
  });
});

describe("gatewayUpsertOptsFromRelease", () => {
  it("strips Workload Identity from a personal gateway before Helm convergence", () => {
    const opts = gatewayUpsertOptsFromRelease({
      namespace: "octogee",
      gateway: gateway({
        gatewayClass: "isolated",
        imageProfile: "isolated",
        ownerUid: "uid-owner",
        builderSlug: "owner",
        serviceAccountName: "octogee-gw-walter",
        serviceAccount: {
          create: true,
          annotations: {
            "iam.gke.io/gcp-service-account":
              "octogee-gw-walter@octogee.iam.gserviceaccount.com",
            "octogee.ai/purpose": "personal-gateway",
          },
        },
      }),
      artifact: artifact(),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
    });

    expect(opts.serviceAccount).toEqual({
      create: true,
      annotations: { "octogee.ai/purpose": "personal-gateway" },
    });
  });

  it("never sends the standard gateway digest to the user repository", () => {
    const standardDigest = `sha256:${"a".repeat(64)}`;
    const userDigest = `sha256:${"b".repeat(64)}`;
    const opts = gatewayUpsertOptsFromRelease({
      namespace: "octogee-test",
      gateway: gateway({
        gatewayClass: "isolated",
        imageProfile: "isolated",
      }),
      artifact: artifact({
        imageTag: `def5678@${standardDigest}`,
        profileImages: {
          builder: {
            imageRepository: USER_REPO,
            imageTag: `def5678@${userDigest}`,
          },
        },
      }),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
    });

    expect(opts.imageRepository).toBe(USER_REPO);
    expect(opts.imageTag).toBe(`def5678@${userDigest}`);
    expect(opts.imageTag).not.toContain(standardDigest);
    expect(opts.gatewayEdgeImageRepository).toBe(EDGE_REPO);
    expect(opts.gatewayEdgeImageTag).toBe("def5678");
  });

  it("converges an isolated gateway to its profile image whether the release keys it builder or isolated", () => {
    const image = { imageRepository: USER_REPO, imageTag: `def5678@sha256:${"b".repeat(64)}` };
    const opts = (profileImages: ReleasePayload["profileImages"]) => gatewayUpsertOptsFromRelease({
      namespace: "octogee-test",
      gateway: gateway({ gatewayClass: "isolated", imageProfile: "isolated" }),
      artifact: artifact({ profileImages }),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
    });
    expect(opts({ isolated: image })).toEqual(opts({ builder: image }));
    expect(opts({ isolated: image })).toMatchObject({ imageRepository: USER_REPO, imageTag: image.imageTag });
  });

  it("fails before Helm convergence when a user release lacks its profile receipt", () => {
    expect(() => gatewayUpsertOptsFromRelease({
      namespace: "octogee-test",
      gateway: gateway({
        gatewayClass: "isolated",
        imageProfile: "isolated",
      }),
      artifact: artifact({ profileImages: undefined }),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
    })).toThrow(/missing its immutable isolated gateway image reference/);
  });

  it("retains the source Hobby pod for the fenced transfer of unpublished workspace state", () => {
    const opts = gatewayUpsertOptsFromRelease({ namespace: "octogee-test", gateway: gateway({ gatewayClass: "isolated", imageProfile: "isolated", sizingTier: "s" }), artifact: artifact(), replicas: 1, chartPath: "/charts/octogee-gateway" });
    expect(opts.rollStrategy).toBe("surge");
  });

  it("keys every name off the bare gatewayId and requests surge rolls for shared gateways", () => {
    const opts = gatewayUpsertOptsFromRelease({
      namespace: "octogee-test",
      gateway: gateway(),
      artifact: artifact(),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
      kmsKeyName: "projects/octogee-test/locations/us-central1/keyRings/octogee-creds/cryptoKeys/integrations-at-rest",
      deploymentTargetId: "test-central",
      deploymentProjectId: "octogee-test",
      gatewayServiceAccount: "octogee-gateway@octogee-test.iam.gserviceaccount.com",
    });
    expect(opts).toMatchObject({
      gatewayId: "walter",
      imageRepository: REPO,
      imageTag: "def5678",
      serviceAccountName: "octogee-gw-walter",
      replicas: 1,
      rollStrategy: "surge",
      kmsKeyName: "projects/octogee-test/locations/us-central1/keyRings/octogee-creds/cryptoKeys/integrations-at-rest",
      gatewayEdgeImageRepository: EDGE_REPO,
      gatewayEdgeImageTag: "def5678",
      deploymentTargetId: "test-central",
      deploymentProjectId: "octogee-test",
      gatewayServiceAccount: "octogee-gateway@octogee-test.iam.gserviceaccount.com",
      waitForReady: false,
      deploymentIntentFingerprint: expect.any(String),
    });
    expect(opts).not.toHaveProperty("revisionId");
  });

  it("refuses a release that does not carry an immutable gateway-edge reference", () => {
    expect(() => gatewayUpsertOptsFromRelease({
      namespace: "octogee-test",
      gateway: gateway(),
      artifact: artifact({ gatewayEdgeImage: undefined }),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
    })).toThrow(/missing its immutable gateway-edge image reference/);
  });

  it("fingerprints chart, config, and sidecar values as part of the rendered intent", () => {
    const base = gatewayUpsertOptsFromRelease({
      namespace: "octogee-test",
      gateway: gateway(),
      artifact: artifact(),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
      chartFingerprint: "chart-a",
    });
    expect(gatewayDeploymentIntentFingerprint({
      ...base,
      deploymentIntentFingerprint: undefined,
      chartFingerprint: "chart-b",
    })).not.toBe(base.deploymentIntentFingerprint);
    expect(gatewayDeploymentIntentFingerprint({
      ...base,
      deploymentIntentFingerprint: undefined,
      builderAccess: { controlUiEnabled: true },
    })).not.toBe(base.deploymentIntentFingerprint);
    expect(gatewayDeploymentIntentFingerprint({
      ...base,
      deploymentIntentFingerprint: undefined,
      gatewayEdgeImageRepository: "example/gateway-edge",
      gatewayEdgeImageTag: "edge-b",
    })).not.toBe(base.deploymentIntentFingerprint);
  });

  it("keeps a user steady when only the root owner pair changes", () => {
    const previous = gatewayUpsertOptsFromRelease({
      namespace: "octogee-test",
      gateway: gateway({
        gatewayClass: "isolated",
        imageProfile: "isolated",
        ownerUid: "uid-previous",
        builderSlug: "previous",
      }),
      artifact: artifact(),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
    });
    const successor = gatewayUpsertOptsFromRelease({
      namespace: "octogee-test",
      gateway: gateway({
        gatewayClass: "isolated",
        imageProfile: "isolated",
        ownerUid: "uid-successor",
        builderSlug: "successor",
      }),
      artifact: artifact(),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
    });

    expect(successor).not.toHaveProperty("ownerUid");
    expect(successor).not.toHaveProperty("builderSlug");
    expect(successor.deploymentIntentFingerprint).toBe(previous.deploymentIntentFingerprint);
    expect(planGatewayConvergence({
      gateway: gateway({
        gatewayClass: "isolated",
        imageProfile: "isolated",
        ownerUid: "uid-successor",
        builderSlug: "successor",
        liveRelease: 2,
      }),
      artifact: artifact(),
      helm: {
        imageRepository: USER_REPO,
        imageTag: "def5678",
        replicas: 1,
        deploymentIntentFingerprint: previous.deploymentIntentFingerprint,
      },
      desiredDeploymentIntentFingerprint: successor.deploymentIntentFingerprint,
      deploymentReady: true,
    })).toEqual({ kind: "steady" });
  });

  it("ignores ambient chart drift but applies it during a journaled release", () => {
    const convergedGateway = gateway({ desiredRelease: 2, liveRelease: 2 });
    const rollingGateway = gateway({ desiredRelease: 2, liveRelease: 1 });
    const observed = gatewayUpsertOptsFromRelease({
      namespace: "octogee-test",
      gateway: convergedGateway,
      artifact: artifact(),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
      chartFingerprint: "chart-a",
    });
    const desired = gatewayUpsertOptsFromRelease({
      namespace: "octogee-test",
      gateway: convergedGateway,
      artifact: artifact(),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
      chartFingerprint: "chart-b",
    });

    const ambientComparison = deploymentIntentFingerprintForComparison({
      desired,
      observedChartFingerprint: "chart-a",
      observedDeploymentIntentFingerprint: observed.deploymentIntentFingerprint,
      applyChartDrift: gatewayReleaseAuthorizesChartDrift(convergedGateway),
    });
    const releaseComparison = deploymentIntentFingerprintForComparison({
      desired,
      observedChartFingerprint: "chart-a",
      observedDeploymentIntentFingerprint: observed.deploymentIntentFingerprint,
      applyChartDrift: gatewayReleaseAuthorizesChartDrift(rollingGateway),
    });

    const helm = {
      imageRepository: REPO,
      imageTag: "def5678",
      replicas: 1,
      deploymentIntentFingerprint: observed.deploymentIntentFingerprint,
    };
    expect(planGatewayConvergence({
      gateway: convergedGateway,
      artifact: artifact(),
      helm,
      desiredDeploymentIntentFingerprint: ambientComparison,
      deploymentReady: true,
    })).toEqual({ kind: "steady" });
    expect(planGatewayConvergence({
      gateway: rollingGateway,
      artifact: artifact(),
      helm,
      desiredDeploymentIntentFingerprint: releaseComparison,
      deploymentReady: true,
    })).toEqual({ kind: "upsert", replicas: 1 });
    expect(gatewayReleaseAuthorizesChartDrift(
      gateway({ desiredRelease: 1, liveRelease: null }),
    )).toBe(true);
  });

  it("finds no owner drift when ambient chart-only drift is suppressed", () => {
    const observed = gatewayUpsertOptsFromRelease({
      namespace: "octogee",
      gateway: gateway({
        gatewayClass: "isolated",
        imageProfile: "isolated",
        ownerUid: "uid-previous",
        builderSlug: "previous",
      }),
      artifact: artifact(),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
      chartFingerprint: "chart-a",
    });
    const desired = gatewayUpsertOptsFromRelease({
      namespace: "octogee",
      gateway: gateway({
        gatewayClass: "isolated",
        imageProfile: "isolated",
        ownerUid: "uid-successor",
        builderSlug: "successor",
      }),
      artifact: artifact(),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
      chartFingerprint: "chart-b",
    });

    expect(deploymentIntentFingerprintForComparison({
      desired,
      observedChartFingerprint: "chart-a",
      observedDeploymentIntentFingerprint: observed.deploymentIntentFingerprint,
      applyChartDrift: false,
    })).toBe(observed.deploymentIntentFingerprint);
  });

  it("upserts a missing legacy intent fingerprint in PROD", () => {
    const desired = gatewayUpsertOptsFromRelease({
      namespace: "octogee",
      gateway: gateway(),
      artifact: artifact(),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
      chartFingerprint: "chart-current",
    });

    expect(deploymentIntentFingerprintForComparison({
      desired,
      observedChartFingerprint: undefined,
      observedDeploymentIntentFingerprint: undefined,
      applyChartDrift: false,
    })).toBe(desired.deploymentIntentFingerprint);
  });

  it("resolves user access from the owner", () => {
    const opts = gatewayUpsertOptsFromRelease({
      namespace: "octogee-test",
      gateway: gateway({
        gatewayClass: "isolated",
        imageProfile: "isolated",
        profile: "isolated",
        ownerUid: "uid-ceckert",
        builderSlug: "ceckert",
      }),
      artifact: artifact(),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
    });
    expect(opts.gatewayClass).toBe("isolated");
    expect(opts.builderAccess).toBeDefined();
    expect(opts).not.toHaveProperty("builderSlug");
    expect(opts).not.toHaveProperty("ownerUid");
  });

});

describe("provisioningRuntimeDoc", () => {
  it("requires new runtime observations when a paused gateway resumes", () => {
    const existing = provisioningRuntimeDoc({
      gateway: gateway({ gatewayClass: "isolated", desiredStatus: "paused" }),
      artifact: artifact(), existing: null, now: 100,
    });
    existing.lifecycle = "serving";
    existing.helm.availableReplicas = 1;
    existing.heartbeat = {
      status: "ready", lastHeartbeatAt: 99, version: "def5678", openclawVersion: "2026.9.9",
      internalUrl: "http://old-pod", startedAt: 50, mountedCustomers: ["alice"], migratingIn: ["bob"],
    };
    existing.kubernetes = { status: "ready", totalPods: 1, readyPods: 1, observedAt: 99, pods: [] };

    const resumed = provisioningRuntimeDoc({
      gateway: gateway({ gatewayClass: "isolated", desiredStatus: "running" }),
      artifact: artifact(), existing, now: 200,
    });

    expect(resumed.lifecycle).toBe("provisioning");
    expect(resumed.helm).toMatchObject({ replicas: 1, availableReplicas: null });
    expect(resumed.heartbeat).toEqual({
      status: "unknown", lastHeartbeatAt: null, version: null, openclawVersion: null,
      internalUrl: null, startedAt: null, mountedCustomers: [], migratingIn: [],
    });
    expect(resumed.kubernetes).toEqual({ status: "unknown", totalPods: 0, readyPods: 0, observedAt: 200, pods: [] });
    expect(resumed.createdAt).toBe(100);
    expect(existing.heartbeat.status).toBe("ready");
  });

  it("creates a provisioning runtime doc keyed by the bare gatewayId", () => {
    const doc = provisioningRuntimeDoc({
      gateway: gateway({ desiredRelease: 2 }),
      artifact: artifact(),
      existing: null,
      now: 100,
    });
    expect(doc).toMatchObject({
      docKind: "runtime",
      gatewayId: "walter",
      release: 2,
      lifecycle: "provisioning",
      helm: {
        releaseName: "octogee-gw-walter",
        deploymentName: "octogee-gateway-walter",
        gatewayEdgeServiceName: "gateway-edge-walter",
        imageTag: "def5678",
        replicas: 1,
      },
    });
  });

  it("preserves the serving runtime and heartbeat while a new release rolls in place", () => {
    const existing = provisioningRuntimeDoc({
      gateway: gateway({ desiredRelease: 2 }),
      artifact: artifact(),
      existing: null,
      now: 100,
    });
    existing.lifecycle = "serving";
    existing.heartbeat.status = "ready";
    existing.heartbeat.lastHeartbeatAt = 99;
    existing.heartbeat.startedAt = 50;
    existing.heartbeat.mountedCustomers = ["alice"];
    existing.helm.availableReplicas = 1;

    const sameRelease = provisioningRuntimeDoc({
      gateway: gateway({ desiredRelease: 2 }),
      artifact: artifact(),
      existing,
      now: 200,
    });
    expect(sameRelease.lifecycle).toBe("serving");
    expect(sameRelease.heartbeat).toEqual(existing.heartbeat);
    expect(sameRelease.helm.availableReplicas).toBe(1);
    expect(sameRelease.createdAt).toBe(100);

    const newRelease = provisioningRuntimeDoc({
      gateway: gateway({ desiredRelease: 3 }),
      artifact: artifact({ imageTag: "aaa1111" }),
      existing,
      now: 300,
    });
    expect(newRelease.lifecycle).toBe("serving");
    expect(newRelease.release).toBe(3);
    expect(newRelease.heartbeat).toEqual(existing.heartbeat);
    expect(newRelease.helm.availableReplicas).toBe(1);
  });
});

describe("supersedingGatewayImageTag", () => {
  const desiredImage = { imageRepository: REPO, imageTag: "def5678" };

  it("names the image a pending release will put on the pod", () => {
    expect(supersedingGatewayImageTag({
      gateway: gateway({ desiredRelease: 2, latestRelease: 3 }),
      desiredImage,
      pendingArtifact: artifact({ imageTag: "aaa1111" }),
    })).toBe("aaa1111");
  });

  it("names the pending isolated image for a isolated gateway", () => {
    expect(supersedingGatewayImageTag({
      gateway: gateway({
        desiredRelease: 2,
        latestRelease: 3,
        gatewayClass: "isolated",
        imageProfile: "isolated",
      }),
      desiredImage: { imageRepository: USER_REPO, imageTag: "def5678" },
      pendingArtifact: artifact({
        imageTag: "aaa1111",
        profileImages: { builder: { imageRepository: USER_REPO, imageTag: "bbb2222" } },
      }),
    })).toBe("bbb2222");
  });

  it("stays silent when no release is pending", () => {
    expect(supersedingGatewayImageTag({
      gateway: gateway({ desiredRelease: 3, latestRelease: 3 }),
      desiredImage,
      pendingArtifact: artifact({ imageTag: "aaa1111" }),
    })).toBeUndefined();
    expect(supersedingGatewayImageTag({
      gateway: gateway({ desiredRelease: 3, latestRelease: 2 }),
      desiredImage,
      pendingArtifact: artifact({ imageTag: "aaa1111" }),
    })).toBeUndefined();
  });

  it("stays silent when the pending release keeps the same image", () => {
    expect(supersedingGatewayImageTag({
      gateway: gateway({ desiredRelease: 2, latestRelease: 3 }),
      desiredImage,
      pendingArtifact: artifact(),
    })).toBeUndefined();
  });

  it("stays silent when the pending image is already observed on the gateway", () => {
    expect(supersedingGatewayImageTag({
      gateway: gateway({ desiredRelease: 2, latestRelease: 3 }),
      desiredImage,
      pendingArtifact: artifact({ imageTag: "aaa1111" }),
      observedImage: { imageRepository: REPO, imageTag: "aaa1111" },
    })).toBeUndefined();
  });

  it("stays silent when the pending release names no image for this gateway", () => {
    expect(supersedingGatewayImageTag({
      gateway: gateway({
        desiredRelease: 2,
        latestRelease: 3,
        gatewayClass: "isolated",
        imageProfile: "isolated",
      }),
      desiredImage: { imageRepository: USER_REPO, imageTag: "def5678" },
      pendingArtifact: artifact({ imageTag: "aaa1111", profileImages: undefined }),
    })).toBeUndefined();
    expect(supersedingGatewayImageTag({
      gateway: gateway({ desiredRelease: 2, latestRelease: 3 }),
      desiredImage,
      pendingArtifact: null,
    })).toBeUndefined();
  });
});
