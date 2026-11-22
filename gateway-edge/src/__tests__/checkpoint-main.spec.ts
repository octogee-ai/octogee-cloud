import { afterEach, expect, it, vi } from "vitest";
import { checkpointGatewayCredentials, waitForCheckpointClaim } from "@octogee/shared/server/hobby-checkpoint-gate";
import { installBrokeredUserIdentity } from "@octogee/core/identity/brokered-user-identity-provider";
vi.mock("@octogee/shared/server/hobby-checkpoint-gate", () => ({
  checkpointGatewayCredentials: vi.fn(), waitForCheckpointClaim: vi.fn(),
}));
vi.mock("@octogee/core/identity/brokered-user-identity-provider", () => ({ installBrokeredUserIdentity: vi.fn() }));
vi.mock("../index.js", () => ({}));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); vi.resetModules(); });

it("installs the edge identity with the admitted Pod and its normalized credentials", async () => {
  vi.stubEnv("OCTOGEE_CHECKPOINT_SLOT_ID", "slot-a");
  vi.stubEnv("GATEWAY_EDGE_MODE", "sidecar");
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
  vi.stubEnv("OPENCLAW_AGENT_STORE_DSN", "");
  vi.stubEnv("POD_UID", "source-pod");
  vi.mocked(waitForCheckpointClaim).mockResolvedValue({
    version: 1, slotId: "slot-a", gatewayId: "slot-a", snapshotName: "snap-a",
    podUid: "restored-pod", uid: "owner-a", slug: "alice", assignmentEpoch: 0,
  });
  vi.mocked(checkpointGatewayCredentials).mockResolvedValue({ token: "normalized", agentStoreDsn: "postgres://test/db" });
  await import("../main.js");
  expect(waitForCheckpointClaim).toHaveBeenCalledWith("edge");
  expect(installBrokeredUserIdentity).toHaveBeenCalledWith(expect.objectContaining({
    POD_UID: "restored-pod", OPENCLAW_GATEWAY_TOKEN: "normalized", OPENCLAW_AGENT_STORE_DSN: "postgres://test/db",
  }));
});

it("keeps a refused restart away from credentials and the live edge identity", async () => {
  vi.stubEnv("OCTOGEE_CHECKPOINT_SLOT_ID", "slot-a");
  vi.stubEnv("GATEWAY_EDGE_MODE", "sidecar");
  vi.mocked(waitForCheckpointClaim).mockRejectedValue(new Error("missing restored marker"));
  await expect(import("../main.js")).rejects.toThrow("missing restored marker");
  expect(checkpointGatewayCredentials).not.toHaveBeenCalled();
  expect(installBrokeredUserIdentity).not.toHaveBeenCalled();
});
