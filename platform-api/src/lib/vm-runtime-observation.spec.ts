import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { expect, it } from "vitest";
import { VM_DISK_OBSERVATION_REFRESH_MS, recordVmDiskObservation, recordVmHomeCheckpoint } from "./vm-runtime-observation.js";

const RUNTIME_PATH = "glmGateways/b-x";

function fixture(exists = true) {
  const docs: Record<string, Record<string, unknown>> = exists
    ? { [RUNTIME_PATH]: { docKind: "runtime", gatewayId: "b-x", release: 1, lifecycle: "running", runtime: "gce-vm", vmHome: {} } }
    : {};
  return { docs, store: createDocumentFixtureStore(docs), runtime: () => docs[RUNTIME_PATH], home: () => docs[RUNTIME_PATH]?.vmHome };
}
const home = (name: string, requestedAt: number | null) => ({ checkpointAcknowledgedAt: requestedAt, lastCheckpoint: { name, size: 123, sha256: "a".repeat(64), completedAt: 2000, instanceId: "4242" } });

it("keeps the newer checkpoint when an older commit reaches the runtime mirror late", async () => {
  const h = fixture();
  const newer = home("20260905T101501Z.tar.gz", 1000);
  await recordVmHomeCheckpoint(h.store, "b-x", newer);
  const accepted = h.runtime();
  await recordVmHomeCheckpoint(h.store, "b-x", home("20260905T101500Z.tar.gz", null));
  expect(h.home()).toEqual(newer);
  expect(h.runtime()).toBe(accepted);
});

it("does not erase an acknowledgment on an identical-checkpoint retry or recreate a deleted runtime", async () => {
  const h = fixture();
  const accepted = home("20260905T101501Z.tar.gz", 1000);
  await recordVmHomeCheckpoint(h.store, "b-x", accepted);
  await recordVmHomeCheckpoint(h.store, "b-x", home(accepted.lastCheckpoint.name, null));
  expect(h.home()).toEqual(accepted);
  const deleted = fixture(false);
  await recordVmHomeCheckpoint(deleted.store, "b-x", accepted);
  expect(deleted.docs).toEqual({});
});

it("writes a disk observation when the free-percent bucket, instance, or refresh window moves, and skips the rest", async () => {
  const h = fixture();
  const sample = (freeBytes: number, observedAt: number, instanceId = "4242") => ({ sizeBytes: 1_000, freeBytes, observedAt, instanceId });
  const recorded = async (previous: unknown, next: ReturnType<typeof sample>) => {
    const before = h.runtime();
    const wrote = await recordVmDiskObservation(h.store, "b-x", previous, next);
    if (!wrote) expect(h.runtime()).toBe(before);
    return { wrote, vmDisk: h.runtime()?.vmDisk };
  };

  expect(await recorded(undefined, sample(500, 1_000))).toEqual({ wrote: true, vmDisk: sample(500, 1_000) });
  expect(await recorded(sample(500, 1_000), sample(509, 1_000 + 30_000))).toEqual({ wrote: false, vmDisk: sample(500, 1_000) });
  expect(await recorded(sample(500, 1_000), sample(499, 1_000 + 30_000))).toEqual({ wrote: true, vmDisk: sample(499, 31_000) });
  expect(await recorded(sample(500, 1_000), sample(500, 1_000 + VM_DISK_OBSERVATION_REFRESH_MS))).toEqual({ wrote: true, vmDisk: sample(500, 1_000 + VM_DISK_OBSERVATION_REFRESH_MS) });
  expect(await recorded(sample(500, 1_000), sample(500, 1_000 + 30_000, "9999"))).toEqual({ wrote: true, vmDisk: sample(500, 31_000, "9999") });
  expect(await recorded({ sizeBytes: "1000" }, sample(500, 1_000 + 30_000))).toEqual({ wrote: true, vmDisk: sample(500, 31_000) });
});

it("does not create a runtime record for a disk observation on a gateway without one", async () => {
  const h = fixture(false);
  await expect(recordVmDiskObservation(h.store, "b-x", undefined, { sizeBytes: 1_000, freeBytes: 500, observedAt: 1_000, instanceId: "4242" }))
    .rejects.toMatchObject({ name: "MissingRecordError" });
  expect(h.docs).toEqual({});
});
