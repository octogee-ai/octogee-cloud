import { describe, expect, it, vi } from "vitest";
import { HomeComputeUnavailableError, type HomeEffect } from "@octogee/core/isolated-gateway-lifecycle";
import { adminIsolatedCapabilities, computeUnavailableCode, type AdminUserHome, type HomeServiceJournal } from "../admin-isolated-capabilities.js";

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

describe("Admin API home capabilities", () => {
  function userHome(advance: () => Promise<unknown>) {
    const journals: string[] = [];
    const services = vi.fn((journal: HomeServiceJournal) => {
      journals.push("built");
      return {
        provider: {
          nativeZone: vi.fn(async () => null),
          inventory: vi.fn(async () => null),
          verifyStopped: vi.fn(async () => undefined),
          adopt: vi.fn(() => journal("attach-verified-builder-home", "uid-alice", async () => true, "zones/us-central1-a/instances/alice-vm projects/p/zones/us-central1-a/disks/new-home")),
          removeStoppedHome: vi.fn(async () => true),
          readDisk: vi.fn(),
          remainingOwnerHomes: vi.fn(),
        },
        copy: {
          advance: vi.fn(() => journal("start-builder-home-copy", "uid-alice", advance, "https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances")),
          release: vi.fn(async () => true),
          abort: vi.fn(async () => true),
          sweep: vi.fn(),
        },
      };
    });
    const home: AdminUserHome = { environment: "test", subnetwork: "subnet", nativeZones: ["us-central1-a"], services: services as unknown as AdminUserHome["services"] };
    return { home, services, journals };
  }

  const input = { operationId: "home-copy-test-1", ownerUid: "uid-alice", source: {} as never, sourceLayout: "portable" as const, targetZone: "us-central1-a", desiredGiB: 10, subnetwork: "subnet" };

  it("are absent, so the prepare verb stays unmounted, without the controller's user home services", () => {
    expect(adminIsolatedCapabilities({ namespace: "octogee-test", log: vi.fn(), readGatewayPodDiagnostics: vi.fn() })!.home).toBeUndefined();
  });

  it("record each Compute Engine effect with the resource it touched, instead of journaling it separately", async () => {
    const { home } = userHome(async () => ({ progress: { status: "pending" } }));
    const factory = adminIsolatedCapabilities({ namespace: "octogee-test", log: vi.fn(), readGatewayPodDiagnostics: vi.fn(), userHome: home })!.home!;
    const effects: HomeEffect[] = [];
    const capabilities = factory((effect) => effects.push(effect));

    await capabilities.copy.advance(input);
    await capabilities.adopt({ uid: "uid-alice", target: {} as never });

    expect(effects).toEqual([
      { name: "start-builder-home-copy", resource: "https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances" },
      { name: "attach-verified-builder-home", resource: "zones/us-central1-a/instances/alice-vm projects/p/zones/us-central1-a/disks/new-home" },
    ]);
  });

  it.each([
    ["a 503 from the Compute Engine client", Object.assign(new Error("Service Unavailable"), { response: { status: 503 } }), "http-503"],
    ["a 429", Object.assign(new Error("Too Many Requests"), { response: { status: 429 } }), "http-429"],
    ["a reset connection", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), "econnreset"],
    ["a status the copy client reports", new Error("start-builder-home-copy: HTTP 502"), "http-502"],
  ])("surface %s as Compute Engine unavailable, so the call answers in-progress", async (_name, error, code) => {
    const { home } = userHome(async () => { throw error; });
    const capabilities = adminIsolatedCapabilities({ namespace: "octogee-test", log: vi.fn(), readGatewayPodDiagnostics: vi.fn(), userHome: home })!.home!(() => undefined);

    const failure = await capabilities.copy.advance(input).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(HomeComputeUnavailableError);
    expect(failure).toMatchObject({ code });
  });

  it.each([
    ["a 403", Object.assign(new Error("Forbidden"), { response: { status: 403 } })],
    ["an identity mismatch", new Error("home copy target identity/capacity differs")],
  ])("let %s through unchanged, so the call answers 500", async (_name, error) => {
    expect(computeUnavailableCode(error)).toBeNull();
    const { home } = userHome(async () => { throw error; });
    const capabilities = adminIsolatedCapabilities({ namespace: "octogee-test", log: vi.fn(), readGatewayPodDiagnostics: vi.fn(), userHome: home })!.home!(() => undefined);

    await expect(capabilities.copy.advance(input)).rejects.toBe(error);
  });
});
