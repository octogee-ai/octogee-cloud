import { afterEach, expect, it, vi } from "vitest";
import { checkpointGatewayCredentials, waitForCheckpointClaim } from "@octogee/shared/server/hobby-checkpoint-gate";

vi.mock("@octogee/shared/server/hobby-checkpoint-gate", () => ({
  checkpointGatewayCredentials: vi.fn(), waitForCheckpointClaim: vi.fn(),
}));

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.resetModules(); });

it("starts the desktop in the admitted Pod with the same normalized credentials the edge uses", async () => {
  vi.mocked(waitForCheckpointClaim).mockResolvedValue({
    version: 1, slotId: "slot-a", gatewayId: "slot-a", snapshotName: "snap-a",
    podUid: "restored-pod", uid: "owner-a", slug: "alice", assignmentEpoch: 0,
  });
  vi.mocked(checkpointGatewayCredentials).mockResolvedValue({ token: "normalized", agentStoreDsn: "postgres://test/db" });
  const launch = vi.spyOn(process, "execve").mockImplementation(() => { throw new Error("desktop exec"); });
  const script = "../entrypoints/hobby-checkpoint-gate.mjs";
  await expect(import(script)).rejects.toThrow("desktop exec");
  expect(waitForCheckpointClaim).toHaveBeenCalledWith("gateway");
  expect(launch).toHaveBeenCalledWith("/usr/local/bin/octogee-hobby-desktop", ["/usr/local/bin/octogee-hobby-desktop"],
    expect.objectContaining({ POD_UID: "restored-pod", OPENCLAW_GATEWAY_TOKEN: "normalized", OPENCLAW_AGENT_STORE_DSN: "postgres://test/db" }));
});

it.each(["none", "x11"])("applies the verified live owner grant to headless startup (desktop=%s)", async (desktop) => {
  vi.stubEnv("GATEWAY_COMPUTER_DESKTOP", desktop);
  vi.stubEnv("HOME", "/home/node");
  vi.mocked(waitForCheckpointClaim).mockResolvedValue({
    version: 2, mode: "live", namespace: "octogee-test", slotId: "slot-a", gatewayId: "slot-a",
    podUid: "original-pod", uid: "owner-a", slug: "alice", assignmentEpoch: 0,
  });
  vi.mocked(checkpointGatewayCredentials).mockResolvedValue({ token: "normalized", agentStoreDsn: "postgres://test/db" });
  const launch = vi.spyOn(process, "execve").mockImplementation(() => { throw new Error("headless exec"); });
  const script = "../entrypoints/hobby-checkpoint-gate.mjs";
  if (desktop === "none") {
    await expect(import(script)).rejects.toThrow("headless exec");
    expect(launch).toHaveBeenCalledWith("/usr/local/bin/entrypoint.sh", ["/usr/local/bin/entrypoint.sh"],
      expect.objectContaining({ HOME: "/home/node", GATEWAY_COMPUTER_DESKTOP: "none", POD_UID: "original-pod",
        OPENCLAW_GATEWAY_TOKEN: "normalized", OPENCLAW_AGENT_STORE_DSN: "postgres://test/db" }));
  } else {
    await expect(import(script)).rejects.toThrow("live standby must be headless");
    expect(launch).not.toHaveBeenCalled();
    expect(checkpointGatewayCredentials).not.toHaveBeenCalled();
  }
});
