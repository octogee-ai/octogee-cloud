import { describe, expect, it, vi } from "vitest";
import { createJournalFixtureStore, fixtureDocumentsAt, journalRowsAtPaths } from "@octogee/core/testing/journal-store";
import { prepareNativeVmReturn, releaseNativeReturnSourceRecoveryHold } from "./native-vm-return.js";

const input = { fromGatewayId: "native", toGatewayId: "shared", uid: "alice-id", slug: "alice", operationId: "return-1", claimedStartedAt: 900 };

function harness() {
  const docs: Record<string, any> = {
    "glmGateways/native": {
      docKind: "runtime", gatewayId: "native", release: 1, lifecycle: "serving",
      runtime: "gce-vm", vm: { instanceName: "computer", zone: "us-central1-a", instanceId: "vm-id" }, vmHome: {},
    },
    "gateways/native": { gatewayId: "native", gatewayClass: "isolated", ownerUid: "alice-id", builderSlug: "alice", desiredStatus: "running", desiredRelease: 1, latestRelease: 1 },
    "gateways/shared": { gatewayId: "shared", gatewayClass: "shared", desiredStatus: "running", desiredRelease: 1, latestRelease: 1 },
    "users/alice-id": { provisioning: { openclaw: { gatewayId: "native" } } },
    "glmOperations/return-1": { kind: "migrate-user", status: "running", startedAt: 900, input: { uid: "alice-id", fromGatewayId: "native", toGatewayId: "shared" } },
  };
  const documents = fixtureDocumentsAt(docs);
  const update = vi.fn();
  const store = createJournalFixtureStore(journalRowsAtPaths(docs), { documents: {
    ...documents,
    set: (path, row) => { update(path, row); documents.set(path, row); },
    delete: (path) => { update(path, undefined); documents.delete(path); },
  } });
  let now = 1000;
  const wait = vi.fn(async (ms: number) => { now += ms; });
  const vm = {
    describe: vi.fn(async (): Promise<{ status: string; instanceId: string } | null> => ({ status: "RUNNING", instanceId: "vm-id" })),
    stop: vi.fn(async () => undefined),
  };
  const deps = { store, vm: vm as never, now: () => now, wait, timeoutMs: 100 };
  return {
    deps, docs, update, vm,
    get source() { return docs["glmGateways/native"]; },
    get root() { return docs["gateways/native"]; },
    get target() { return docs["gateways/shared"]; },
    get user() { return docs["users/alice-id"]; },
  };
}

describe("native computer return checkpoint", () => {
  it.each([null, "TERMINATED", "STOPPED", "SUSPENDED", "RUNNING"])("reports the recorded source computer's Compute status (%s)", async (status) => {
    const h = harness();
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn> };
    vm.describe.mockResolvedValue(status === null ? null : { status, instanceId: "vm-id" });
    const native = (await prepareNativeVmReturn(h.deps, input))!;
    expect(await native.sourceVmStatus()).toBe(status);
    expect(vm.describe).toHaveBeenCalledWith("computer", "us-central1-a");
  });

  it("does not report a replacement instance or a missing record as the source computer's status", async () => {
    const h = harness();
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn> };
    vm.describe.mockResolvedValue({ status: "TERMINATED", instanceId: "replacement-id" });
    const native = (await prepareNativeVmReturn(h.deps, input))!;
    await expect(native.sourceVmStatus()).rejects.toThrow(/replaced/);
    vm.describe.mockRejectedValue(new Error("Compute unavailable"));
    await expect(native.sourceVmStatus()).rejects.toThrow("Compute unavailable");
    delete h.source.vm;
    await expect(native.sourceVmStatus()).rejects.toThrow(/no recorded computer/);
  });

  it("scopes native returns to the matching owner and a Shared target", async () => {
    const h = harness();
    h.source.runtime = "kubernetes";
    expect(await prepareNativeVmReturn(h.deps, input)).toBeNull();
    h.source.runtime = "gce-vm";
    h.target.gatewayClass = "isolated";
    expect(await prepareNativeVmReturn(h.deps, input)).toBeNull();
    h.target.gatewayClass = "shared";
    h.root.ownerUid = "bob";
    await expect(prepareNativeVmReturn(h.deps, input)).rejects.toThrow(/ownership changed/);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("takes the same path for an operator's return: a held owner with no lease, an operator-issued tag, no source on the operation", async () => {
    const h = harness();
    h.root.allocation = { kind: "disposable-builder", schemaVersion: 1, leaseId: "operator-7d2f", generation: 1, claimedByUid: "alice-id" };
    h.user.provisioning.openclaw = { gatewayId: "native", managedBy: "operator" };
    h.source.vmHome.lastCheckpoint = { completedAt: 500 };
    h.deps.wait.mockImplementation(async () => {
      h.source.vmHome.lastCheckpoint = { completedAt: 1001 };
      h.source.vmHome.checkpointAcknowledgedAt = 1000;
    });

    const native = (await prepareNativeVmReturn(h.deps, input))!;
    await native.requestCheckpoint();
    await native.awaitCheckpoint();

    expect(h.docs["glmOperations/return-1"].input).not.toHaveProperty("source");
    expect(h.user.provisioning.openclaw.activationLease).toBeUndefined();
    expect(h.source.vmHome).toMatchObject({ checkpointRequestedAt: 1000, parkRequestedAt: 1000, returnOperationId: "return-1" });
    expect(h.source.vmHome.lastCheckpoint.completedAt).toBeGreaterThan(1000);
  });

  it("refuses native return recovery when its old target root disappeared", async () => {
    const h = harness();
    delete h.docs["gateways/shared"];
    await expect(prepareNativeVmReturn(h.deps, input)).rejects.toThrow("native computer return target is unavailable: shared");
    expect(h.update).not.toHaveBeenCalled();
    h.source.runtime = "kubernetes";
    expect(await prepareNativeVmReturn(h.deps, input)).toBeNull();
  });

  it("releases only its exact pre-cutover source hold after typed recovery proves the target removed", async () => {
    const h = harness(); await (await prepareNativeVmReturn(h.deps, input))!.requestCheckpoint();
    delete h.docs["gateways/shared"];
    await releaseNativeReturnSourceRecoveryHold(h.deps, input);
    expect(h.source.vmHome.returnOperationId).toBeUndefined(); expect(h.source.vmHome.checkpointRequestedAt).toBeUndefined();
    expect(h.user.provisioning.openclaw.gatewayId).toBe("native");
  });
  it.each(["claim", "owner", "foreign-hold"])("retains the source hold if recovery %s changes", async change => {
    const h = harness(); await (await prepareNativeVmReturn(h.deps, input))!.requestCheckpoint();
    if (change === "claim") h.docs["glmOperations/return-1"].startedAt = 901;
    if (change === "owner") h.root.ownerUid = "foreign";
    if (change === "foreign-hold") h.source.vmHome.returnOperationId = "foreign-return";
    const before = { ...h.source.vmHome }; delete h.docs["gateways/shared"];
    await expect(releaseNativeReturnSourceRecoveryHold(h.deps, input)).rejects.toThrow(); expect(h.source.vmHome).toEqual(before);
  });

  it("waits for acknowledgement of a fresh checkpoint and retains the hold for parking", async () => {
    const h = harness();
    h.source.vmHome.lastCheckpoint = { completedAt: 500 };
    h.deps.wait.mockImplementation(async () => {
      h.source.vmHome.lastCheckpoint = { completedAt: 1001 };
      h.source.vmHome.checkpointAcknowledgedAt = 1000;
    });
    const native = (await prepareNativeVmReturn(h.deps, input))!;
    expect(native.checkpointRequested).toBe(false);
    await native.requestCheckpoint();
    expect(h.source.vmHome).toMatchObject({ checkpointRequestedAt: 1000, parkRequestedAt: 1000, returnOperationId: "return-1" });
    expect(h.deps.wait).not.toHaveBeenCalled();
    await native.awaitCheckpoint();
    expect(h.deps.wait).toHaveBeenCalledOnce();
    const resumed = (await prepareNativeVmReturn(h.deps, input))!;
    expect(resumed.checkpointRequested).toBe(true);
    await resumed.requestCheckpoint();
    await resumed.awaitCheckpoint();
    expect(h.update).toHaveBeenCalledOnce();
  });

  it("rejects stale unacknowledged checkpoints and cancellation releases only its own hold", async () => {
    const h = harness();
    h.source.vmHome.lastCheckpoint = { completedAt: 2000 };
    const native = (await prepareNativeVmReturn(h.deps, input))!;
    await native.requestCheckpoint();
    await expect(native.awaitCheckpoint()).rejects.toThrow(/timeout/);
    await expect(native.release()).resolves.toBeUndefined();
    expect(h.source.vmHome.checkpointRequestedAt).toBeUndefined();
    expect(h.source.vmHome.parkRequestedAt).toBeUndefined();
    expect(h.source.vmHome.lastCheckpoint).toEqual({ completedAt: 2000 });
    h.source.vmHome = { returnOperationId: "other", checkpointRequestedAt: 3000 };
    await native.release();
    expect(h.source.vmHome.checkpointRequestedAt).toBe(3000);
    await expect(native.requestCheckpoint()).rejects.toThrow(/another checkpoint/);
  });

  it.each(["takeover", "terminal", "missing", "scope", "hold"])("retains a pre-cutover hold after %s changes", async change => {
    const h = harness();
    const native = (await prepareNativeVmReturn(h.deps, input))!;
    await native.requestCheckpoint();
    await expect(native.awaitCheckpoint()).rejects.toThrow(/timeout/);
    if (change === "takeover") h.docs["glmOperations/return-1"].startedAt = 901;
    if (change === "terminal") h.docs["glmOperations/return-1"].status = "failed";
    if (change === "missing") delete h.docs["glmOperations/return-1"];
    if (change === "scope") h.docs["glmOperations/return-1"].input.uid = "bob";
    if (change === "hold") h.source.vmHome.checkpointRequestedAt = 1001;
    await expect(native.release()).rejects.toThrow(/authority changed/);
    expect(h.source.vmHome.returnOperationId).toBe("return-1");
  });

  it("rejects a stale worker claiming a checkpoint after takeover", async () => {
    const h = harness();
    const native = (await prepareNativeVmReturn(h.deps, input))!;
    h.docs["glmOperations/return-1"].startedAt = 901;
    await expect(native.requestCheckpoint()).rejects.toThrow(/authority changed/);
    expect(h.update).not.toHaveBeenCalled();
  });

  function committedReturn(h: ReturnType<typeof harness>) {
    h.user.provisioning.openclaw.gatewayId = "shared";
    h.source.vm.instanceId = "vm-id";
    h.source.vmHome = { returnOperationId: "return-1", checkpointRequestedAt: 1000,
      parkRequestedAt: 1000, checkpointAcknowledgedAt: 1000,
      lastCheckpoint: { completedAt: 1001, instanceId: "vm-id" } };
    h.docs["glmOperations/return-1"] = { kind: "migrate-user", status: "running", startedAt: 900, cutoverCommittedAt: 1002,
      input: { uid: "alice-id", fromGatewayId: "native", toGatewayId: "shared" } };
    h.docs["gateways/shared/assignments/alice-id"] = { uid: "alice-id", gatewayId: "shared", slug: "alice", source: "migrate-user", epoch: 1, state: "serving" };
  }

  it("releases the writer hold on the committed source while it still runs, so the user can unmount the user", async () => {
    const h = harness(); committedReturn(h);
    const native = (await prepareNativeVmReturn(h.deps, input))!;
    await native.awaitCheckpoint();
    await native.releaseWriterHold();
    expect(h.source.vmHome).toEqual({ checkpointAcknowledgedAt: 1000, lastCheckpoint: { completedAt: 1001, instanceId: "vm-id" } });
    expect(h.root.desiredStatus).toBe("running");
    expect(h.vm.describe).not.toHaveBeenCalled();
    await (await prepareNativeVmReturn(h.deps, input))!.releaseWriterHold();
    expect(h.update).toHaveBeenCalledOnce();
  });

  it.each(["cutover", "operation", "target-assignment", "checkpoint-instance", "unacknowledged", "paused"])("retains the writer hold after %s changes", async change => {
    const h = harness(); committedReturn(h);
    if (change === "cutover") delete h.docs["glmOperations/return-1"].cutoverCommittedAt;
    if (change === "operation") h.docs["glmOperations/return-1"].input.uid = "bob";
    if (change === "target-assignment") h.docs["gateways/shared/assignments/alice-id"].state = "quiescing";
    if (change === "checkpoint-instance") h.source.vmHome.lastCheckpoint.instanceId = "different-vm";
    if (change === "unacknowledged") h.source.vmHome.checkpointAcknowledgedAt = 999;
    if (change === "paused") h.root.desiredStatus = "paused";
    const native = (await prepareNativeVmReturn(h.deps, input))!;
    await expect(native.releaseWriterHold()).rejects.toThrow(/authority changed/);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.source.vmHome.checkpointRequestedAt).toBe(1000);
  });

  async function releasedReturn(h: ReturnType<typeof harness>) {
    committedReturn(h);
    const native = (await prepareNativeVmReturn(h.deps, input))!;
    await native.releaseWriterHold();
    h.update.mockClear();
    return native;
  }

  it("parks the unmounted source by suspend and reports it suspended", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    vm.describe.mockImplementationOnce(async () => {
      expect(h.root.desiredStatus).toBe("paused");
      expect(h.source.vmStopOnPark).toBeUndefined();
      return { status: "SUSPENDING", instanceId: "vm-id" };
    }).mockResolvedValue({ status: "SUSPENDED", instanceId: "vm-id" });
    await expect(native.park({ mode: "suspend" })).resolves.toEqual({ parked: "suspended" });
    expect(h.deps.wait).toHaveBeenCalledOnce();
    expect(vm.stop).not.toHaveBeenCalled();
  });

  it("asks the fleet controller to stop rather than suspend a source whose live cleanup failed, and clears the request once stopped", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    vm.describe.mockImplementationOnce(async () => {
      expect(h.root.desiredStatus).toBe("paused");
      expect(h.source.vmStopOnPark).toEqual({ operationId: "return-1", reason: "unmount refused" });
      return { status: "STOPPING", instanceId: "vm-id" };
    }).mockResolvedValue({ status: "TERMINATED", instanceId: "vm-id" });
    await expect(native.park({ mode: "stop", reason: "unmount refused" })).resolves.toEqual({ parked: "stopped", stopReason: "unmount refused" });
    expect(h.source.vmStopOnPark).toBeUndefined();
    expect(vm.stop).not.toHaveBeenCalled();
  });

  it("clears a stale stop intent from an earlier attempt when live cleanup succeeded, and suspends", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    h.source.vmStopOnPark = { operationId: "return-1", reason: "live source cleanup failed: earlier attempt" };
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    vm.describe.mockImplementation(async () => {
      expect(h.root.desiredStatus).toBe("paused");
      expect(h.source.vmStopOnPark).toBeUndefined();
      return { status: "SUSPENDED", instanceId: "vm-id" };
    });
    await expect(native.park({ mode: "suspend" })).resolves.toEqual({ parked: "suspended" });
    expect(vm.stop).not.toHaveBeenCalled();
  });

  it("stops a source it finds suspended when the return requires a stop", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    vm.describe.mockResolvedValueOnce({ status: "SUSPENDED", instanceId: "vm-id" })
      .mockResolvedValue({ status: "TERMINATED", instanceId: "vm-id" });
    vm.stop.mockImplementation(async () => { expect(h.source.vmStopOnPark).toMatchObject({ operationId: "return-1", claimedAt: expect.any(Number) }); });
    await expect(native.park({ mode: "stop", reason: "source computer is SUSPENDED" })).resolves.toMatchObject({ parked: "stopped" });
    expect(vm.stop).toHaveBeenCalledExactlyOnceWith("computer", "us-central1-a");
    expect(h.source.vmStopOnPark).toBeUndefined();
  });

  it("does not suspend while a claimed stop is in flight: it waits for the stop and reports the source stopped", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    const claimed = { operationId: "return-1", reason: "live source cleanup failed: earlier attempt", claimedAt: 900 };
    h.source.vmStopOnPark = { ...claimed };
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    vm.describe.mockImplementationOnce(async () => {
      expect(h.source.vmStopOnPark).toEqual(claimed);
      return { status: "SUSPENDED", instanceId: "vm-id" };
    }).mockResolvedValue({ status: "TERMINATED", instanceId: "vm-id" });
    await expect(native.park({ mode: "suspend" })).resolves.toEqual({
      parked: "stopped", stopReason: "a claimed stop of return-1 is in flight: live source cleanup failed: earlier attempt",
    });
    expect(h.source.vmStopOnPark).toBeUndefined();
  });

  it("does not stop a suspended source itself once its stop request was withdrawn after the read", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    vm.describe.mockImplementationOnce(async () => {
      delete h.source.vmStopOnPark;
      return { status: "SUSPENDED", instanceId: "vm-id" };
    }).mockResolvedValue({ status: "TERMINATED", instanceId: "vm-id" });
    await expect(native.park({ mode: "stop", reason: "source computer is SUSPENDED" })).resolves.toMatchObject({ parked: "stopped" });
    expect(vm.stop).not.toHaveBeenCalled();
  });

  it("does not stop a suspended source after its operation claim was taken over, and fails on the lost claim", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    vm.describe.mockImplementation(async () => {
      h.docs["glmOperations/return-1"].startedAt = 901;
      return { status: "SUSPENDED", instanceId: "vm-id" };
    });
    await expect(native.park({ mode: "stop", reason: "source computer is SUSPENDED" })).rejects.toThrow(/stop authority changed/);
    expect(vm.stop).not.toHaveBeenCalled();
  });

  it("reports an absent source stopped and fails loudly when the source never parks", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn> };
    vm.describe.mockResolvedValue(null);
    await expect(native.park({ mode: "suspend" })).resolves.toEqual({ parked: "stopped" });
    const stuck = harness();
    const parked = await releasedReturn(stuck);
    await expect(parked.park({ mode: "suspend" })).rejects.toThrow(/park timed out/);
  });

  it.each(["claim", "binding"])("refuses to finish parking when the %s changes during the Compute read", async change => {
    const h = harness();
    const native = await releasedReturn(h);
    (h.deps.vm as { describe: ReturnType<typeof vi.fn> }).describe.mockImplementation(async () => {
      if (change === "claim") h.docs["glmOperations/return-1"].startedAt = 901;
      else { h.source.vm.instanceId = "replacement"; h.source.vmHome.lastCheckpoint.instanceId = "replacement"; }
      return { status: "SUSPENDED", instanceId: "vm-id" };
    });
    await expect(native.park({ mode: "suspend" })).rejects.toThrow(/authority changed/);
  });

  it("allows the current committed attempt to finish parking after cancellation", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    h.docs["glmOperations/return-1"].cancellationRequestedAt = 1003;
    (h.deps.vm as { describe: ReturnType<typeof vi.fn> }).describe.mockResolvedValue({ status: "SUSPENDED", instanceId: "vm-id" });
    await expect(native.park({ mode: "suspend" })).resolves.toEqual({ parked: "suspended" });
  });

  it.each(["owner", "assignment"])("refuses checkpoint writes after %s changes", async (change) => {
    const h = harness();
    const native = (await prepareNativeVmReturn(h.deps, input))!;
    if (change === "owner") h.root.ownerUid = "bob";
    else h.user.provisioning.openclaw.gatewayId = "elsewhere";
    await expect(native.requestCheckpoint()).rejects.toThrow(/changed/);
    expect(h.update).not.toHaveBeenCalled();
  });
});

function forwardHandoff() {
  return {
    migrationId: "mig-return-1:scheduler:1:claim:800", uid: input.uid, slug: input.slug,
    fromGatewayId: input.fromGatewayId, toGatewayId: input.toGatewayId,
    forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 4 },
  };
}

describe("native return forward recovery authority", () => {
  it("continues checkpointing after cancellation with the exact durable operation handoff from an earlier attempt", async () => {
    const h = harness();
    const native = (await prepareNativeVmReturn(h.deps, input))!;
    Object.assign(h.docs["glmOperations/return-1"], { cancellationRequestedAt: 950, schedulerHandoff: forwardHandoff() });
    await expect(native.requestCheckpoint()).resolves.toBeUndefined();
    expect(h.source.vmHome).toMatchObject({ returnOperationId: input.operationId, checkpointRequestedAt: 1000 });
  });

  it.each(["missing", "operation", "uid", "source", "target", "slug", "schema", "epoch", "claim"])("rejects cancelled checkpointing when the %s authority differs", async change => {
    const h = harness();
    const native = (await prepareNativeVmReturn(h.deps, input))!;
    const op = h.docs["glmOperations/return-1"];
    op.cancellationRequestedAt = 950;
    op.schedulerHandoff = forwardHandoff();
    const handoff = op.schedulerHandoff;
    if (change === "missing") delete handoff.forwardRecovery;
    if (change === "operation") handoff.migrationId = "mig-another:scheduler:1:claim:800";
    if (change === "uid") handoff.uid = "other";
    if (change === "source") handoff.fromGatewayId = "other";
    if (change === "target") handoff.toGatewayId = "other";
    if (change === "slug") handoff.slug = "other";
    if (change === "schema") handoff.forwardRecovery.schemaVersion = 2;
    if (change === "epoch") handoff.forwardRecovery.sourceEpoch = Number.NaN;
    if (change === "claim") op.startedAt = 901;
    await expect(native.requestCheckpoint()).rejects.toThrow(/authority changed/);
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each([["release", false], ["source-recovery", false], ["release", true], ["source-recovery", true]] as const)("retains the old writer hold when %s attempts to undo a forward migration (malformed=%s)", async (path, malformed) => {
    const h = harness();
    const native = (await prepareNativeVmReturn(h.deps, input))!;
    await native.requestCheckpoint();
    h.docs["glmOperations/return-1"].schedulerHandoff = forwardHandoff();
    if (malformed) h.docs["glmOperations/return-1"].schedulerHandoff.forwardRecovery.schemaVersion = 2;
    h.update.mockClear();
    const release = path === "release" ? native.release() : releaseNativeReturnSourceRecoveryHold(h.deps, input);
    await expect(release).rejects.toThrow(/must roll forward/);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.source.vmHome).toMatchObject({ returnOperationId: input.operationId, checkpointRequestedAt: 1000 });
  });
});
