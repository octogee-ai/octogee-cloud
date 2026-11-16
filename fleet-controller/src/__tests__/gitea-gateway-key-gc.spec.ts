import { describe, expect, it, vi } from "vitest";
import { createGitKeySweepState, createGiteaGitHost } from "@octogee/core/git-host";
import { gatewayKeyOwnerId, gatewayKeyTitle } from "@octogee/core/gitea-naming";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { readFleetLiveKeyHolders, readLiveGatewayKeyHolders } from "../gitea-gateway-key-gc.js";
import type { GatewayPodDiagnostics } from "../lib/kube-ops.js";

function diagnostics(podNames: string[], status: GatewayPodDiagnostics["status"] = "ready"): GatewayPodDiagnostics {
  return {
    status,
    totalPods: podNames.length,
    readyPods: podNames.length,
    totalRestarts: 0,
    spotPods: 0,
    onDemandPods: 0,
    unknownCapacityPods: podNames.length,
    pods: podNames.map((name) => ({
      name,
      gatewayId: null,
      deleting: false,
      gatewayContainerStartedAt: null,
      uid: null,
      replicaSetUid: null,
      phase: "Running",
      readyContainers: 1,
      totalContainers: 1,
      restarts: 0,
      reason: null,
      nodeName: null,
      instanceId: null,
      nodePool: null,
      capacityType: null,
      ageMs: null,
    })),
  };
}

function root(gatewayId: string) {
  return { gatewayId };
}

function runtime(gatewayId: string, vm: { instanceId: string } | null = null) {
  return { gatewayId, vm } as never;
}

describe("readLiveGatewayKeyHolders", () => {
  it("names every existing gateway pod and every recorded VM VM as a live key owner", async () => {
    const readBatch = vi.fn(async (gatewayIds: readonly string[]) =>
      Object.fromEntries(gatewayIds.map((id) => [
        id,
        id === "shared-0"
          ? diagnostics(["octogee-gateway-shared-0-a-1", "octogee-gateway-shared-0-b-2"])
          : diagnostics([], "missing"),
      ])));

    const { owners } = await readLiveGatewayKeyHolders({
      gateways: [root("shared-0"), root("builder-jack")],
      fleetRegistry: [
        runtime("shared-0"),
        runtime("builder-jack", { instanceId: "123456789" }),
      ],
      readGatewayPodDiagnosticsBatch: readBatch,
    });

    expect(readBatch).toHaveBeenCalledWith(["builder-jack", "shared-0"]);
    expect([...owners].sort()).toEqual([
      "builder-jack",
      "builder-jack/octogee-gateway-builder-jack-vm-123456789",
      "shared-0",
      "shared-0/octogee-gateway-shared-0-a-1",
      "shared-0/octogee-gateway-shared-0-b-2",
    ]);
  });

  it("keeps every known gateway's own id live, including a gateway with no pod, because the provisioning service holds keys under it", async () => {
    const { owners } = await readLiveGatewayKeyHolders({
      gateways: [root("builder-paused")],
      fleetRegistry: [],
      readGatewayPodDiagnosticsBatch: async (gatewayIds) =>
        Object.fromEntries(gatewayIds.map((id) => [id, diagnostics([], "missing")])),
    });

    expect([...owners]).toEqual(["builder-paused"]);
  });

  it("fails closed when a direct read meets a revision runtime document named for another gateway", async () => {
    const store = createDocumentFixtureStore({
      "gateways/shared-0": { gatewayId: "shared-0", desiredRelease: 1, latestRelease: 1, desiredStatus: "running" },
      "glmGateways/shared-0-r3": { docKind: "runtime", gatewayId: "shared-0", release: 1, lifecycle: "serving" },
    });
    const readBatch = vi.fn(async () => ({}));

    await expect(readFleetLiveKeyHolders({
      informer: { gateways: () => null, fleetRegistry: () => null },
      store,
      readGatewayPodDiagnosticsBatch: readBatch,
    })).rejects.toBeInstanceOf(MalformedRecordError);
    expect(readBatch).not.toHaveBeenCalled();
  });

  it("reads key holders from the fresh mirrors without a direct read", async () => {
    const store = createDocumentFixtureStore({});
    const list = vi.spyOn(store.fleetRegistry, "list");
    const { owners } = await readFleetLiveKeyHolders({
      informer: {
        gateways: () => [root("builder-jack")] as never,
        fleetRegistry: () => [runtime("builder-jack", { instanceId: "123456789" })],
      },
      store,
      readGatewayPodDiagnosticsBatch: async (gatewayIds) =>
        Object.fromEntries(gatewayIds.map((id) => [id, diagnostics([], "missing")])),
    });

    expect([...owners].sort()).toEqual(["builder-jack", "builder-jack/octogee-gateway-builder-jack-vm-123456789"]);
    expect(list).not.toHaveBeenCalled();
  });

  it("fails closed when any gateway's pods cannot be observed", async () => {
    await expect(readLiveGatewayKeyHolders({
      gateways: [root("shared-0")],
      fleetRegistry: [],
      readGatewayPodDiagnosticsBatch: async () => ({
        "shared-0": { ...diagnostics([], "unknown"), error: "pods not found" },
      }),
    })).rejects.toThrow(/shared-0.*pods not found/);
  });
});

describe("the key sweep and the provisioning service's adopted keys", () => {
  const GRACE_MS = 10 * 60_000;
  const API = "http://gitea.test/api/v1";

  interface StoredKey {
    id: number;
    title: string;
    key: string;
    created_at: string;
  }

  function fakeGitea(clock: () => number, keys: StoredKey[]) {
    let nextId = 100;
    const page = (url: URL) => Number(url.searchParams.get("page") ?? "1");
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const path = url.pathname.slice(new URL(API).pathname.length);
      if (method === "POST" && path === "/admin/users") return Response.json({ message: "user already exists" }, { status: 422 });
      if (method === "GET" && path === "/admin/users") return Response.json(page(url) === 1 ? [{ login: "ws-lin" }] : []);
      if (method === "GET" && path === "/users/ws-lin/keys") return Response.json(page(url) === 1 ? keys : []);
      if (method === "DELETE" && path.startsWith("/admin/users/ws-lin/keys/")) {
        const id = Number(path.split("/").at(-1));
        keys.splice(keys.findIndex((key) => key.id === id), 1);
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && path === "/admin/users/ws-lin/keys") {
        const body = JSON.parse(String(init?.body)) as { title: string; key: string };
        if (keys.some((key) => key.key.split(" ")[1] === body.key.split(" ")[1])) {
          return Response.json({ message: "Key content has been used as non-deploy key" }, { status: 422 });
        }
        keys.push({ id: nextId++, ...body, created_at: new Date(clock()).toISOString() });
        return Response.json({}, { status: 201 });
      }
      throw new Error(`unexpected gitea request: ${method} ${path}`);
    };
    return createGiteaGitHost({ apiBaseUrl: API, token: () => "admin-token", fetch: fetchImpl as typeof fetch });
  }

  it("keeps a key adopted under a known gateway's own id past the grace period, and still sweeps a key held for a gateway that is gone", async () => {
    let now = Date.parse("2026-11-15T18:00:00Z");
    const old = new Date(now - 30 * 24 * 3_600_000).toISOString();
    const keys: StoredKey[] = [
      { id: 1, title: gatewayKeyTitle(gatewayKeyOwnerId("walter", "octogee-gateway-walter-5bc5949d46-p946t")), key: "ssh-ed25519 AAAAlin lin@gateway", created_at: old },
      { id: 2, title: gatewayKeyTitle("gone"), key: "ssh-ed25519 AAAAgone lin@gone", created_at: old },
    ];
    const host = fakeGitea(() => now, keys);

    await host.registerKey("lin", "ssh-ed25519 AAAAlin lin@gateway", "walter");
    now += GRACE_MS + 60_000;
    await host.sweepKeys({
      readLiveKeyHolders: () => readLiveGatewayKeyHolders({
        gateways: [root("walter")],
        fleetRegistry: [],
        readGatewayPodDiagnosticsBatch: async (gatewayIds) =>
          Object.fromEntries(gatewayIds.map((id) => [id, diagnostics([], "missing")])),
      }),
      mode: "enforce",
      maxCallsPerTick: 100,
      minCallIntervalMs: 0,
      graceMs: GRACE_MS,
      now: () => now,
      sleep: async () => {},
      log: () => {},
    }, createGitKeySweepState());

    expect(keys.map(({ title, key }) => ({ title, key }))).toEqual([
      { title: gatewayKeyTitle("walter"), key: "ssh-ed25519 AAAAlin lin@gateway" },
    ]);
  });
});
