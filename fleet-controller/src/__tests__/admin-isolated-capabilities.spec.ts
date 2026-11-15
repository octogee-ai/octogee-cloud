import { describe, expect, it, vi } from "vitest";
import { adminIsolatedCapabilities } from "../admin-isolated-capabilities.js";

describe("Admin API isolated gateway capabilities", () => {
  it("are absent, so the isolated verbs stay unmounted, without a pod diagnostics reader", () => {
    expect(adminIsolatedCapabilities({ namespace: "octogee-test", log: vi.fn() })).toBeUndefined();
  });

  it("create a missing gateway auth secret in the controller's namespace and leave an existing one", async () => {
    const runKubectl = vi.fn(async (args: string[]) => args[0] === "get"
      ? { code: 1, stdout: "", stderr: 'Error from server (NotFound): secrets "gateway-auth-token-alice-xs-1" not found' }
      : { code: 0, stdout: "", stderr: "" });
    const capabilities = adminIsolatedCapabilities({
      namespace: "octogee-test",
      log: vi.fn(),
      readGatewayPodDiagnostics: vi.fn(),
      runKubectl,
    })!;

    await capabilities.ensureAuthSecret({ namespace: capabilities.namespace, gatewayId: "alice-xs-1" });

    expect(runKubectl.mock.calls.map(([args]) => args.slice(0, 3))).toEqual([
      ["get", "secret", "gateway-auth-token-alice-xs-1"],
      ["create", "secret", "generic"],
    ]);
    expect(runKubectl.mock.calls[1]![0]).toEqual(expect.arrayContaining(["-n", "octogee-test"]));

    runKubectl.mockClear();
    runKubectl.mockResolvedValue({ code: 0, stdout: "secret/gateway-auth-token-alice-xs-1", stderr: "" });
    await capabilities.ensureAuthSecret({ namespace: capabilities.namespace, gatewayId: "alice-xs-1" });
    expect(runKubectl).toHaveBeenCalledTimes(1);
  });

  it("surface a failed secret read instead of creating over it", async () => {
    const runKubectl = vi.fn(async () => ({ code: 1, stdout: "", stderr: "Unable to connect to the server" }));
    const capabilities = adminIsolatedCapabilities({ namespace: "octogee-test", log: vi.fn(), readGatewayPodDiagnostics: vi.fn(), runKubectl })!;

    await expect(capabilities.ensureAuthSecret({ namespace: "octogee-test", gatewayId: "alice-xs-1" })).rejects.toThrow("Unable to connect");
    expect(runKubectl).toHaveBeenCalledTimes(1);
  });
});
