import { vi } from "vitest";

import type { ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { FIXTURE_SIZING_PROFILES } from "@octogee/core/testing/journal-store";
import type {
  PlacementPolicyReconcilerDeps,
  PlacementPolicySnapshot,
} from "../../placement-policy-reconciler.js";

export const FIXTURE_USERS_PER_GATEWAY = 4;

const GATEWAY_REPOSITORY = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

export function releaseArtifact(tag: string): ReleasePayload {
  return {
    imageRepository: GATEWAY_REPOSITORY,
    imageTag: `${tag}@sha256:${tag.charAt(0).repeat(64)}`,
    profileImages: {
      builder: {
        imageRepository: `${GATEWAY_REPOSITORY}-builder`,
        imageTag: `${tag}@sha256:${tag.charAt(2).repeat(64)}`,
      },
    },
    gatewayEdgeImage: {
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge",
      imageTag: `${tag}@sha256:${tag.charAt(1).repeat(64)}`,
    },
  };
}

const storedDocumentOfAnAdmittedUser = { onboardingStep: "complete" };

export const activeTrial = {
  admitted: true,
  ...storedDocumentOfAnAdmittedUser,
  username: "alice",
  provisioning: {
    status: "complete",
    openclaw: { gatewayId: "shared-blue", slug: "alice" },
  },
  trialGrant: {
    schemaVersion: 3,
    offerId: "builder-signup",
    offerVersion: 1,
    personalTier: "personal",
    builderTier: "hobby",
    configHash: "trial-hash",
    claimedAt: 1_000,
    endsAt: 7 * 24 * 60 * 60 * 1000,
  },
};

export type PlacementFixtureSnapshot = PlacementPolicySnapshot & { idleMs: number; buildersPerGateway: number };

export function snapshot(overrides: Partial<PlacementFixtureSnapshot> = {}): PlacementFixtureSnapshot {
  return {
    defaultGatewayId: "shared-blue",
    sharedGatewayIds: ["shared-blue"],
    idleMs: 30 * 60 * 1000,
    buildersPerGateway: FIXTURE_USERS_PER_GATEWAY,
    sizingProfiles: FIXTURE_SIZING_PROFILES,
    platformCurrentGatewayIds: [],
    sharedPoolReplacements: [],
    users: [{ uid: "uid-alice", data: activeTrial }],
    gateways: [
      {
        gatewayId: "shared-blue",
        gatewayClass: "shared",
        ownerUid: null,
        desiredStatus: "running",
        ready: true,
        disposable: false,
      },
      {
        gatewayId: "builder-alice",
        gatewayClass: "isolated",
        ownerUid: "uid-alice",
        desiredStatus: "running",
        ready: true,
        disposable: true,
        allocation: {
          kind: "disposable-builder",
          schemaVersion: 1,
          leaseId: "lease-one",
          generation: 1,
          claimedByUid: "uid-alice",
        },
        assignmentCount: 0,
        mountedCustomers: [],
        configuredBuilder: { state: "claimed", generation: 1 },
      },
    ],
    assignments: [],
    activeMigrations: [],
    ...overrides,
  };
}

export function rebalanceGateways() {
  return ["shared-blue", "shared-green"].map((gatewayId) => ({
    gatewayId,
    gatewayClass: "shared" as const,
    ownerUid: null,
    desiredStatus: "running" as const,
    ready: true,
    kubernetesStatus: "ready" as const,
    runtimeStartedAt: 1,
    disposable: false,
  }));
}

export function platformHarness(state: PlacementPolicySnapshot = snapshot()): PlacementPolicyReconcilerDeps {
  return {
    now: vi.fn(() => 2_000),
    log: vi.fn(),
    debug: vi.fn(),
    readSnapshot: vi.fn(async () => state),
    decidePlacementAdmission: vi.fn(async () => ({ kind: "admitted" as const })),
    assignInitialPlacement: vi.fn(async () => undefined),
    recoverUnavailableGateway: vi.fn(async (request) => ({ operationId: request.operationId })),
    recoverDisposableRuntimeReset: vi.fn(async (request) => ({ operationId: request.operationId })),
    supersedeRollingSharedGateway: vi.fn(async () => ({
      kind: "scheduled" as const,
      release: 12,
      operationId: "recover-shared-roll-shared-blue-to-shared-green-r11-to-r10",
    })),
    enqueueMigration: vi.fn(async (request) => request.operationId ?? "op-placement-1"),
    deleteRetiredDisposableGateway: vi.fn(async () => true),
  };
}

export function bootingDisposableTarget(input: {
  provisionedAt: unknown;
  runtimeStartedAt?: number | null;
  runtime?: "cluster" | "gce-vm" | null;
  vmStartedAt?: number | null;
}): PlacementFixtureSnapshot {
  const runtime = input.runtime === undefined ? "cluster" : input.runtime;
  return snapshot({
    users: [{
      uid: "uid-alice",
      data: {
        ...activeTrial,
        provisioning: {
          status: "complete",
          openclaw: {
            gatewayId: "shared-blue",
            slug: "alice",
            activationLease: {
              leaseId: "lease-one",
              generation: 1,
              status: "provisioning",
              targetGatewayId: "builder-alice",
              provisionedAt: input.provisionedAt,
            },
          },
        },
      },
    }],
    gateways: snapshot().gateways.map((gateway) =>
      gateway.gatewayId === "builder-alice"
        ? {
            ...gateway,
            ready: false,
            ...(runtime === null ? {} : { runtime }),
            ...("vmStartedAt" in input
              ? { vmStartedAt: input.vmStartedAt ?? null }
              : {}),
            ...("runtimeStartedAt" in input
              ? { runtimeStartedAt: input.runtimeStartedAt ?? null }
              : {}),
          }
        : gateway
    ),
  });
}
