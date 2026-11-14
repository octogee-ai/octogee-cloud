import { describe, expect, it, vi } from "vitest";
import { retiredSharedGatewayRuntimeAbsent } from "../lib/user-ops/retired-shared-gateway.js";
import {
  createUnmountFromGateway,
  type UnmountFromGatewayDeps,
} from "../lib/user-ops/unmount-gateway";

function connectionError(): TypeError {
  return new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
}

function mkDeps(overrides: Partial<UnmountFromGatewayDeps> = {}): UnmountFromGatewayDeps {
  return {
    resolveGatewayUnmountTarget: vi.fn(async (gatewayId: string) => ({
      gatewayId,
      revisionId: `${gatewayId}-r7`,
      profile: "standard" as const,
      runtime: "cluster" as const,
    })),
    isRuntimeAbsent: vi.fn(async () => false),
    isRetiredSharedGateway: vi.fn(async () => false),
    isGatewayAbsent: vi.fn(async () => false),
    unmountRpc: vi.fn(async () => undefined),
    wait: vi.fn(async () => undefined),
    now: vi.fn(() => 0),
    log: vi.fn(),
    ...overrides,
  };
}

describe("createUnmountFromGateway — durable runtime resolution", () => {
  it("skips a removed Shared gateway only after verified retirement", async () => {
    const deps = mkDeps({
      resolveGatewayUnmountTarget: vi.fn(async () => null),
      isRetiredSharedGateway: vi.fn(async () => true),
    });
    await expect(createUnmountFromGateway(deps)("shared-old", "alice"))
      .resolves.toBe("skipped-no-live-pod");
    expect(deps.isRetiredSharedGateway).toHaveBeenCalledWith("shared-old");
    expect(deps.unmountRpc).not.toHaveBeenCalled();
  });

  it("never uses retirement proof for a mismatched serving revision", async () => {
    const deps = mkDeps({
      resolveGatewayUnmountTarget: vi.fn<UnmountFromGatewayDeps["resolveGatewayUnmountTarget"]>(async () => ({ gatewayId: "foreign", revisionId: "foreign", profile: "standard", runtime: "cluster" })),
      isRetiredSharedGateway: vi.fn(async () => true),
    });
    await expect(createUnmountFromGateway(deps)("shared-old", "alice")).rejects.toThrow(/no validated serving revision/);
    expect(deps.isRetiredSharedGateway).not.toHaveBeenCalled();
  });

  it("skips a isolated gateway whose root, runtime, deployment and pods are all gone", async () => {
    const deps = mkDeps({
      resolveGatewayUnmountTarget: vi.fn(async () => null),
      isGatewayAbsent: vi.fn(async () => true),
    });
    await expect(createUnmountFromGateway(deps)("jefe-s-e30a3e14", "jefe"))
      .resolves.toBe("skipped-no-live-pod");
    expect(deps.isGatewayAbsent).toHaveBeenCalledWith("jefe-s-e30a3e14");
    expect(deps.unmountRpc).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("no root record, runtime record, deployment, pods or tenant references"));
  });

  it("never lets generic absence stand in for Shared retirement proof", async () => {
    const deps = mkDeps({
      resolveGatewayUnmountTarget: vi.fn(async () => null),
      isRetiredSharedGateway: vi.fn(async () => false),
      isGatewayAbsent: vi.fn(async () => true),
    });
    await expect(createUnmountFromGateway(deps)("shared-old", "alice")).rejects.toThrow(/no validated serving revision/);
    expect(deps.isGatewayAbsent).not.toHaveBeenCalled();
  });

  it("throws when the gateway has no validated serving revision", async () => {
    const deps = mkDeps({ resolveGatewayUnmountTarget: vi.fn(async () => null) });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("ghost-gw", "alice")).rejects.toThrow(
      /gateway ghost-gw has no validated serving revision/,
    );
    expect(deps.unmountRpc).not.toHaveBeenCalled();
  });
});

describe("createUnmountFromGateway — runtime presence", () => {
  it.each([0, null])("contacts a retained pod with availableReplicas=%s", async available => {
    const deps = mkDeps({
      isRuntimeAbsent: (gatewayId, revisionId) => retiredSharedGatewayRuntimeAbsent({
        readAvailableReplicas: async () => available,
        readGatewayPodDiagnostics: async () => ({ status: "not-ready", totalPods: 1, pods: [{ readyContainers: 1, totalContainers: 2 }] }),
      } as never, "octogee-test", gatewayId, revisionId),
    });
    await expect(createUnmountFromGateway(deps)("shared-old", "alice")).resolves.toBe("unmounted");
    expect(deps.unmountRpc).toHaveBeenCalledOnce();
  });

  it("requires verified deployment and pod absence before skipping", async () => {
    const deps = mkDeps({
      isRuntimeAbsent: vi.fn(async () => true),
    });
    await expect(createUnmountFromGateway(deps)("shared-old", "alice")).resolves.toBe("skipped-no-live-pod");
    expect(deps.isRuntimeAbsent).toHaveBeenCalledWith("shared-old", "shared-old-r7");
    expect(deps.unmountRpc).not.toHaveBeenCalled();
  });

  it("does not skip when runtime presence is unknown", async () => {
    const deps = mkDeps({
      isRuntimeAbsent: vi.fn(async () => { throw new Error("pod lookup unavailable"); }),
    });
    await expect(createUnmountFromGateway(deps)("shared-old", "alice")).rejects.toThrow("pod lookup unavailable");
    expect(deps.unmountRpc).not.toHaveBeenCalled();
  });
});

describe("createUnmountFromGateway — live pod unmount", () => {
  it("contacts a VM even when Kubernetes has no objects", async () => {
    const deps = mkDeps({
      resolveGatewayUnmountTarget: vi.fn<UnmountFromGatewayDeps["resolveGatewayUnmountTarget"]>(async () => ({ gatewayId: "alice-vm", revisionId: "alice-vm", profile: "isolated", runtime: "gce-vm" })),
      isRuntimeAbsent: vi.fn(async () => true),
    });
    await expect(createUnmountFromGateway(deps)("alice-vm", "alice")).resolves.toBe("unmounted");
    expect(deps.isRuntimeAbsent).not.toHaveBeenCalled();
    expect(deps.unmountRpc).toHaveBeenCalledOnce();
  });

  it("keeps an unreachable VM failure visible instead of claiming Kubernetes absence", async () => {
    const deps = mkDeps({
      resolveGatewayUnmountTarget: vi.fn<UnmountFromGatewayDeps["resolveGatewayUnmountTarget"]>(async () => ({ gatewayId: "alice-vm", revisionId: "alice-vm", profile: "isolated", runtime: "gce-vm" })),
      isRuntimeAbsent: vi.fn(async () => true),
      unmountRpc: vi.fn(async () => { throw connectionError(); }),
      retryDeadlineMs: 0,
    });
    await expect(createUnmountFromGateway(deps)("alice-vm", "alice")).rejects.toThrow("unmount unreachable");
    expect(deps.isRuntimeAbsent).not.toHaveBeenCalled();
  });

  it("calls the platform-signed unmount RPC for standard gateways", async () => {
    const deps = mkDeps();
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("default", "alice")).resolves.toBe("unmounted");
    expect(deps.unmountRpc).toHaveBeenCalledWith({
      gatewayId: "default",
      revisionId: "default-r7",
      slug: "alice",
    });
  });

  it("uses the same platform-signed unmount RPC for isolated gateways", async () => {
    const deps = mkDeps({
      resolveGatewayUnmountTarget: vi.fn(async () => ({
        gatewayId: "walter",
        revisionId: "walter-r7",
        profile: "isolated" as const,
        runtime: "cluster" as const,
      })),
    });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("walter", "theo")).resolves.toBe("unmounted");
    expect(deps.unmountRpc).toHaveBeenCalledWith({
      gatewayId: "walter",
      revisionId: "walter-r7",
      slug: "theo",
    });
  });
});

describe("createUnmountFromGateway — connection-error retry", () => {
  it("retries connection-level failures until the RPC succeeds", async () => {
    let calls = 0;
    const deps = mkDeps({
      unmountRpc: vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw connectionError();
      }),
      retryIntervalMs: 50,
      retryDeadlineMs: 1_000,
    });
    let clock = 0;
    deps.now = vi.fn(() => clock);
    deps.wait = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("default", "alice")).resolves.toBe("unmounted");
    expect(deps.unmountRpc).toHaveBeenCalledTimes(3);
    expect(deps.wait).toHaveBeenCalledTimes(2);
  });

  it("rechecks runtime absence between retries", async () => {
    const absentReads = [false, true];
    const deps = mkDeps({
      isRuntimeAbsent: vi.fn(async () => absentReads.shift() ?? true),
      unmountRpc: vi.fn(async () => {
        throw connectionError();
      }),
      retryIntervalMs: 50,
      retryDeadlineMs: 1_000,
    });
    let clock = 0;
    deps.now = vi.fn(() => clock);
    deps.wait = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("default", "alice")).resolves.toBe("skipped-no-live-pod");
    expect(deps.unmountRpc).toHaveBeenCalledTimes(1);
  });

  it("gives up loudly when the deadline elapses with the pod still unreachable", async () => {
    const deps = mkDeps({
      unmountRpc: vi.fn(async () => {
        throw connectionError();
      }),
      retryIntervalMs: 100,
      retryDeadlineMs: 250,
    });
    let clock = 0;
    deps.now = vi.fn(() => clock);
    deps.wait = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("default", "alice")).rejects.toThrow(
      /unmount unreachable after 3 attempts.*gatewayId=default revisionId=default-r7 slug=alice.*fetch failed \(ECONNREFUSED\)/,
    );
  });

  it("does not retry HTTP-level failures (the server was reached)", async () => {
    const deps = mkDeps({
      unmountRpc: vi.fn(async () => {
        throw new Error("unmount failed: 500 internal");
      }),
    });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("default", "alice")).rejects.toThrow(/unmount failed: 500/);
    expect(deps.unmountRpc).toHaveBeenCalledTimes(1);
    expect(deps.wait).not.toHaveBeenCalled();
  });

  it("does not retry TypeErrors that are not undici connection failures", async () => {
    const deps = mkDeps({
      unmountRpc: vi.fn(async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'x')");
      }),
    });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("default", "alice")).rejects.toThrow(/Cannot read properties/);
    expect(deps.unmountRpc).toHaveBeenCalledTimes(1);
    expect(deps.wait).not.toHaveBeenCalled();
  });

  it("does not call the unmount RPC when a isolated gateway has no live pod", async () => {
    const deps = mkDeps({
      resolveGatewayUnmountTarget: vi.fn(async () => ({
        gatewayId: "walter",
        revisionId: "walter-r7",
        profile: "isolated" as const,
        runtime: "cluster" as const,
      })),
      isRuntimeAbsent: vi.fn(async () => true),
    });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("walter", "theo")).resolves.toBe("skipped-no-live-pod");
    expect(deps.unmountRpc).not.toHaveBeenCalled();
  });
});
