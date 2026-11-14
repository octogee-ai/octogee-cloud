import { describe, expect, it, vi } from "vitest";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { pausedIsolatedRetirementSourceFencedOff } from "../lib/native-retirement-telemetry.js";
import type { GatewayVmDescription } from "../lib/compute-vm.js";

const input = { gatewayId: "builder-old", operationId: "retire-old", version: 2 };
function fixture() {
  const root: Record<string, unknown> = {
    gatewayId: input.gatewayId, gatewayClass: "isolated", ownerUid: "uid", desiredStatus: "retired",
    desiredRelease: 1, latestRelease: 1,
    retirementClaim: { operationId: input.operationId, version: input.version, phase: "claimed", previousDesiredStatus: "paused" },
  };
  let runtime: Record<string, unknown> | undefined = {
    docKind: "runtime", gatewayId: input.gatewayId, runtime: "gce-vm", release: 1, lifecycle: "serving",
    vm: { instanceName: "computer", instanceId: "instance-1", zone: "zone" },
    heartbeat: { mountedCustomers: ["builder"], status: "ready" },
  };
  let current: GatewayVmDescription | null = {
    name: "computer", instanceId: "instance-1", zone: "zone", gatewayId: input.gatewayId,
    status: "TERMINATED", labels: { "octogee-owner-uid": "uid" }, metadata: { "octogee-owner-uid": "uid" },
    machineType: null, internalIp: null, provisioningModel: null, lastStartedAt: null, serviceAccounts: [],
  };
  const records: Record<string, Record<string, unknown> | undefined> = {
    [`gateways/${input.gatewayId}`]: root,
    get [`glmGateways/${input.gatewayId}`]() { return runtime; },
  };
  const store = createDocumentFixtureStore(records);
  const describeVm = vi.fn(async () => current);
  let pods: "missing" | "present" = "missing";
  const podsAbsent = vi.fn(async () => pods === "missing");
  return {
    root,
    runtime: () => runtime!,
    current: () => current!,
    removeRuntime: () => { runtime = undefined; },
    removeVm: () => { current = null; },
    describeVm,
    podsAbsent,
    asPod: () => { runtime = { ...runtime!, runtime: "cluster" }; delete runtime.vm; },
    podRemains: () => { pods = "present"; },
    check: () => pausedIsolatedRetirementSourceFencedOff({ store, describe: describeVm, podsAbsent }, input),
  };
}

describe("paused isolated retirement telemetry", () => {
  it("accepts exact stopped Compute identity despite stale mounted telemetry", async () => {
    const h = fixture();
    expect(await h.check()).toBe(true);
    expect(h.describeVm).toHaveBeenCalledWith("computer", "zone");
  });

  it("accepts an absent Compute source with its recorded immutable identity", async () => {
    const h = fixture(); h.removeVm();
    expect(await h.check()).toBe(true);
  });

  it("does not authorize ignoring stale mounts without a native runtime identity", async () => {
    const h = fixture(); h.removeRuntime();
    expect(await h.check()).toBe(false);
    expect(h.describeVm).not.toHaveBeenCalled();
    h.root.retirementClaim = { ...h.root.retirementClaim as object, version: 3 };
    expect(await h.check()).toBe(false);
  });

  it("fails closed on a root stored under another gateway before Compute reads", async () => {
    const h = fixture(); h.root.gatewayId = "other";
    await expect(h.check()).rejects.toBeInstanceOf(MalformedRecordError);
    expect(h.describeVm).not.toHaveBeenCalled();
  });

  it.each([
    ["Shared class", "gatewayClass", "shared"],
    ["no owner", "ownerUid", null],
    ["reactivated desired state", "desiredStatus", "running"],
  ])("rejects %s before Compute reads", async (_name, field, value) => {
    const h = fixture(); h.root[field as string] = value;
    expect(await h.check()).toBe(false);
    expect(h.describeVm).not.toHaveBeenCalled();
  });

  it.each([
    ["different operation", "operationId", "other"],
    ["different version", "version", 3],
    ["unclaimed", "phase", "complete"],
    ["running claim", "previousDesiredStatus", "running"],
  ])("rejects %s retirement claim", async (_name, field, value) => {
    const h = fixture(); (h.root.retirementClaim as Record<string, unknown>)[field as string] = value;
    expect(await h.check()).toBe(false);
    expect(h.describeVm).not.toHaveBeenCalled();
  });

  it.each(["TERMINATED", "STOPPED", "SUSPENDED"])("accepts parked Compute status %s", async (status) => {
    const h = fixture(); h.current().status = status;
    expect(await h.check()).toBe(true);
  });

  it.each(["RUNNING", "STOPPING", "SUSPENDING"])("rejects Compute status %s", async (status) => {
    const h = fixture(); h.current().status = status;
    expect(await h.check()).toBe(false);
  });

  it.each([
    ["replacement instance", "instanceId", "instance-2"],
    ["rebound gateway", "gatewayId", "builder-new"],
    ["different zone", "zone", "other"],
    ["different name", "name", "other"],
    ["missing instance identity", "instanceId", null],
  ])("rejects %s in Compute", async (_name, field, value) => {
    const h = fixture(); (h.current() as unknown as Record<string, unknown>)[field as string] = value;
    expect(await h.check()).toBe(false);
  });

  it("rejects a Compute source owned by someone else", async () => {
    const h = fixture(); h.current().labels["octogee-owner-uid"] = "other";
    expect(await h.check()).toBe(false);
  });

  it("matches the normalized Compute owner label for a case-sensitive Firebase UID", async () => {
    const h = fixture(); h.root.ownerUid = "JsDdRUid"; h.current().labels["octogee-owner-uid"] = "jsddruid";
    h.current().metadata["octogee-owner-uid"] = "JsDdRUid";
    expect(await h.check()).toBe(true);
  });

  it("requires the exact case-sensitive Compute owner metadata", async () => {
    const h = fixture(); h.root.ownerUid = "Uid";
    expect(await h.check()).toBe(false);
  });

  it("does not retire a retained VM already running for the next allocation", async () => {
    const h = fixture(); h.current().status = "RUNNING"; h.current().gatewayId = "builder-new";
    expect(await h.check()).toBe(false);
  });

  it("rejects an unstamped runtime before Compute or pod reads", async () => {
    const h = fixture(); h.runtime().runtime = undefined;
    expect(await h.check()).toBe(false);
    expect(h.describeVm).not.toHaveBeenCalled();
    expect(h.podsAbsent).not.toHaveBeenCalled();
  });

  it("accepts a parked pod gateway with no pod left despite stale mounted telemetry", async () => {
    const h = fixture(); h.asPod();
    expect(await h.check()).toBe(true);
    expect(h.podsAbsent).toHaveBeenCalledWith(input.gatewayId);
    expect(h.describeVm).not.toHaveBeenCalled();
  });

  it("rejects a parked pod gateway while one of its pods remains", async () => {
    const h = fixture(); h.asPod(); h.podRemains();
    expect(await h.check()).toBe(false);
  });

  it("rejects a pod gateway whose retirement claim was not taken while paused", async () => {
    const h = fixture(); h.asPod();
    (h.root.retirementClaim as Record<string, unknown>).previousDesiredStatus = "running";
    expect(await h.check()).toBe(false);
    expect(h.podsAbsent).not.toHaveBeenCalled();
  });

  it.each(["instanceId", "instanceName", "zone"])("rejects missing recorded %s even when Compute is absent", async (field) => {
    const h = fixture(); delete (h.runtime().vm as Record<string, unknown>)[field]; h.removeVm();
    expect(await h.check()).toBe(false);
    expect(h.describeVm).not.toHaveBeenCalled();
  });

  it("propagates Compute failures", async () => {
    const h = fixture(); h.describeVm.mockRejectedValueOnce(new Error("Compute denied"));
    await expect(h.check()).rejects.toThrow("Compute denied");
  });
});
