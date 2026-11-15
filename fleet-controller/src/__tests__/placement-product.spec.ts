import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import type { FleetInformer } from "../fleet-informer.js";
import type { GatewayPodDiagnostics } from "../gateway-kubernetes-observation.js";
import { startPlacement, type PlacementProductDeps } from "../placement-product.js";
import { noUserPolicyInputs } from "../user-placement-document.js";

type Records = Map<string, Record<string, unknown>>;

function sharedRoot(gatewayId: string, desiredStatus: string): Record<string, unknown> {
  return {
    gatewayId, createdAt: 1, createdBy: "operator", updatedAt: 1, updatedBy: "operator",
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus, configSchemaVersion: 1,
    profile: "standard", gatewayClass: "shared", imageProfile: "standard", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: null, builderSlug: null, modelBrokerLimits: null, preemption: null, coOwnerUids: [],
  };
}

function runtime(gatewayId: string): Record<string, unknown> {
  return {
    docKind: "runtime", gatewayId, release: 1, lifecycle: "serving", createdAt: 1, createdByOperationId: null,
    helm: {}, heartbeat: { status: "ready", mountedCustomers: [] }, lastError: { message: null, at: null },
  };
}

function user(slug: string, gatewayId: string | null): Record<string, unknown> {
  return {
    username: slug,
    onboardingStep: "complete",
    provisioning: { status: "complete", openclaw: { slug, status: "complete", ...(gatewayId ? { gatewayId } : {}) } },
  };
}

function assignment(uid: string, slug: string, gatewayId: string): Record<string, unknown> {
  return {
    uid, slug, gatewayId, source: "onboarding", state: "serving", epoch: 1,
    createdAt: 1, updatedAt: 1, updatedByOperationId: null,
  };
}

function platformInstall(): Records {
  return new Map(Object.entries({
    "gateways/shared-a": sharedRoot("shared-a", "running"),
    "gateways/shared-old": sharedRoot("shared-old", "draining"),
    "glmGateways/shared-a": runtime("shared-a"),
    "glmGateways/shared-old": runtime("shared-old"),
    "users/uid-ada": user("ada", "shared-a"),
    "users/uid-bob": user("bob", "shared-old"),
    "users/uid-cy": user("cy", null),
    "gateways/shared-a/assignments/uid-ada": assignment("uid-ada", "ada", "shared-a"),
    "gateways/shared-old/assignments/uid-bob": assignment("uid-bob", "bob", "shared-old"),
  }));
}

const informerWithoutMirrors = {
  gateways: () => null,
  fleetRegistry: () => null,
  assignments: () => null,
  usersWithoutMalformed: () => null,
} as unknown as FleetInformer;

function placementDeps(records: Records, log: (message: string) => void): PlacementProductDeps {
  const ready: GatewayPodDiagnostics = { status: "ready", totalPods: 1, readyPods: 1 };
  return {
    store: createDocumentFixtureStore(records),
    informer: informerWithoutMirrors,
    policyInputs: noUserPolicyInputs,
    readSizingKey: async () => null,
    namespace: "octogee",
    platformArtifact: { imageRepository: "registry.example/gateway", imageTag: "build@sha256:1" } as PlacementProductDeps["platformArtifact"],
    now: () => 1_000,
    log,
    debug: () => undefined,
    ensureAuthSecret: vi.fn(async () => undefined),
    readGatewayPodDiagnostics: vi.fn(async () => ({ status: "ready", totalPods: 1 })),
    readGatewayPodDiagnosticsBatch: vi.fn(async ({ gatewayIds }: { gatewayIds: readonly string[] }) =>
      Object.fromEntries(gatewayIds.map((gatewayId) => [gatewayId, ready]))),
  };
}

describe("placement on a controller with no product installed", () => {
  it("places, moves, wakes and idles no one: it records what Kubernetes sees and tells the operator what to do by hand", async () => {
    const records = platformInstall();
    const before = new Set(records.keys());
    const log = vi.fn();

    const stop = startPlacement(undefined, placementDeps(records, log));
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("draining shared gateway")));
    stop();

    expect([...records.keys()].filter((key) => !before.has(key))).toEqual([]);
    expect(records.get("gateways/shared-old")?.desiredStatus).toBe("draining");
    expect(records.get("users/uid-cy")?.provisioning).toEqual(user("cy", null).provisioning);
    expect(records.get("glmGateways/shared-a")?.kubernetes).toMatchObject({ status: "ready", totalPods: 1, readyPods: 1, observedAt: 1_000 });
    expect(log.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining("placement: platform only; no user is placed, moved, woken or idled automatically"),
      "[placement] ⚠ platform only: 1 user(s) have no gateway: uid-cy; place them with user assign",
      "[placement] ⚠ platform only: draining shared gateway shared-old keeps 1 user(s); " +
        "move them one at a time with user migrate, then retire it",
    ]);
  });

  it("hands placement to the product when one is installed, without observing on its own", () => {
    const records = platformInstall();
    const stopProduct = vi.fn();
    const product = vi.fn(() => stopProduct);
    const startObserver = vi.fn(() => () => undefined);
    const deps = placementDeps(records, vi.fn());

    const stop = startPlacement(product, deps, startObserver);
    stop();

    expect(product).toHaveBeenCalledWith(deps);
    expect(startObserver).not.toHaveBeenCalled();
    expect(stopProduct).toHaveBeenCalledOnce();
  });
});
