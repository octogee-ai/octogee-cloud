import { describe, expect, it, vi } from "vitest";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import { reconcileHeldNativeSource } from "./held-native-source-reconcile.js";
import { snapshotConfigFingerprint } from "./broker-snapshot-fingerprint.js";

const slug = "alice";
const gatewayId = "alice-s";
const uid = "owner";
const migrationId = "mig-op1";
const snapshot: FleetBrokerUserSnapshot = {
  uid, slug, gatewayId, contextTemplateKey: "default", planInputs: {}, status: "complete",
  agentIds: ["octogee-alice-coach"], runtimeMutationFenced: true, repoUrl: "",
  mattermostUserId: "mm", customerMmUserId: "mm", channels: [], projects: [],
  ownerName: slug, email: "", displayName: slug, lastName: "", photoURL: "",
  persona: null, coachToken: "test-fixture", coachMmUserId: "fixture",
};
const steps = ["config-patch", "byot-reassert", "context-files-reassert", "verify-channel-ready"];
function fixture() {
  const calls: string[] = [];
  const note = (name: string) => { calls.push(name); };
  const guard = vi.fn(async () => note("guard"));
  const client = {
    restore: vi.fn(async () => { note("restore"); return { migrationId, slug, restored: true, steps }; }),
    quiesce: vi.fn(async () => { note("quiesce"); return { migrationId, slug, drained: true, runningCount: 0 }; }),
    flush: vi.fn(async () => { note("flush"); return { migrationId, slug, ok: true, durationMs: 1, steps: [{ name: "customer-files", status: "done" as const, durationMs: 1 }] }; }),
    exportManifest: vi.fn(async () => {
      note("export");
      const agentId = snapshot.agentIds[0], accountId = "alice-coach";
      return { migrationId, slug, manifest: { version: 2, slug, agentId, accountId, agent: { id: agentId },
        mattermostAccount: { botToken: "test-fixture" }, bindings: [{ agentId, match: { channel: "mattermost", accountId } }],
        projectAgents: [], appliedFingerprint: snapshotConfigFingerprint(snapshot) } };
    }),
  };
  const readSnapshot = vi.fn(async () => { note("snapshot"); return snapshot; });
  const run = () => reconcileHeldNativeSource({ uid, slug, gatewayId, migrationId }, { assertCurrent: guard, readSnapshot, client, now: Date.now });
  return { calls, client, readSnapshot, guard, run };
}
describe("reconciling the original held Native return source", () => {
  it("returns a guest checkpoint only after a complete apply, a fresh drain, a flush and a matching export", async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ appliedFingerprint: snapshotConfigFingerprint(snapshot), activationManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(f.calls.filter(name => name !== "guard")).toEqual(["snapshot", "restore", "quiesce", "flush", "export", "snapshot"]);
    for (let i = 1; i < f.calls.length; ++i) if (f.calls[i] !== "guard") expect(f.calls[i - 1]).toBe("guard");
    expect(f.calls.at(-1)).toBe("guard");
  });
  it("drains the held source again when the restore acknowledgement is lost", async () => {
    const f = fixture(); f.client.restore.mockRejectedValue(new Error("lost response"));
    await expect(f.run()).rejects.toThrow(); expect(f.client.quiesce).toHaveBeenCalledOnce();
    expect(f.client.flush).not.toHaveBeenCalled();
  });
  it("refuses a source snapshot from a different assignment before applying", async () => {
    const f = fixture(); f.readSnapshot.mockResolvedValue({ ...snapshot, gatewayId: "other" });
    await expect(f.run()).rejects.toThrow(); expect(f.client.restore).not.toHaveBeenCalled();
  });
  it("rejects a changed broker snapshot after export", async () => {
    const f = fixture(); f.readSnapshot.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({ ...snapshot, timeZone: "America/New_York" });
    await expect(f.run()).rejects.toThrow();
  });
  it("does not flush a source that failed to drain", async () => {
    const f = fixture(); f.client.quiesce.mockResolvedValue({ migrationId, slug, drained: false, runningCount: 1 });
    await expect(f.run()).rejects.toThrow(); expect(f.client.flush).not.toHaveBeenCalled();
  });
  it("rejects an export with an incomplete roster or mismatched applied fingerprint", async () => {
    for (const changed of [{ appliedFingerprint: "x" }, { agentId: "other" }, { mattermostAccount: { botToken: "different" } }]) {
      const f = fixture(), real = await f.client.exportManifest();
      f.client.exportManifest.mockResolvedValue({ ...real, manifest: { ...real.manifest, ...changed } });
      await expect(f.run()).rejects.toThrow();
    }
  });
});
