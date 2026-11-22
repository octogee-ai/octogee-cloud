import { afterEach, expect, it, vi } from "vitest";
import { readMountedCheckpointClaim } from "@octogee/shared/server/hobby-checkpoint-gate";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";
import { main } from "../entrypoints/user-identity.js";
vi.mock("@octogee/shared/server/hobby-checkpoint-gate", () => ({ readMountedCheckpointClaim: vi.fn() }));
vi.mock("../lib/fleet-broker-client.js", async original => ({
  ...await original<typeof import("../lib/fleet-broker-client.js")>(), createFleetBrokerClient: vi.fn(),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
it.each([null, {
  version: 1, slotId: "gw-alice", gatewayId: "gw-alice", snapshotName: "snap-1",
  podUid: "other-pod", slug: "alice", uid: "alice-uid", assignmentEpoch: 0,
}] as const)("rejects absent or foreign Pod claims before the broker supplies a user identity", async receipt => {
  vi.stubEnv("GATEWAY_ID", "gw-alice");
  vi.stubEnv("OCTOGEE_CHECKPOINT_SLOT_ID", "gw-alice");
  vi.stubEnv("POD_UID", "current-pod");
  vi.mocked(readMountedCheckpointClaim).mockResolvedValue(receipt);
  await expect(main()).rejects.toThrow("Expected the restored pod's exact gateway checkpoint claim");
  expect(createFleetBrokerClient).not.toHaveBeenCalled();
});
