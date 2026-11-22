import { afterEach, expect, it, vi } from "vitest";
import { initializeCheckpointEdge } from "@octogee/shared/server/hobby-checkpoint-gate";
import { installBrokeredUserIdentity } from "@octogee/core/identity/brokered-user-identity-provider";

const { startEdge } = vi.hoisted(() => ({ startEdge: vi.fn() }));
vi.mock("@octogee/shared/server/hobby-checkpoint-gate", () => ({ initializeCheckpointEdge: vi.fn() }));
vi.mock("@octogee/core/identity/brokered-user-identity-provider", () => ({ installBrokeredUserIdentity: vi.fn() }));
vi.mock("../index.js", () => { startEdge(); return {}; });
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); vi.resetModules(); });

it("initializes admitted checkpoint custody before installing identity or starting the edge", async () => {
  vi.stubEnv("GATEWAY_EDGE_MODE", "sidecar");
  vi.stubEnv("POD_UID", "source-pod");
  vi.mocked(initializeCheckpointEdge).mockImplementation(async () => {
    expect(installBrokeredUserIdentity).not.toHaveBeenCalled();
    expect(startEdge).not.toHaveBeenCalled();
    process.env.POD_UID = "restored-pod";
  });
  await import("../main.js");
  expect(initializeCheckpointEdge).toHaveBeenCalledWith(true);
  expect(installBrokeredUserIdentity).toHaveBeenCalledWith(expect.objectContaining({ POD_UID: "restored-pod" }));
  expect(startEdge).toHaveBeenCalledOnce();
});

it("keeps a refused restart away from identity and edge startup", async () => {
  vi.stubEnv("GATEWAY_EDGE_MODE", "sidecar");
  vi.mocked(initializeCheckpointEdge).mockRejectedValue(new Error("missing restored marker"));
  await expect(import("../main.js")).rejects.toThrow("missing restored marker");
  expect(installBrokeredUserIdentity).not.toHaveBeenCalled();
  expect(startEdge).not.toHaveBeenCalled();
});
