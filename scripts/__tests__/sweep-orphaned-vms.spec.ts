import { describe, expect, it } from "vitest";
import { DuplicateRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import {
  classifyTerminatedVm,
  readVmReferences,
  parseSweepOrphanedVmsArgs,
  terminatedVmFromGcloud,
  type VmReferences,
  type TerminatedVm,
} from "../ops/sweep-orphaned-vms.js";
import { TEST_TARGET } from "./fixtures/deployment.js";

const vm: TerminatedVm = { name: "octogee-computer-prod-abc", zone: "us-central1-a", instanceId: "111", ownerUid: "UidA", lastStopTimestamp: "2026-09-10T02:56:00Z" };

function refs(overrides: Partial<VmReferences> = {}): VmReferences {
  return { parkedInstanceIds: new Set(), gatewayInstanceIds: new Set(), existingOwnerUids: new Set(), ...overrides };
}

describe("sweep-orphaned-vms", () => {
  it("is dry-run by default, needs an environment, and rejects stray arguments", () => {
    expect(parseSweepOrphanedVmsArgs(["--env=prod"])).toMatchObject({ environment: "prod", apply: false, computeProjectId: "octogee" });
    expect(parseSweepOrphanedVmsArgs(["--env=test", "--apply"])).toMatchObject({ environment: "test", apply: true, computeProjectId: TEST_TARGET.firebaseProjectId });
    expect(() => parseSweepOrphanedVmsArgs([])).toThrow(/--env/);
    expect(() => parseSweepOrphanedVmsArgs(["--env=prod", "--force"])).toThrow(/--force/);
  });

  it("keeps a VM that any parked record, gateway record, or live owner still claims", () => {
    expect(classifyTerminatedVm(vm, refs({ parkedInstanceIds: new Set(["111"]) }))).toEqual({ action: "keep", reason: "parked" });
    expect(classifyTerminatedVm(vm, refs({ gatewayInstanceIds: new Set(["111"]) }))).toEqual({ action: "keep", reason: "gateway" });
    expect(classifyTerminatedVm(vm, refs({ existingOwnerUids: new Set(["UidA"]) }))).toEqual({ action: "keep", reason: "owner-active" });
  });

  it("deletes only a VM whose owner is gone or was never stamped", () => {
    expect(classifyTerminatedVm(vm, refs({ existingOwnerUids: new Set(["UidB"]) }))).toEqual({ action: "delete", reason: "owner-gone" });
    expect(classifyTerminatedVm({ ...vm, ownerUid: null }, refs({ existingOwnerUids: new Set(["UidA"]) }))).toEqual({ action: "delete", reason: "no-owner" });
  });

  it("reads the owner from instance metadata and the zone from its URL", () => {
    expect(terminatedVmFromGcloud({
      name: "octogee-computer-test-x", id: "42", status: "TERMINATED", lastStopTimestamp: "2026-09-10T00:00:00Z",
      zone: "https://www.googleapis.com/compute/v1/projects/octogee/zones/us-central1-b",
      metadata: { items: [{ key: "gateway-id", value: "b-x" }, { key: "octogee-owner-uid", value: "UidA" }] },
    })).toEqual({ name: "octogee-computer-test-x", zone: "us-central1-b", instanceId: "42", ownerUid: "UidA", lastStopTimestamp: "2026-09-10T00:00:00Z" });
    expect(terminatedVmFromGcloud({ name: "octogee-computer-test-y", id: "43", zone: "zones/us-central1-a" })).toMatchObject({ ownerUid: null, lastStopTimestamp: null });
    expect(() => terminatedVmFromGcloud({ name: "octogee-computer-test-z" })).toThrow(/name\/id\/zone/);
  });
});

describe("sweep-orphaned-vms references", () => {
  function vmRuntime(gatewayId: string, instanceId: string): Record<string, unknown> {
    return {
      docKind: "runtime", gatewayId, release: 1, lifecycle: "serving", runtime: "gce-vm",
      vm: { instanceId, status: "TERMINATED" },
      heartbeat: { status: "ready", lastHeartbeatAt: 1, mountedCustomers: [] },
    };
  }

  const vms: TerminatedVm[] = [
    { ...vm, name: "parked", instanceId: "111", ownerUid: "UidGone" },
    { ...vm, name: "gateway", instanceId: "222", ownerUid: null },
    { ...vm, name: "owned", instanceId: "333", ownerUid: "UidA" },
    { ...vm, name: "orphan", instanceId: "444", ownerUid: "UidGone" },
  ];

  it("collects parked VMs, gateway VMs and live owners from platform records", async () => {
    const store = createDocumentFixtureStore(new Map<string, Record<string, unknown>>([
      ["users/UidP", { username: "parker", provisioning: { computer: { instanceId: "111" } } }],
      ["users/UidA", { username: "alice" }],
      ["glmGateways/b-vm", vmRuntime("b-vm", "222")],
    ]));

    const refs = await readVmReferences(store, vms);

    expect([...refs.parkedInstanceIds]).toEqual(["111"]);
    expect([...refs.gatewayInstanceIds]).toEqual(["222"]);
    expect([...refs.existingOwnerUids]).toEqual(["UidA"]);
    expect(vms.map((entry) => classifyTerminatedVm(entry, refs).action)).toEqual(["keep", "keep", "keep", "delete"]);
  });

  it("refuses to classify a VM two users claim", async () => {
    const store = createDocumentFixtureStore(new Map<string, Record<string, unknown>>([
      ["users/UidP", { username: "parker", provisioning: { computer: { instanceId: "111" } } }],
      ["users/UidQ", { username: "quinn", provisioning: { computer: { instanceId: "111" } } }],
    ]));

    await expect(readVmReferences(store, vms.slice(0, 1))).rejects.toBeInstanceOf(DuplicateRecordError);
  });
});
