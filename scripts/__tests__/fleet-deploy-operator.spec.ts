import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { centralGatewayReleasePayload, type ReleaseDigestManifest } from "@octogee/core/artifact-registry";
import { GatewayRetirementConflictError } from "@octogee/core/gateway-retirement-claim";
import { InvalidGatewayRootError, StaleGatewayReleaseError } from "@octogee/core/gateway-release-append";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { FleetDeploymentDeferredError } from "../lib/fleet-deploy.js";
import { PLATFORM_RELEASE_RECORD_DOC_PATH, releasePayloadHash } from "@octogee/shared/types/gateway-releases";

const mocks = vi.hoisted(() => ({ append: vi.fn(), mutate: vi.fn() }));
vi.mock("@octogee/core/gateway-release-append", async (importOriginal) => ({
  ...await importOriginal<typeof import("@octogee/core/gateway-release-append")>(),
  appendGatewayRelease: mocks.append,
}));
vi.mock("@octogee/core/normal-fleet-mutation", () => ({ runNormalFleetMutation: mocks.mutate }));
import { deployFleetUser, parseFleetDeployArgs, readFleetSnapshot } from "../ops/deploy-fleet.js";

const manifest: ReleaseDigestManifest = {
  sourceSha: "a".repeat(40), manifestDigest: `sha256:${"d".repeat(64)}`, openclawVersion: "2026.10.2", repository: "registry/images",
  surfaces: { gateway: { "octogee-gateway": `sha256:${"a".repeat(64)}`, "octogee-gateway-builder": `sha256:${"b".repeat(64)}`, "gateway-edge": `sha256:${"c".repeat(64)}` }, platform: {} },
};
const payload = centralGatewayReleasePayload(manifest);

function gatewayRoot(gatewayId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId, createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "paused",
    configSchemaVersion: 1, profile: null, gatewayClass: "isolated", imageProfile: "isolated", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: "u1", builderSlug: "alice", modelBrokerLimits: null, preemption: null,
    ...overrides,
  };
}

function platformRecord(payloadHash = releasePayloadHash(payload)): Record<string, unknown> {
  return { schemaVersion: 1, payloadHash, imageTag: payload.imageTag, openclawSourceSha: null, writtenAt: 100 };
}

function retirement(status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "retire-gateway", status, createdBy: "operator:test", createdAt: 10, startedAt: 11, completedAt: status === "succeeded" ? 12 : null,
    input: { gatewayId: "b-paused" }, steps: [], gatewayId: "b-paused", ...overrides,
  };
}

function fixture(docs: Record<string, Record<string, unknown>> = {}) {
  const records = new Map<string, Record<string, unknown>>(Object.entries({
    "gateways/b-paused": gatewayRoot("b-paused"),
    [PLATFORM_RELEASE_RECORD_DOC_PATH]: platformRecord(),
    ...docs,
  }));
  return { store: createDocumentFixtureStore(records), records };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.append.mockResolvedValue({ release: 2, operationId: "roll-2" });
  mocks.mutate.mockImplementation(async (_store, mutation) => mutation.action());
});

afterEach(() => vi.unstubAllEnvs());

describe("TEST fleet operator release mutation", () => {
  it("journals a PROD user release in the PROD environment", async () => {
    const { store } = fixture();
    await deployFleetUser(store, { gatewayId: "b-paused" }, manifest, payload, "prod");
    expect(mocks.mutate).toHaveBeenCalledWith(store, expect.objectContaining({ target: { gatewayId: "b-paused", environment: "prod" } }));
  });
  it("uses the ordinary audit wrapper and immutable append without changing paused status", async () => {
    const { store, records } = fixture();
    expect(await deployFleetUser(store, { gatewayId: "b-paused" }, manifest, payload, "test")).toEqual({ release: 2, operationId: "roll-2" });
    expect(mocks.mutate).toHaveBeenCalledWith(store, expect.objectContaining({
      forced: false, target: { gatewayId: "b-paused", environment: "test" },
      mutation: { kind: "deploy-gateway-build", gatewayId: "b-paused", sourceSha: manifest.sourceSha, manifestDigest: manifest.manifestDigest },
    }));
    expect(mocks.append).toHaveBeenCalledWith(store, expect.objectContaining({ gateway: gatewayRoot("b-paused"), payload, artifact: payload, sourceRelease: 1, origin: "operator" }));
    expect(records.get("gateways/b-paused")?.desiredStatus).toBe("paused");
  });
  it.each([new GatewayRetirementConflictError("transfer busy"), new StaleGatewayReleaseError("b-paused", 1, 2)])("defers typed owned mutation races: %s", async (error) => {
    const { store } = fixture();
    mocks.append.mockRejectedValue(error);
    await expect(deployFleetUser(store, { gatewayId: "b-paused" }, manifest, payload, "test")).rejects.toBeInstanceOf(FleetDeploymentDeferredError);
    expect(mocks.mutate).toHaveBeenCalledOnce();
  });
  it.each([true, false])("requires succeeded owned retirement proof for a root deleted during append: %s", async (succeeded) => {
    const { store } = fixture({ "glmOperations/retire-1": retirement(succeeded ? "succeeded" : "running") });
    mocks.append.mockRejectedValue(new InvalidGatewayRootError("b-paused"));
    await expect(deployFleetUser(store, { gatewayId: "b-paused" }, manifest, payload, "test")).rejects.toBeInstanceOf(succeeded ? FleetDeploymentDeferredError : InvalidGatewayRootError);
  });
  it("ignores a succeeded retirement of another gateway as proof for a deleted root", async () => {
    const { store } = fixture({ "glmOperations/retire-1": retirement("succeeded", { input: { gatewayId: "b-other" }, gatewayId: "b-other" }) });
    mocks.append.mockRejectedValue(new InvalidGatewayRootError("b-paused"));
    await expect(deployFleetUser(store, { gatewayId: "b-paused" }, manifest, payload, "test")).rejects.toBeInstanceOf(InvalidGatewayRootError);
  });
  it.each([true, false])("requires succeeded owned retirement proof for a root missing before the mutation: %s", async (succeeded) => {
    const { store, records } = fixture({ "glmOperations/retire-1": retirement(succeeded ? "succeeded" : "running") });
    records.delete("gateways/b-paused");
    await expect(deployFleetUser(store, { gatewayId: "b-paused" }, manifest, payload, "test")).rejects.toBeInstanceOf(succeeded ? FleetDeploymentDeferredError : InvalidGatewayRootError);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("defers a user that retired during deployment selection", async () => {
    const { store } = fixture({ "gateways/b-paused": gatewayRoot("b-paused", { desiredStatus: "retired" }) });
    await expect(deployFleetUser(store, { gatewayId: "b-paused" }, manifest, payload, "test")).rejects.toBeInstanceOf(FleetDeploymentDeferredError);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("fails closed on a stored root that is not a durable gateway root", async () => {
    const { store } = fixture({ "gateways/b-paused": { gatewayId: "b-paused", gatewayClass: "isolated" } });
    await expect(deployFleetUser(store, { gatewayId: "b-paused" }, manifest, payload, "test")).rejects.toBeInstanceOf(MalformedRecordError);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("retains the explicit operator identity and reason in the operations journal", async () => {
    vi.stubEnv("RELEASE_ACTOR", "operator:chris");
    vi.stubEnv("RELEASE_REASON", "Ship TEST from Cloud Build 123");
    const { store } = fixture();
    await deployFleetUser(store, { gatewayId: "b-paused" }, manifest, payload, "test");
    expect(mocks.mutate).toHaveBeenCalledWith(store, expect.objectContaining({ actor: "operator:chris", why: "Ship TEST from Cloud Build 123" }));
  });
  it("revalidates isolated class before writing an audit or release", async () => {
    const { store } = fixture({ "gateways/b-paused": gatewayRoot("b-paused", { gatewayClass: "shared", imageProfile: "standard", ownerUid: null, builderSlug: null }) });
    await expect(deployFleetUser(store, { gatewayId: "b-paused" }, manifest, payload, "test")).rejects.toThrow("non-retired isolated gateway");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("rechecks platform supersession immediately before a user mutation", async () => {
    const { store } = fixture({ [PLATFORM_RELEASE_RECORD_DOC_PATH]: platformRecord("e".repeat(64)) });
    await expect(deployFleetUser(store, { gatewayId: "b-paused" }, manifest, payload, "test")).rejects.toThrow("superseded");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("requires an immutable SHA and exposes no environment override", () => {
    expect(parseFleetDeployArgs([`--sha=${manifest.sourceSha}`])).toEqual({ sourceSha: manifest.sourceSha, timeoutMs: 2_700_000 });
    expect(() => parseFleetDeployArgs(["--sha=main"])).toThrow("full-lowercase-sha");
    expect(() => parseFleetDeployArgs([`--sha=${manifest.sourceSha}`, "--env=prod"])).toThrow("invalid TEST fleet argument");
  });
});

function release(gatewayId: string, number: number): Record<string, unknown> {
  return { gatewayId, release: number, payload, payloadHash: releasePayloadHash(payload), createdAt: 1, createdBy: "test", origin: "operator" };
}

function runtimeDoc(gatewayId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    docKind: "runtime", gatewayId, release: 1, lifecycle: "serving",
    heartbeat: { status: "ready", lastHeartbeatAt: 900, mountedCustomers: ["alice"], migratingIn: [] },
    ...overrides,
  };
}

function pod(gatewayId: string, uid: string, phase = "Running") {
  return {
    metadata: { uid, labels: { "gateway-instance": gatewayId } },
    spec: { containers: [{ name: "gateway", image: "registry/gateway:tag" }] },
    status: {
      phase, conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ name: "gateway", ready: true, state: { running: {} }, imageID: `registry/gateway@sha256:${"a".repeat(64)}` }],
    },
  };
}

describe("TEST fleet snapshot", () => {
  it("projects roots, releases, runtime, assignments, operations, retirements, replacements and the platform record", async () => {
    const { store } = fixture({
      "gateways/b-paused/releases/1": release("b-paused", 1),
      "gateways/b-paused/assignments/u1": {
        uid: "u1", slug: "alice", gatewayId: "b-paused", source: "onboarding", state: "serving", epoch: 0,
        createdAt: 1, updatedAt: 1, updatedByOperationId: null,
      },
      "glmGateways/b-paused": runtimeDoc("b-paused"),
      "glmOperations/roll-1": {
        kind: "rollout", status: "failed", createdBy: "operator:test", createdAt: 1, startedAt: 2, completedAt: 3,
        input: { gatewayId: "b-paused", targetRelease: 1 }, steps: [], error: "image pull failed",
      },
      "glmOperations/roll-other": {
        kind: "rollout", status: "succeeded", createdBy: "operator:test", createdAt: 1, startedAt: 2, completedAt: 3,
        input: { gatewayId: "b-other", targetRelease: 4 }, steps: [],
      },
      "glmOperations/retire-1": retirement("succeeded", { input: { gatewayId: "b-gone" }, gatewayId: "b-gone" }),
      "glmOperations/retire-2": retirement("running", { input: { gatewayId: "b-going" }, gatewayId: "b-going" }),
      "glmControllerState/sharedPoolScaler": {
        schemaVersion: 1, actionSequence: 3, lastActionAt: 50, updatedAt: 50,
        replacements: [{ sourceGatewayId: "shared-1", targetGatewayId: "shared-2", updatedAt: 40 }],
      },
    });
    const snapshot = await readFleetSnapshot(store, async () => ({ items: [pod("b-paused", "pod-1"), pod("b-gone", "pod-2"), pod("b-paused", "pod-3", "Succeeded")] }));

    expect(snapshot.platform).toEqual(platformRecord());
    expect(snapshot.sharedReplacements).toEqual([{ sourceGatewayId: "shared-1", targetGatewayId: "shared-2", updatedAt: 40 }]);
    expect(snapshot.retirements).toEqual([{ gatewayId: "b-gone", operationId: "retire-1", completedAt: 12, live: { observedAt: expect.any(Number), instances: [expect.objectContaining({ id: "pod-2" })] } }]);
    expect(snapshot.gateways).toEqual([expect.objectContaining({
      gatewayId: "b-paused", gatewayClass: "isolated", imageProfile: "isolated", desiredStatus: "paused",
      latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredPayload: payload, latestPayload: payload,
      runtime: { release: 1, lifecycle: "serving", status: "ready", heartbeatAt: 900, mountedCustomers: ["alice"], migratingIn: [] },
      live: { observedAt: expect.any(Number), instances: [expect.objectContaining({ id: "pod-1", ready: true })] },
      assignments: [{ slug: "alice", state: "serving" }],
      operations: [{ id: "roll-1", release: 1, status: "failed", error: "image pull failed" }],
    })]);
  });

  it("says who added each shared gateway and leaves isolated gateways unlabelled", async () => {
    const shared = { configSchemaVersion: 1, gatewayClass: "shared", imageProfile: "standard", ownerUid: null, builderSlug: null, desiredStatus: "running" };
    const { store } = fixture({
      "gateways/shared-1": gatewayRoot("shared-1", { ...shared, createdBy: "glm-controller-shared-pool-scaler" }),
      "gateways/shared-ops": gatewayRoot("shared-ops", { ...shared, createdBy: "operator-uid" }),
    });

    const snapshot = await readFleetSnapshot(store, async () => ({ items: [] }));

    expect(Object.fromEntries(snapshot.gateways.map((gateway) => [gateway.gatewayId, gateway.addedBy]))).toEqual({
      "b-paused": null, "shared-1": "automation", "shared-ops": "operator",
    });
  });

  it("reports a missing release payload, runtime record and pod as absent", async () => {
    const { store } = fixture();
    const snapshot = await readFleetSnapshot(store, async () => ({ items: [] }));

    expect(snapshot.gateways).toEqual([expect.objectContaining({
      gatewayId: "b-paused", desiredPayload: null, latestPayload: null, runtime: null,
      live: { observedAt: expect.any(Number), instances: [] }, assignments: [], operations: [],
    })]);
    expect(snapshot.sharedReplacements).toEqual([]);
  });

  it("fails closed on a release that stores another gateway's payload", async () => {
    const { store } = fixture({ "gateways/b-paused/releases/1": release("b-other", 1) });
    await expect(readFleetSnapshot(store, async () => ({ items: [] }))).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("fails closed on a runtime record that names another gateway", async () => {
    const { store } = fixture({ "glmGateways/b-paused": runtimeDoc("b-other") });
    await expect(readFleetSnapshot(store, async () => ({ items: [] }))).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("fails closed on shared-pool scaler state without its schema version", async () => {
    const { store } = fixture({ "glmControllerState/sharedPoolScaler": { replacements: [] } });
    await expect(readFleetSnapshot(store, async () => ({ items: [] }))).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("fails closed on an unreadable platform release record", async () => {
    const { store } = fixture({ [PLATFORM_RELEASE_RECORD_DOC_PATH]: { schemaVersion: 1 } });
    await expect(readFleetSnapshot(store, async () => ({ items: [] }))).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("fails closed on a malformed assignment", async () => {
    const { store } = fixture({ "gateways/b-paused/assignments/u1": { slug: "alice", state: "serving" } });
    await expect(readFleetSnapshot(store, async () => ({ items: [] }))).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("fails closed on a stored root that is not a durable gateway root", async () => {
    const { store } = fixture({ "gateways/b-broken": { gatewayId: "b-broken" } });
    await expect(readFleetSnapshot(store, async () => ({ items: [] }))).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("keeps the invalid durable root error for a root whose configuration does not project", async () => {
    const { store } = fixture({ "gateways/b-broken": gatewayRoot("b-broken", { configSchemaVersion: 0 }) });
    await expect(readFleetSnapshot(store, async () => ({ items: [] }))).rejects.toThrow("gateway b-broken has an invalid durable root");
  });
});
