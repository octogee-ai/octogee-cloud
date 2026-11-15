import { afterEach, describe, expect, it, vi } from "vitest";
import * as migrationTransport from "../lib/migration-rsync-transfer.js";
import { SIGNATURE_HEADER } from "@octogee/shared/types/fleet-controller";
import { gatewayScopedJobId, verifyFleetRequest } from "@octogee/core/fleet-signature";
import {
  buildGatewayHeartbeatPollerDeps,
  callUnmountRpc,
  heartbeatPollInstanceIds,
} from "../index.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";
import { stubInformer } from "./fixtures/fleet-informer-stub.js";
import { createScriptedWatches, storeWithScriptedWatches } from "./fixtures/scripted-watches.js";
import { createFleetInformer } from "../fleet-informer.js";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { MalformedRecordError, type FleetRegistryRecord } from "@octogee/core/platform-state";

const WALTER_RUNTIME = { docKind: "runtime", gatewayId: "walter", release: 2, lifecycle: "serving" };

function runtimeRegistry() {
  return createDocumentFixtureStore({ "glmGateways/walter": { ...WALTER_RUNTIME } });
}

class RecordingDocuments extends Map<string, Record<string, unknown>> {
  readonly reads: string[] = [];
  readonly writes: Array<{ path: string; row: Record<string, unknown> }> = [];
  override get(path: string) {
    this.reads.push(path);
    return super.get(path);
  }
  override set(path: string, row: Record<string, unknown>) {
    this.writes.push({ path, row });
    return super.set(path, row);
  }
}

function recordingDocuments(entries: Record<string, Record<string, unknown>>): RecordingDocuments {
  const documents = new RecordingDocuments();
  for (const [path, row] of Object.entries(entries)) Map.prototype.set.call(documents, path, row);
  return documents;
}

describe("callUnmountRpc", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])("uses recovery transport only when deletion opts in: %s", async allowUnready => {
    const recovery = vi.spyOn(migrationTransport, "resolveMigrationRecoveryUrl")
      .mockResolvedValue("http://10.0.0.7:3003");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await callUnmountRpc(runtimeRegistry(), {
      privateKey: FLEET_KEY_PAIR.privateKey, gatewayId: "walter", slug: "alice", log: vi.fn(),
      ...(allowUnready ? { allowUnready: true } : {}),
    });
    const [url, init] = fetchMock.mock.calls[0];
    if (allowUnready) {
      expect(recovery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ gatewayId: "walter", port: "3003" }));
      expect(url).toBe("http://10.0.0.7:3003/unmount/walter");
    } else {
      expect(recovery).not.toHaveBeenCalled();
      expect(url).not.toContain("10.0.0.7");
    }
    const rawBody = String(init?.body);
    const body = JSON.parse(rawBody);
    const signature = (init?.headers as Record<string, string>)[SIGNATURE_HEADER];
    expect(body.slug).toBe("alice");
    expect(verifyFleetRequest(FLEET_KEY_PAIR.publicKey, gatewayScopedJobId(body.migrationId, "walter"), rawBody, signature)).toBe(true);
    expect(verifyFleetRequest(FLEET_KEY_PAIR.publicKey, gatewayScopedJobId(body.migrationId, "other"), rawBody, signature)).toBe(false);
  });

  it("aborts a stuck unmount RPC instead of hanging the isolated gateway poller", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_url, init) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      });

    const pending = callUnmountRpc(runtimeRegistry(), {
      privateKey: FLEET_KEY_PAIR.privateKey,
      gatewayId: "walter",
      slug: "ghost",
      log: vi.fn(),
      timeoutMs: 25,
    });
    const rejection = expect(pending).rejects.toThrow(
      /unmount timed out after 25ms gatewayId=walter slug=ghost/,
    );

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/unmount/walter"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each(["matching", "early-noop", "missing-project", "foreign-agent", "changed-pod"])(
    "requires exact Native completion for a due-erasure unmount: %s", async mode => {
      const coverage = { podUid: "pod-current", agentIds: ["octogee-alice-coach", "octogee-alice-proj-hidden-coach"] };
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        expect(request.agentStoreErasure).toEqual(coverage);
        const result = { migrationId: request.migrationId, slug: request.slug, unmounted: false,
          agentStoreErasure: { ...coverage, agentIds: [...coverage.agentIds] } };
        if (mode === "early-noop") delete (result as { agentStoreErasure?: unknown }).agentStoreErasure;
        if (mode === "missing-project") result.agentStoreErasure.agentIds.pop();
        if (mode === "foreign-agent") result.agentStoreErasure.agentIds[1] = "octogee-bob-coach";
        if (mode === "changed-pod") result.agentStoreErasure.podUid = "other";
        return new Response(JSON.stringify(result));
      });
      const promise = callUnmountRpc(runtimeRegistry(), { privateKey: FLEET_KEY_PAIR.privateKey,
        gatewayId: "walter", slug: "alice", log: vi.fn(), migrationId: "erase-op-claim-10", agentStoreErasure: coverage });
      if (mode === "matching") await expect(promise).resolves.toBeUndefined();
      else await expect(promise).rejects.toThrow("did not confirm exact user Native cleanup");
    });
});

describe("buildGatewayHeartbeatPollerDeps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writeHeartbeat writes ONLY glmGateways/{id}.heartbeat — never the flat gateways/{id} doc", async () => {
    const documents = recordingDocuments({ "glmGateways/walter": { ...WALTER_RUNTIME } });
    const deps = buildGatewayHeartbeatPollerDeps(createDocumentFixtureStore(documents), vi.fn(), FLEET_KEY_PAIR.privateKey, stubInformer());
    await deps.writeHeartbeat("walter", { status: "ready", mountedCustomers: ["ceckert"], openclawProcess: null, startedAt: 42 });

    expect(documents.writes.map((write) => write.path)).toEqual(["glmGateways/walter"]);
    expect(documents.get("glmGateways/walter")).toMatchObject({
      ...WALTER_RUNTIME,
      heartbeat: {
        status: "ready",
        mountedCustomers: ["ceckert"],
        startedAt: 42,
        internalUrl: expect.stringContaining("octogee-gateway-walter"),
        lastHeartbeatAt: expect.any(Number),
      },
    });
  });

  it("signs operator eviction with the fleet controller private key", async () => {
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      capturedInit = init;
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const deps = buildGatewayHeartbeatPollerDeps(
      runtimeRegistry(),
      vi.fn(),
      FLEET_KEY_PAIR.privateKey,
      stubInformer(),
    );

    await deps.evictSlug?.("walter", "ghost");

    const rawBody = capturedInit?.body as string;
    const body = JSON.parse(rawBody) as { migrationId: string };
    const headers = capturedInit?.headers as Record<string, string>;
    const signature = headers[SIGNATURE_HEADER];
    expect(
      verifyFleetRequest(
        FLEET_KEY_PAIR.publicKey,
        gatewayScopedJobId(body.migrationId, "walter"),
        rawBody,
        signature,
      ),
    ).toBe(true);
    // Scoped to the gateway it evicts on, so the evicted pod cannot relay it onward.
    expect(
      verifyFleetRequest(
        FLEET_KEY_PAIR.publicKey,
        gatewayScopedJobId(body.migrationId, "shared-a"),
        rawBody,
        signature,
      ),
    ).toBe(false);
    expect(
      verifyFleetRequest("gateway-token", body.migrationId, rawBody, signature),
    ).toBe(false);
  });

  it("leaves shared eviction to the in-pod reconciler and owns user eviction", async () => {
    const durableGateway = (gatewayClass: "shared" | "isolated") => ({
      gatewayId: "walter",
      latestRelease: 1,
      desiredRelease: 1,
      desiredStatus: "running",
      configSchemaVersion: 1,
      profile: null,
      gatewayClass,
      imageProfile: gatewayClass === "isolated" ? "isolated" : "standard",
      sizingTier: null,
      gcpProject: null,
      gatewayContainerSecurityContext: null,
      serviceAccountName: null,
      serviceAccount: null,
      builderAccess: null,
      ownerUid: gatewayClass === "shared" ? null : "uid-walter",
      builderSlug: gatewayClass === "shared" ? null : "walter",
      modelBrokerLimits: null,
      preemption: null,
    });
    const documents = new Map<string, Record<string, unknown>>([["gateways/walter", durableGateway("shared")]]);
    const deps = buildGatewayHeartbeatPollerDeps(createDocumentFixtureStore(documents), vi.fn(), FLEET_KEY_PAIR.privateKey, stubInformer());

    await expect(deps.ownsEviction?.("walter")).resolves.toBe(false);
    documents.set("gateways/walter", durableGateway("isolated"));
    await expect(deps.ownsEviction?.("walter")).resolves.toBe(true);
  });
});

describe("gateway heartbeat poll — a converged gateway writes nothing", () => {
  function poller() {
    const documents = recordingDocuments({ "glmGateways/walter": { ...WALTER_RUNTIME } });
    const deps = buildGatewayHeartbeatPollerDeps(createDocumentFixtureStore(documents), vi.fn(), FLEET_KEY_PAIR.privateKey, stubInformer());
    return { deps, writes: documents.writes };
  }

  it("writes the first poll and skips an identical second poll", async () => {
    const { deps, writes } = poller();
    const health = { status: "ready", mountedCustomers: ["ceckert"], openclawProcess: null, startedAt: 42 };

    expect(await deps.listGatewayIds()).toEqual(["walter"]);
    await deps.writeHeartbeat("walter", health);
    expect(writes).toHaveLength(1);

    await deps.listGatewayIds();
    await deps.writeHeartbeat("walter", health);

    expect(writes).toHaveLength(1);
  });

  it("writes exactly once more when the poll reports a new mounted set", async () => {
    const { deps, writes } = poller();

    await deps.listGatewayIds();
    await deps.writeHeartbeat("walter", {
      status: "ready",
      mountedCustomers: ["ceckert"],
      openclawProcess: null,
      startedAt: 42,
    });

    await deps.listGatewayIds();
    await deps.writeHeartbeat("walter", {
      status: "ready",
      mountedCustomers: [],
      openclawProcess: null,
      startedAt: 42,
    });

    expect(writes).toHaveLength(2);
    expect(writes[1].row.heartbeat).toMatchObject({ mountedCustomers: [] });
  });
});

describe("runtime heartbeat polling", () => {
  function runtimeRecord(gatewayId: string, lifecycle: FleetRegistryRecord["lifecycle"]): FleetRegistryRecord {
    return { gatewayId, release: 2, lifecycle } as FleetRegistryRecord;
  }

  it("polls every runtime record except failed ones", () => {
    expect(heartbeatPollInstanceIds([
      runtimeRecord("default", "provisioning"),
      runtimeRecord("failed", "failed"),
      runtimeRecord("serving", "serving"),
    ])).toEqual(["default", "serving"]);
  });

  it("fails the whole poll listing on a runtime document that claims another gateway identity", async () => {
    const store = createDocumentFixtureStore({
      "glmGateways/walter": { ...WALTER_RUNTIME },
      "glmGateways/default-shadow": { docKind: "runtime", gatewayId: "default", release: 2, lifecycle: "serving" },
    });
    const deps = buildGatewayHeartbeatPollerDeps(store, vi.fn(), FLEET_KEY_PAIR.privateKey, stubInformer());

    await expect(deps.listGatewayIds()).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("does not list non-runtime glmGateways documents", async () => {
    const store = createDocumentFixtureStore({
      "glmGateways/walter": { ...WALTER_RUNTIME },
      "glmGateways/walter-r2": { docKind: "revision", gatewayId: "walter", release: 2, lifecycle: "serving" },
    });
    const deps = buildGatewayHeartbeatPollerDeps(store, vi.fn(), FLEET_KEY_PAIR.privateKey, stubInformer());

    expect(await deps.listGatewayIds()).toEqual(["walter"]);
  });

  it("keeps polling every other gateway when one runtime record is malformed", async () => {
    const store = createDocumentFixtureStore({
      "glmGateways/walter": { ...WALTER_RUNTIME },
      "glmGateways/flexo": { ...WALTER_RUNTIME, gatewayId: "flexo" },
      "glmGateways/broken": { docKind: "runtime", gatewayId: "other", release: 2, lifecycle: "serving" },
    });
    const valid = await createDocumentFixtureStore({
      "glmGateways/walter": { ...WALTER_RUNTIME },
      "glmGateways/flexo": { ...WALTER_RUNTIME, gatewayId: "flexo" },
    }).fleetRegistry.list();
    const watches = createScriptedWatches();
    const informer = createFleetInformer({ store: storeWithScriptedWatches(store, watches), log: vi.fn() });
    watches.latest("fleetRegistry").error(new MalformedRecordError({ aggregate: "fleet-registry", key: "broken" }, "is not this gateway's runtime record"));
    watches.latest("fleetRegistry").snapshot(valid);
    const log = vi.fn();
    const deps = buildGatewayHeartbeatPollerDeps(store, log, FLEET_KEY_PAIR.privateKey, informer);

    expect(await deps.listGatewayIds()).toEqual(["flexo", "walter"]);
    expect(await deps.listGatewayIds()).toEqual(["flexo", "walter"]);
    await expect(store.fleetRegistry.list()).rejects.toBeInstanceOf(MalformedRecordError);
    expect(log.mock.calls.filter(([message]) =>
      message === "[glm-controller] ⚠ heartbeat poll skips malformed runtime record(s): broken")).toHaveLength(2);
    informer.stop();
  });

  it("reads no roster for a gateway without a runtime record", async () => {
    const deps = buildGatewayHeartbeatPollerDeps(createDocumentFixtureStore({}), vi.fn(), FLEET_KEY_PAIR.privateKey, stubInformer({ users: () => [] }));

    expect(await deps.readAssignedSlugs("default-green")).toEqual([]);
  });
});

describe("gateway heartbeat poll — a converged poll reads nothing", () => {
  const runtime = {
    docKind: "runtime",
    gatewayId: "walter",
    release: 2,
    lifecycle: "serving",
  };
  const userRoot = {
    gatewayId: "walter",
    latestRelease: 1,
    desiredRelease: 1,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "isolated",
    imageProfile: "isolated",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: "uid-walter",
    builderSlug: "walter",
    modelBrokerLimits: null,
    preemption: null,
  };
  const assignedUser = {
    username: "walter",
    provisioning: { openclaw: { gatewayId: "walter", slug: "walter" } },
  };

  const seededDocuments = () => recordingDocuments({
    "glmGateways/walter": runtime,
    "gateways/walter": userRoot,
    "users/uid-walter": assignedUser,
  });

  const warmInformer = async () => {
    const seeded = createDocumentFixtureStore(seededDocuments());
    const [runtimes, roots, userRecords] = await Promise.all([
      seeded.fleetRegistry.list(), seeded.gateways.roots.list(), seeded.users.records.listAll(),
    ]);
    return stubInformer({
      fleetRegistry: () => runtimes,
      fleetRegistryWithoutMalformed: () => ({ records: runtimes, malformedKeys: [] }),
      gateways: () => roots,
      users: () => userRecords,
      usersWithoutMalformed: () => ({ records: userRecords, malformedKeys: [] }),
    });
  };

  it("lists gateways, resolves the roster and owns eviction with zero store reads", async () => {
    const documents = seededDocuments();
    const deps = buildGatewayHeartbeatPollerDeps(
      createDocumentFixtureStore(documents),
      vi.fn(),
      FLEET_KEY_PAIR.privateKey,
      await warmInformer(),
    );

    expect(await deps.listGatewayIds()).toEqual(["walter"]);
    expect(await deps.readAssignedSlugs("walter")).toEqual(["walter"]);
    expect(await deps.ownsEviction?.("walter")).toBe(true);

    expect(documents.reads).toEqual([]);
  });

  it("falls back to direct reads while the mirrors are stale", async () => {
    const documents = seededDocuments();
    const deps = buildGatewayHeartbeatPollerDeps(
      createDocumentFixtureStore(documents),
      vi.fn(),
      FLEET_KEY_PAIR.privateKey,
      stubInformer(),
    );

    expect(await deps.listGatewayIds()).toEqual(["walter"]);
    expect(await deps.readAssignedSlugs("walter")).toEqual(["walter"]);
    expect(await deps.ownsEviction?.("walter")).toBe(true);

    expect(documents.reads).toEqual(expect.arrayContaining(["glmGateways/walter", "gateways/walter"]));
  });

  it("re-reads the runtime record from the store, never the mirror, before an eviction RPC", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const documents = recordingDocuments({ "glmGateways/walter": { ...WALTER_RUNTIME } });
    const deps = buildGatewayHeartbeatPollerDeps(
      createDocumentFixtureStore(documents),
      vi.fn(),
      FLEET_KEY_PAIR.privateKey,
      await warmInformer(),
    );

    await deps.evictSlug?.("walter", "ghost");

    expect(documents.reads).toEqual(["glmGateways/walter", "glmGateways/walter"]);
  });
});
