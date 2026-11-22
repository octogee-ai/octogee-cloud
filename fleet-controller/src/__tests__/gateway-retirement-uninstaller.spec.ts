import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { expect, it, vi } from "vitest";
import { gatewayRetirementUninstaller } from "../lib/gateway-retirement-uninstaller.js";

const gatewayId = "isolated-fixture";
const claim = { operationId: "retire-original", version: 4 };
const root = {
  gatewayId, createdAt: 1, createdBy: "test", updatedAt: 2, updatedBy: "test",
  desiredRelease: 1, latestRelease: 2, liveRelease: 1, desiredStatus: "retired",
  configSchemaVersion: 1, profile: null, gatewayClass: "isolated", imageProfile: "isolated", sizingTier: "s",
  gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null,
  builderAccess: null, ownerUid: "owner", builderSlug: "alice", modelBrokerLimits: null,
  retirementVersion: claim.version,
  retirementClaim: {
    ...claim, claimedAt: 2, phase: "claimed", liveRelease: 1, previousDesiredStatus: "running", liveRuntimeIdentity: null,
  },
};

function fixture() {
  const docs = new Map<string, Record<string, unknown>>([[`gateways/${gatewayId}`, root]]);
  const store = createDocumentFixtureStore(docs, { serializeTransactions: true });
  return { store, docs, remove: vi.fn(async () => {}), assertActiveClaim: vi.fn(async () => {}) };
}

it("refuses the first Helm uninstall when independent custody cannot be verified", async () => {
  const { store, remove, assertActiveClaim } = fixture();
  const verify = vi.fn(async () => { throw new Error("retained recovery archive generation changed"); });
  const uninstall = gatewayRetirementUninstaller(store, remove, { requiresWorker: () => true, verify });
  await expect(uninstall(gatewayId, { ...claim, assertActiveClaim })).rejects.toThrow("archive generation changed");
  expect(verify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ...claim, gateway: expect.objectContaining({ gatewayId }) }));
  expect(remove).not.toHaveBeenCalled();
});

it("rechecks the ordinary active claim after external custody verification and before deleting", async () => {
  const { store, docs, remove, assertActiveClaim } = fixture();
  const verify = vi.fn(async () => {
    docs.set(`gateways/${gatewayId}`, {
      ...root, retirementClaim: { ...root.retirementClaim, operationId: "new-worker" },
    });
  });
  const uninstall = gatewayRetirementUninstaller(store, remove, { requiresWorker: () => true, verify });
  await expect(uninstall(gatewayId, { ...claim, assertActiveClaim })).rejects.toThrow("claim does not match");
  expect(assertActiveClaim).toHaveBeenCalledTimes(2);
  expect(remove).not.toHaveBeenCalled();
});

it("uninstalls only after the product proof and both ordinary claim reads succeed", async () => {
  const { store, remove, assertActiveClaim } = fixture();
  const verify = vi.fn(async () => {});
  const uninstall = gatewayRetirementUninstaller(store, remove, { requiresWorker: () => true, verify });
  await expect(uninstall(gatewayId, claim)).rejects.toThrow("worker claim is unavailable");
  expect(remove).not.toHaveBeenCalled();
  await uninstall(gatewayId, { ...claim, assertActiveClaim });
  expect(verify).toHaveBeenCalledOnce();
  expect(assertActiveClaim).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenCalledExactlyOnceWith(gatewayId);
});
