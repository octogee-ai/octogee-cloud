import { describe, expect, it, vi } from "vitest";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { runNativeReturnHoldReaperTick } from "../native-return-hold-reaper.js";

const NOW = 1_700_000_000_000;

type Data = Record<string, any>;

function runtime(gatewayId: string, fields: Data): Data {
  return { docKind: "runtime", gatewayId, release: 1, lifecycle: "active", ...fields };
}

function root(gatewayId: string): Data {
  return {
    gatewayId,
    gatewayClass: "isolated",
    ownerUid: "alice",
    builderSlug: "alice",
    desiredRelease: 1,
    latestRelease: 1,
    desiredStatus: "paused",
  };
}

function harness(input: {
  gateways: Record<string, Data>;
  operations?: Record<string, Data>;
  mirrorStale?: boolean;
}) {
  const docs: Record<string, Data> = {};
  for (const [id, data] of Object.entries(input.gateways)) {
    docs[`glmGateways/${id}`] = runtime(id, data);
    docs[`gateways/${id}`] = root(id);
  }
  for (const [id, data] of Object.entries(input.operations ?? {})) docs[`glmOperations/${id}`] = data;
  const store = createDocumentFixtureStore(docs);
  const scan = vi.spyOn(store.fleetRegistry, "list");
  const informer = {
    fleetRegistry: () => (input.mirrorStale
      ? null
      : Object.keys(input.gateways).map((id) => {
        const { docKind: _docKind, ...record } = structuredClone(docs[`glmGateways/${id}`]);
        return { ...record, revision: "mirrored" };
      })),
  };
  const log = vi.fn();
  const vm = { describe: vi.fn(async (): Promise<{ status: string; instanceId: string } | null> => ({ status: "TERMINATED", instanceId: "vm-1" })) };
  const deps = { vm: vm as never, store, informer: informer as never, log, now: () => NOW };
  return { deps, docs, log, scan, vm, store };
}

const heldGateway = (returnOperationId: string) => ({
  runtime: "gce-vm",
  vm: { instanceName: "computer", instanceId: "vm-1", zone: "us-central1-a" },
  vmHome: { returnOperationId, checkpointRequestedAt: 500, parkRequestedAt: 500, lastCheckpoint: { completedAt: 400 } },
});

function expectHoldUntouched(h: ReturnType<typeof harness>, gatewayId: string, returnOperationId: string) {
  expect(h.docs[`glmGateways/${gatewayId}`].vmHome.returnOperationId).toBe(returnOperationId);
  expect(h.docs[`glmOperations/native-return-hold-release-${gatewayId}-${returnOperationId}`]).toBeUndefined();
}

describe("native return hold reaper", () => {
  it.each(["failed", "succeeded", "rolled-back"])(
    "releases a hold whose return operation is %s and journals the release",
    async (status) => {
      const h = harness({
        gateways: { native: heldGateway("builder-return-native") },
        operations: { "builder-return-native": { kind: "migrate-user", status } },
      });
      const result = await runNativeReturnHoldReaperTick(h.deps);
      expect(result).toEqual({ scanned: 1, released: 1 });
      expect(h.docs["glmGateways/native"].vmHome).toEqual({ lastCheckpoint: { completedAt: 400 } });
      const journal = h.docs["glmOperations/native-return-hold-release-native-builder-return-native"];
      expect(journal).toMatchObject({
        kind: "migrate-user",
        status: "succeeded",
        origin: "automatic",
        createdBy: "glm-controller-native-return-hold-reaper",
        createdAt: NOW,
        completedAt: NOW,
        gatewayId: "native",
        input: { gatewayId: "native", returnOperationId: "builder-return-native", returnOperationStatus: status },
        output: { released: true },
      });
      expect(journal.expireAt).toBeDefined();
      expect(h.log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`native-return-hold-reaper.*native.*builder-return-native is ${status}`)));
    },
  );

  it("releases a hold whose return operation no longer exists", async () => {
    const h = harness({ gateways: { native: heldGateway("builder-return-native") } });
    expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 1, released: 1 });
    expect(h.docs["glmGateways/native"].vmHome.returnOperationId).toBeUndefined();
    expect(h.docs["glmOperations/native-return-hold-release-native-builder-return-native"].input)
      .toMatchObject({ returnOperationStatus: "missing" });
  });

  it.each(["failed", "succeeded", "missing"])("retains a %s operation's hold while Compute still runs", async status => {
    const h = harness({ gateways: { native: heldGateway("return-op") },
      operations: status === "missing" ? {} : { "return-op": { kind: "migrate-user", status, cutoverCommittedAt: 600 } } });
    h.vm.describe.mockResolvedValue({ status: "RUNNING", instanceId: "vm-1" });
    expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 1, released: 0 });
    expectHoldUntouched(h, "native", "return-op");
  });

  it.each(["pending", "running"])("keeps the hold while the return operation is %s", async (status) => {
    const h = harness({
      gateways: { native: heldGateway("builder-return-native") },
      operations: { "builder-return-native": { kind: "migrate-user", status } },
    });
    expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 1, released: 0 });
    expectHoldUntouched(h, "native", "builder-return-native");
  });

  it.each([{ kind: "migrate-user" }, { kind: "migrate-user", status: 7 }])(
    "keeps the hold and logs when the return operation record is malformed (%o), still sweeping other gateways",
    async (operation) => {
      const h = harness({
        gateways: { broken: heldGateway("builder-return-broken"), native: heldGateway("builder-return-native") },
        operations: {
          "builder-return-broken": operation,
          "builder-return-native": { kind: "migrate-user", status: "failed" },
        },
      });
      expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 2, released: 1 });
      expect(h.docs["glmGateways/broken"].vmHome.returnOperationId).toBe("builder-return-broken");
      expect(h.docs["glmGateways/native"].vmHome.returnOperationId).toBeUndefined();
      expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/native-return-hold-reaper.*broken.*builder-return-broken.*malformed status/));
    },
  );

  it("keeps the hold and logs when the gateway's runtime record is malformed, still sweeping other gateways", async () => {
    const h = harness({
      gateways: { broken: heldGateway("builder-return-broken"), native: heldGateway("builder-return-native") },
      operations: {
        "builder-return-broken": { kind: "migrate-user", status: "failed" },
        "builder-return-native": { kind: "migrate-user", status: "failed" },
      },
    });
    delete h.docs["glmGateways/broken"].lifecycle;
    expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 2, released: 1 });
    expect(h.docs["glmGateways/broken"].vmHome.returnOperationId).toBe("builder-return-broken");
    expect(h.docs["glmGateways/native"].vmHome.returnOperationId).toBeUndefined();
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/native-return-hold-reaper.*broken.*builder-return-broken not released/));
  });

  it("ignores gateways without a return hold, including plain park checkpoints", async () => {
    const h = harness({
      gateways: {
        parked: { runtime: "gce-vm", vmHome: { checkpointRequestedAt: 500, parkRequestedAt: 500 } },
        cluster: { runtime: "cluster" },
      },
    });
    const before = structuredClone(h.docs);
    expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 2, released: 0 });
    expect(h.docs).toEqual(before);
  });

  it("re-checks the hold inside the transaction and leaves a hold that moved to another operation", async () => {
    const h = harness({
      gateways: { native: heldGateway("builder-return-native") },
      operations: { "builder-return-native": { kind: "migrate-user", status: "failed" } },
    });
    const original = h.store.transaction.bind(h.store);
    vi.spyOn(h.store, "transaction").mockImplementation(((options: never, body: never) => {
      h.docs["glmGateways/native"].vmHome.returnOperationId = "builder-return-native-2";
      return original(options, body);
    }) as typeof h.store.transaction);
    expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 1, released: 0 });
    expectHoldUntouched(h, "native", "builder-return-native-2");
    expect(h.docs["glmOperations/native-return-hold-release-native-builder-return-native"]).toBeUndefined();
  });

  it("does not journal twice when the release journal already exists", async () => {
    const h = harness({
      gateways: { native: heldGateway("builder-return-native") },
      operations: {
        "builder-return-native": { kind: "migrate-user", status: "failed" },
        "native-return-hold-release-native-builder-return-native": { status: "succeeded", createdAt: 1 },
      },
    });
    expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 1, released: 1 });
    expect(h.docs["glmGateways/native"].vmHome.returnOperationId).toBeUndefined();
    expect(h.docs["glmOperations/native-return-hold-release-native-builder-return-native"]).toEqual({ status: "succeeded", createdAt: 1 });
  });

  it("falls back to the registry when the fleetRegistry mirror is stale", async () => {
    const h = harness({
      gateways: { native: heldGateway("builder-return-native") },
      operations: { "builder-return-native": { kind: "migrate-user", status: "failed" } },
      mirrorStale: true,
    });
    expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 1, released: 1 });
    expect(h.scan).toHaveBeenCalledOnce();
  });

  it("fails the whole tick on one malformed runtime record while the fleetRegistry mirror is stale", async () => {
    const h = harness({
      gateways: { native: heldGateway("builder-return-native") },
      operations: { "builder-return-native": { kind: "migrate-user", status: "failed" } },
      mirrorStale: true,
    });
    h.docs["glmGateways/broken"] = { docKind: "runtime", gatewayId: "other" };
    await expect(runNativeReturnHoldReaperTick(h.deps)).rejects.toBeInstanceOf(MalformedRecordError);
    expectHoldUntouched(h, "native", "builder-return-native");
  });

  it.each(["STOPPING", "replacement", "read-failure", "binding-missing"])("retains terminal holds without exact stop proof: %s", async kind => {
    const h = harness({ gateways: { native: heldGateway("return-op") }, operations: { "return-op": { status: "failed" } } });
    if (kind === "STOPPING") h.vm.describe.mockResolvedValue({ status: "STOPPING", instanceId: "vm-1" });
    if (kind === "replacement") h.vm.describe.mockResolvedValue({ status: "STOPPED", instanceId: "vm-2" });
    if (kind === "read-failure") h.vm.describe.mockRejectedValue(new Error("Compute unavailable"));
    if (kind === "binding-missing") delete h.docs["glmGateways/native"].vm.instanceId;
    expect(await runNativeReturnHoldReaperTick(h.deps)).toMatchObject({ released: 0 });
    expectHoldUntouched(h, "native", "return-op");
  });

  it.each(["hold", "claim", "instance", "desired"])("revalidates %s after the Compute read", async kind => {
    const h = harness({ gateways: { native: heldGateway("return-op") }, operations: { "return-op": { status: "failed", startedAt: 1 } } });
    h.vm.describe.mockImplementation(async () => {
      if (kind === "hold") h.docs["glmGateways/native"].vmHome.checkpointRequestedAt = 501;
      if (kind === "claim") h.docs["glmOperations/return-op"] = { status: "running", startedAt: 2 };
      if (kind === "instance") h.docs["glmGateways/native"].vm.instanceId = "vm-2";
      if (kind === "desired") h.docs["gateways/native"].desiredStatus = "running";
      return { status: "TERMINATED", instanceId: "vm-1" };
    });
    expect(await runNativeReturnHoldReaperTick(h.deps)).toMatchObject({ released: 0 });
    expectHoldUntouched(h, "native", "return-op");
  });

  it("releases a proven uncommitted rollback while the source remains its owner's assigned runtime", async () => {
    const h = harness({ gateways: { native: heldGateway("return-op") }, operations: { "return-op": { kind: "migrate-user", status: "rolled-back", input: { uid: "alice", fromGatewayId: "native" } } } });
    h.docs["gateways/native"].desiredStatus = "running";
    h.docs["users/alice"] = { provisioning: { openclaw: { gatewayId: "native" } } };
    h.vm.describe.mockResolvedValue({ status: "RUNNING", instanceId: "vm-1" });
    expect(await runNativeReturnHoldReaperTick(h.deps)).toMatchObject({ released: 1 }); expect(h.vm.describe).not.toHaveBeenCalled();
  });

  it("does not infer rollback from a missing operation even with an assigned running source", async () => {
    const h = harness({ gateways: { native: heldGateway("return-op") } });
    h.docs["gateways/native"].desiredStatus = "running";
    h.docs["users/alice"] = { provisioning: { openclaw: { gatewayId: "native" } } };
    expect(await runNativeReturnHoldReaperTick(h.deps)).toMatchObject({ released: 0 });
    expectHoldUntouched(h, "native", "return-op");
  });
});
