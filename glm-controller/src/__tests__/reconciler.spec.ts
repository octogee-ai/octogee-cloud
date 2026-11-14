import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readGatewayConvergenceInstances,
  processOperation,
  readTargetedDurableRuntimeGateways,
  runGatewayConvergencePass,
  reconcileRelevantDeliveryGatewayIds,
  reconcileRelevantRootDeliveryGatewayIds,
  requestGatewayRecheck,
  serializeGatewayConvergence,
  startReconciler,
} from "../index";
import { acknowledgeUserRestore, beginUserRestore, type FleetStateDeps } from "@octogee/core/fleet-state";
import {
  MalformedRecordError,
  type FleetRegistryRecord,
  type GatewayRoot,
  type PlatformStateStore,
  type Stored,
  type WatchChange,
} from "@octogee/core/platform-state";
import { createJournalFixtureStore, journalRowsIn, type FixtureDocuments } from "@octogee/core/testing/journal-store";
import { VmCreationPendingError, FinalHomeCheckpointPendingError } from "../vm-lifecycle";
import { runGatewayRuntimeExclusive } from "../lib/gateway-runtime-mutation";
import { reconcileSurgeUserHandoff } from "../surge-user-handoff";
import { assignment, createSurgeHandoffHarness } from "./fixtures/surge-user-handoff";
import { stubInformer } from "./fixtures/fleet-informer-stub";
import type { FleetInformer, MirroredAggregate, MirrorDelivery, MirrorSubscriber } from "../fleet-informer";
import type { AuthSecretEnsurer } from "../auth-secret-ensurer";

function durableRoot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId: "default",
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 2,
    desiredRelease: 2,
    liveRelease: 2,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: "standard",
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: "m",
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    modelBrokerLimits: null,
    preemption: null,
    coOwnerUids: [],
    ...overrides,
  };
}

function servingRuntime(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    docKind: "runtime",
    gatewayId: "default",
    release: 2,
    lifecycle: "serving",
    helm: { imageTag: "abc1234" },
    ...overrides,
  };
}

interface MirrorFeeds {
  fleetRegistry?: MirrorSubscriber<"fleetRegistry">;
  gateways?: MirrorSubscriber<"gateways">;
  decodable?: () => Promise<DecodableRecords>;
}

interface DecodableRecords {
  gateways: Stored<GatewayRoot>[];
  fleetRegistry: Stored<FleetRegistryRecord>[];
}

interface SnapshotChange {
  type: WatchChange<"fleetRegistry">["type"];
  doc: { id: string; data(): Record<string, unknown> };
}

let revisionCount = 0;

function nextRevision(): string {
  revisionCount += 1;
  return `r${revisionCount}`;
}

function runtimeRecord(data: Record<string, unknown>): Stored<FleetRegistryRecord> {
  const { docKind: _docKind, ...record } = data;
  return { ...record, revision: nextRevision() } as unknown as Stored<FleetRegistryRecord>;
}

function rootRecord(data: Record<string, unknown>): Stored<GatewayRoot> {
  return { ...data, revision: nextRevision() } as unknown as Stored<GatewayRoot>;
}

function runtimeChanges(changes: readonly SnapshotChange[]): MirrorDelivery<"fleetRegistry"> {
  return {
    kind: "changes",
    changes: changes.map((change) => ({
      type: change.type,
      key: change.doc.id,
      record: change.type === "removed" ? null : runtimeRecord(change.doc.data()),
    })),
  };
}

function rootChanges(changes: readonly SnapshotChange[]): MirrorDelivery<"gateways"> {
  return {
    kind: "changes",
    changes: changes.map((change) => ({
      type: change.type,
      key: change.doc.id,
      record: change.type === "removed" ? null : rootRecord(change.doc.data()),
    })),
  };
}

function runtimeReset(changes: readonly SnapshotChange[]): MirrorDelivery<"fleetRegistry"> {
  return { kind: "reset", records: changes.map((change) => runtimeRecord(change.doc.data())) };
}

function rootReset(changes: readonly SnapshotChange[]): MirrorDelivery<"gateways"> {
  return { kind: "reset", records: changes.map((change) => rootRecord(change.doc.data())) };
}

function runtimeChangeIsRelevant(changes: readonly SnapshotChange[], fingerprints: Map<string, string>): boolean {
  return reconcileRelevantDeliveryGatewayIds(runtimeChanges(changes), fingerprints).length > 0;
}

function rootChangeIsRelevant(changes: readonly SnapshotChange[], fingerprints: Map<string, string>): boolean {
  return reconcileRelevantRootDeliveryGatewayIds(rootChanges(changes), fingerprints).length > 0;
}

function feedingInformer(feeds: MirrorFeeds): FleetInformer {
  const subscribe = (aggregate: MirroredAggregate, subscriber: MirrorSubscriber<MirroredAggregate>) => {
    if (aggregate === "assignments") throw new Error("the reconciler does not subscribe to assignments");
    const slot = feeds as Record<string, unknown>;
    slot[aggregate] = subscriber;
    return () => {
      if (slot[aggregate] === subscriber) delete slot[aggregate];
    };
  };
  return stubInformer({ subscribe: subscribe as FleetInformer["subscribe"] });
}

async function decodableRecords(store: PlatformStateStore, rows: { roots: Rows; runtimes: Rows }): Promise<DecodableRecords> {
  const decoded = async <T>(read: () => Promise<T | null>): Promise<T[]> => {
    try {
      const record = await read();
      return record === null ? [] : [record];
    } catch (error) {
      if (error instanceof MalformedRecordError) return [];
      throw error;
    }
  };
  const gateways = await Promise.all(Object.keys(rows.roots).map((id) => decoded(() => store.gateways.roots.get(id))));
  const fleetRegistry = await Promise.all(Object.keys(rows.runtimes).map((id) => decoded(() => store.fleetRegistry.get(id))));
  return { gateways: gateways.flat(), fleetRegistry: fleetRegistry.flat() };
}

interface ReconcilerRows {
  roots?: Rows;
  runtimes?: Rows;
  releases?: Record<string, Record<number, Record<string, unknown>>>;
  users?: Rows;
  operations?: Rows;
  assignments?: Rows;
}

type Rows = Record<string, Record<string, unknown>>;

function reconcilerState(input: ReconcilerRows & { callbacks: MirrorFeeds }) {
  const rows = {
    roots: input.roots ?? {}, runtimes: input.runtimes ?? {}, users: input.users ?? {},
    operations: input.operations ?? {}, assignments: input.assignments ?? {},
  };
  const store = fixtureStoreOver({ ...rows, releases: input.releases });
  input.callbacks.decodable = () => decodableRecords(store, rows);
  const ensureGatewayAuthSecret = vi.fn<AuthSecretEnsurer["ensureAuthSecret"]>(async () => {});
  return { store, informer: feedingInformer(input.callbacks), ensureGatewayAuthSecret };
}

function fixtureStoreOver(collections: {
  roots: Rows; runtimes: Rows; users: Rows; operations: Rows; assignments: Rows;
  releases?: Record<string, Record<number, Record<string, unknown>>>;
  config?: Rows;
}): PlatformStateStore {
  const releases: Rows = Object.fromEntries(Object.entries(collections.releases ?? {}).flatMap(([gatewayId, byRelease]) =>
    Object.entries(byRelease).map(([release, row]) => [`${gatewayId}/${release}`, row])));
  const userSystemConfigs: Rows = {};
  const locate = (path: string): [Rows, string] => {
    const [collection, id, sub, uid, ...rest] = path.split("/");
    if (rest.length === 0 && collection === "users" && sub === "system" && uid === "config") return [userSystemConfigs, id];
    if (rest.length === 0 && collection === "gateways" && sub === "assignments" && uid !== undefined) return [collections.assignments, `${id}/${uid}`];
    if (rest.length === 0 && collection === "gateways" && sub === "releases" && uid !== undefined) return [releases, `${id}/${uid}`];
    if (sub === undefined && collection === "gateways") return [collections.roots, id];
    if (sub === undefined && collection === "glmGateways") return [collections.runtimes, id];
    if (sub === undefined && collection === "users") return [collections.users, id];
    if (sub === undefined && collection === "glmOperations") return [collections.operations, id];
    if (sub === undefined && collection === "config" && collections.config) return [collections.config, id];
    throw new Error(`unexpected document ${path}`);
  };
  const documents: FixtureDocuments = {
    get: (path) => { const [rows, id] = locate(path); return rows[id]; },
    set: (path, row) => { const [rows, id] = locate(path); rows[id] = row; },
    delete: (path) => { const [rows, id] = locate(path); delete rows[id]; },
    children: (collectionPath) => {
      if (collectionPath === "users") return Object.entries(collections.users);
      if (collectionPath === "glmOperations") return Object.entries(collections.operations);
      if (collectionPath === "gateways") return Object.entries(collections.roots);
      if (collectionPath === "glmGateways") return Object.entries(collections.runtimes);
      throw new Error(`unexpected collection listing ${collectionPath}`);
    },
    group: (collectionId) => { throw new Error(`unexpected collection group ${collectionId}`); },
  };
  return createJournalFixtureStore(journalRowsIn(collections.operations), { documents });
}

function releaseArtifact(
  gatewayId: string,
  release: number,
  imageTag: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    gatewayId,
    release,
    payload: {
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag,
      gatewayEdgeImage: {
        imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge",
        imageTag,
      },
      ...extra,
    },
  };
}

async function runTick(callbacks: MirrorFeeds): Promise<void> {
  const records = await callbacks.decodable!();
  callbacks.fleetRegistry?.({ kind: "reset", records: records.fleetRegistry });
  callbacks.gateways?.({ kind: "reset", records: records.gateways });
  await vi.advanceTimersByTimeAsync(1_000);
  await Promise.resolve();
  await Promise.resolve();
}

describe("snapshot reconciliation filters", () => {
  it("ignores heartbeat telemetry-only runtime doc changes", () => {
    const fingerprints = new Map<string, string>();
    runtimeChangeIsRelevant(
      [{
        type: "added",
        doc: {
          id: "default",
          data: () => servingRuntime({
            heartbeat: {
              status: "ready",
              version: "abc1234",
              lastHeartbeatAt: 1,
              mountedCustomers: ["alice"],
            },
          }),
        },
      }],
      fingerprints,
    );

    expect(
      runtimeChangeIsRelevant(
        [
          {
            type: "modified",
            doc: {
              id: "default",
              data: () => servingRuntime({
                heartbeat: {
                  status: "ready",
                  version: "abc1234",
                  lastHeartbeatAt: 2,
                  mountedCustomers: ["alice", "bob"],
                },
              }),
            },
          },
        ],
        fingerprints,
      ),
    ).toBe(false);
  });

  it("ignores pod-identity and loss-history changes on the runtime doc", () => {
    const fingerprints = new Map<string, string>();
    runtimeChangeIsRelevant(
      [{
        type: "added",
        doc: {
          id: "default",
          data: () => servingRuntime({
            kubernetes: {
              status: "ready",
              totalPods: 1,
              readyPods: 1,
              observedAt: 1,
              pods: [{ uid: "uid-a", name: "pod-a", replicaSetUid: "rs-1", nodeName: "node-1", instanceId: "1", nodePool: "nap" }],
            },
          }),
        },
      }],
      fingerprints,
    );

    expect(
      runtimeChangeIsRelevant(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => servingRuntime({
              kubernetes: {
                status: "ready",
                totalPods: 1,
                readyPods: 1,
                observedAt: 2,
                pods: [{ uid: "uid-b", name: "pod-b", replicaSetUid: "rs-1", nodeName: "node-2", instanceId: "2", nodePool: "nap" }],
              },
              podReplacements: {
                recentAt: [2],
                lastAt: 2,
                lastVacatedPodUid: "uid-a",
                lastVacatedNodeName: "node-1",
                lastVacatedInstanceId: "1",
                lastVacatedNodePool: "nap",
                total: 1,
              },
            }),
          },
        }],
        fingerprints,
      ),
    ).toBe(false);
  });

  it("ignores gateway VM disk reports on the runtime doc", () => {
    const fingerprints = new Map<string, string>();
    const disk = (freeBytes: number, observedAt: number) => servingRuntime({
      runtime: "gce-vm",
      vmDisk: { sizeBytes: 100, freeBytes, instanceId: "4242", observedAt },
    });
    runtimeChangeIsRelevant([{ type: "added", doc: { id: "default", data: () => disk(50, 1) } }], fingerprints);

    expect(
      runtimeChangeIsRelevant([{ type: "modified", doc: { id: "default", data: () => disk(10, 2) } }], fingerprints),
    ).toBe(false);
  });

  it("ignores the user's VM egress routing choice", () => {
    const fingerprints = new Map<string, string>();
    const routed = (mode: "cloud" | "desktop", updatedAt: number) => servingRuntime({ runtime: "gce-vm", vmEgress: { mode, updatedAt } });
    runtimeChangeIsRelevant([{ type: "added", doc: { id: "default", data: () => routed("cloud", 1) } }], fingerprints);
    expect(runtimeChangeIsRelevant([{ type: "modified", doc: { id: "default", data: () => routed("desktop", 2) } }], fingerprints)).toBe(false);
  });

  it("ignores VM container image observations without hiding release changes", () => {
    const fingerprints = new Map<string, string>();
    const first = servingRuntime({ vmImages: { instanceId: "4242", observedAt: 1, containers: [] } });
    runtimeChangeIsRelevant([{ type: "added", doc: { id: "default", data: () => first } }], fingerprints);
    const next = { ...first, vmImages: { instanceId: "4242", observedAt: 2, containers: [{ name: "gateway", running: false }] } };
    expect(runtimeChangeIsRelevant([{ type: "modified", doc: { id: "default", data: () => next } }], fingerprints)).toBe(false);
    expect(runtimeChangeIsRelevant([{ type: "modified", doc: { id: "default", data: () => ({ ...next, desiredRelease: 99 }) } }], fingerprints)).toBe(true);
  });

  it.each([
    ["status", { status: "unreachable", version: "abc1234" }],
    ["version", { status: "ready", version: "def5678" }],
  ])("schedules when heartbeat %s changes", (_field, heartbeat) => {
    const fingerprints = new Map<string, string>();
    runtimeChangeIsRelevant(
      [{
        type: "added",
        doc: {
          id: "default",
          data: () => servingRuntime({
            heartbeat: { status: "ready", version: "abc1234", lastHeartbeatAt: 1 },
          }),
        },
      }],
      fingerprints,
    );

    expect(
      runtimeChangeIsRelevant(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => servingRuntime({ heartbeat: { ...heartbeat, lastHeartbeatAt: 2 } }),
          },
        }],
        fingerprints,
      ),
    ).toBe(true);
  });

  it("ignores Kubernetes observation freshness-only changes", () => {
    const fingerprints = new Map<string, string>();
    runtimeChangeIsRelevant(
      [{
        type: "added",
        doc: {
          id: "default",
          data: () => servingRuntime({
            kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: 1 },
          }),
        },
      }],
      fingerprints,
    );

    expect(
      runtimeChangeIsRelevant(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => servingRuntime({
              kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: 2 },
            }),
          },
        }],
        fingerprints,
      ),
    ).toBe(false);
  });

  it("ignores converge-authored helm bookkeeping-only changes", () => {
    const fingerprints = new Map<string, string>();
    runtimeChangeIsRelevant(
      [{
        type: "added",
        doc: {
          id: "default",
          data: () => servingRuntime({
            helm: { imageTag: "abc1234", lastAppliedAt: 1, availableReplicas: 1 },
          }),
        },
      }],
      fingerprints,
    );

    expect(
      runtimeChangeIsRelevant(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => servingRuntime({
              helm: { imageTag: "abc1234", lastAppliedAt: 2, availableReplicas: 0 },
            }),
          },
        }],
        fingerprints,
      ),
    ).toBe(false);
  });

  it("still reconciles when the applied helm image changes", () => {
    const fingerprints = new Map<string, string>();
    runtimeChangeIsRelevant(
      [{
        type: "added",
        doc: {
          id: "default",
          data: () => servingRuntime({
            helm: { imageTag: "abc1234", lastAppliedAt: 1 },
          }),
        },
      }],
      fingerprints,
    );

    expect(
      runtimeChangeIsRelevant(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => servingRuntime({
              helm: { imageTag: "def5678", lastAppliedAt: 2 },
            }),
          },
        }],
        fingerprints,
      ),
    ).toBe(true);
  });

  it.each([
    ["status", { status: "not-ready", totalPods: 1, readyPods: 1 }],
    ["totalPods", { status: "ready", totalPods: 2, readyPods: 1 }],
    ["readyPods", { status: "ready", totalPods: 1, readyPods: 0 }],
  ])("schedules when Kubernetes %s changes", (_field, kubernetes) => {
    const fingerprints = new Map<string, string>();
    runtimeChangeIsRelevant(
      [{
        type: "added",
        doc: {
          id: "default",
          data: () => servingRuntime({
            kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: 1 },
          }),
        },
      }],
      fingerprints,
    );

    expect(
      runtimeChangeIsRelevant(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => servingRuntime({ kubernetes: { ...kubernetes, observedAt: 2 } }),
          },
        }],
        fingerprints,
      ),
    ).toBe(true);
  });

  it("schedules on a release-bearing runtime change", () => {
    const fingerprints = new Map<string, string>();
    runtimeChangeIsRelevant(
      [{ type: "added", doc: { id: "default", data: () => servingRuntime() } }],
      fingerprints,
    );
    expect(
      runtimeChangeIsRelevant(
        [
          {
            type: "modified",
            doc: { id: "default", data: () => servingRuntime({ release: 3 }) },
          },
        ],
        fingerprints,
      ),
    ).toBe(true);
  });
});

describe("mirror delivery reconciliation filters", () => {
  it("ignores a runtime change that only moves the record revision", () => {
    const fingerprints = new Map<string, string>();
    runtimeChangeIsRelevant([{ type: "added", doc: { id: "default", data: () => servingRuntime() } }], fingerprints);

    expect(runtimeChangeIsRelevant([{ type: "modified", doc: { id: "default", data: () => servingRuntime() } }], fingerprints)).toBe(false);
  });

  it("reports a gateway that a later reset no longer carries as changed", () => {
    const fingerprints = new Map<string, string>();
    reconcileRelevantDeliveryGatewayIds(runtimeReset([
      { type: "added", doc: { id: "default", data: () => servingRuntime() } },
      { type: "added", doc: { id: "walter", data: () => servingRuntime({ gatewayId: "walter" }) } },
    ]), fingerprints);

    expect(reconcileRelevantDeliveryGatewayIds(runtimeReset([
      { type: "added", doc: { id: "default", data: () => servingRuntime() } },
    ]), fingerprints)).toEqual(["walter"]);
    expect([...fingerprints.keys()]).toEqual(["default"]);
  });

  it("reports nothing for a reset that matches what the fingerprints already hold", () => {
    const fingerprints = new Map<string, string>();
    reconcileRelevantRootDeliveryGatewayIds(rootReset([{ type: "added", doc: { id: "default", data: () => durableRoot() } }]), fingerprints);

    expect(reconcileRelevantRootDeliveryGatewayIds(
      rootReset([{ type: "added", doc: { id: "default", data: () => durableRoot() } }]),
      fingerprints,
    )).toEqual([]);
  });
});

describe("root snapshot reconciliation filters", () => {
  it("ignores a gateway pod's reconcile-error report", () => {
    const fingerprints = new Map<string, string>();
    rootChangeIsRelevant(
      [{ type: "added", doc: { id: "default", data: () => durableRoot() } }],
      fingerprints,
    );

    expect(
      rootChangeIsRelevant(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => durableRoot({
              lastError: { slug: "alice", message: "mount failed", at: 2 },
            }),
          },
        }],
        fingerprints,
      ),
    ).toBe(false);

    expect(
      rootChangeIsRelevant(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => durableRoot({
              lastError: { slug: "alice", message: "mount failed again", at: 3 },
            }),
          },
        }],
        fingerprints,
      ),
    ).toBe(false);

    expect(
      rootChangeIsRelevant(
        [{
          type: "modified",
          doc: { id: "default", data: () => durableRoot({ lastError: null }) },
        }],
        fingerprints,
      ),
    ).toBe(false);
  });

  it.each([
    ["desiredRelease", { desiredRelease: 3 }],
    ["desiredStatus", { desiredStatus: "draining" }],
    ["liveRelease", { liveRelease: 1 }],
    ["updatedAt", { updatedAt: 2 }],
  ])("still reconciles when the root %s changes", (_field, overrides) => {
    const fingerprints = new Map<string, string>();
    rootChangeIsRelevant(
      [{ type: "added", doc: { id: "default", data: () => durableRoot() } }],
      fingerprints,
    );

    expect(
      rootChangeIsRelevant(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => durableRoot({
              ...overrides,
              lastError: { slug: "alice", message: "mount failed", at: 2 },
            }),
          },
        }],
        fingerprints,
      ),
    ).toBe(true);
  });
});

describe("targeted durable state reads", () => {
  function targetedStore(input: { roots: Rows; runtimes: Rows }) {
    const scanned: string[] = [];
    const fetched: string[] = [];
    const fixture = fixtureStoreOver({ ...input, users: {}, operations: {}, assignments: {} });
    const roots = fixture.gateways.roots;
    const registry = fixture.fleetRegistry;
    const store = {
      ...fixture,
      gateways: {
        ...fixture.gateways,
        roots: {
          ...roots,
          list: (filter?: Parameters<typeof roots.list>[0]) => {
            scanned.push("gateways");
            return roots.list(filter);
          },
          getMany: (ids: readonly string[]) => {
            fetched.push(...ids.map((id) => `gateways/${id}`));
            return roots.getMany(ids);
          },
        },
      },
      fleetRegistry: {
        ...registry,
        inventory: (ids?: readonly string[]) => {
          if (ids === undefined) scanned.push("glmGateways");
          else fetched.push(...ids.map((id) => `glmGateways/${id}`));
          return registry.inventory(ids);
        },
      },
    } as PlatformStateStore;
    return { store, scanned, fetched };
  }

  it("reads only the selected roots and runtimes", async () => {
    const { store, scanned, fetched } = targetedStore({
      roots: { default: durableRoot(), other: durableRoot({ gatewayId: "other" }) },
      runtimes: {
        default: servingRuntime(),
        other: servingRuntime({ gatewayId: "other" }),
      },
    });

    const state = await readTargetedDurableRuntimeGateways(store, ["default"]);

    expect(scanned).toEqual([]);
    expect(fetched.sort()).toEqual(["gateways/default", "glmGateways/default"]);
    expect(state.gateways.map((gateway) => gateway.gatewayId)).toEqual(["default"]);
    expect(state.runtimeDocs.map((doc) => doc.gatewayId)).toEqual(["default"]);
    expect(state.invalidRootIds).toEqual([]);
    expect(state.strayGlmDocs).toEqual([]);
  });

  it("treats a fully removed gateway as absent, not invalid", async () => {
    const { store } = targetedStore({ roots: {}, runtimes: {} });

    await expect(readTargetedDurableRuntimeGateways(store, ["gone"])).resolves.toEqual({
      gateways: [],
      runtimeDocs: [],
      invalidRootIds: [],
      strayGlmDocs: [],
    });
  });

  it("still refuses a selected invalid root or stray runtime doc", async () => {
    const invalid = targetedStore({
      roots: { legacy: { gatewayId: "legacy", desiredStatus: "running" } },
      runtimes: {},
    });
    await expect(readTargetedDurableRuntimeGateways(invalid.store, ["legacy"]))
      .rejects.toBeInstanceOf(MalformedRecordError);

    const stray = targetedStore({
      roots: {},
      runtimes: { orphan: servingRuntime({ gatewayId: "orphan" }) },
    });
    await expect(readTargetedDurableRuntimeGateways(stray.store, ["orphan"]))
      .resolves.toMatchObject({ strayGlmDocs: [{ id: "orphan", remedy: expect.stringContaining("delete glmGateways/orphan") }] });
  });

  it("does not scan either fleet collection for a targeted convergence pass", async () => {
    const { store, scanned } = targetedStore({ roots: {}, runtimes: {} });
    const passDeps = {
      store,
      helm: {
        readDeployedInstance: vi.fn(async () => null),
        readDeployedInstances: vi.fn(async () => ({})),
      } as never,
      kubeOps: {} as never,
      chartFingerprint: "chart",
      prepareGatewayConfig: vi.fn(async (config) => config),
      ensureIsolatedPodHome: vi.fn(async () => {}), reconcileSurgeHandoff: vi.fn(async () => ({ ready: true })),
      log: vi.fn(),
    };

    await runGatewayConvergencePass(passDeps, ["ghost"]);
    expect(scanned).toEqual([]);

    await runGatewayConvergencePass(passDeps);
    expect(scanned).toEqual(["gateways", "glmGateways"]);
  });
});

describe("gateway convergence pass outcomes", () => {
  function convergenceFleet(ids: string[]) {
    const roots = Object.fromEntries(ids.map(gatewayId => [gatewayId, durableRoot({ gatewayId, liveRelease: null })]));
    const runtimes: Record<string, Record<string, unknown>> = {};
    const instances: Record<string, any> = {};
    const helm = {
      readDeployedInstances: vi.fn(async () => instances),
      upsertInstance: vi.fn(async (opts: any) => {
        instances[opts.gatewayId] = {
          gatewayId: opts.gatewayId, enabled: true, replicas: 1,
          image: { repository: opts.imageRepository, tag: opts.imageTag },
          chartFingerprint: opts.chartFingerprint,
          deploymentIntentFingerprint: opts.deploymentIntentFingerprint,
        };
      }),
    };
    const deps = {
      store: fixtureStoreOver({ roots, runtimes, users: {}, operations: {}, assignments: {},
        releases: Object.fromEntries(ids.map(id => [id, { 2: releaseArtifact(id, 2, "abc1234") }])) }),
      helm: helm as never, kubeOps: {} as never, chartFingerprint: "chart",
      prepareGatewayConfig: vi.fn(async (config: any) => config),
      ensureIsolatedPodHome: vi.fn(async () => {}), reconcileSurgeHandoff: vi.fn(async (_input: { gatewayId: string; desiredImageTag: string }) => ({ ready: true })),
      log: vi.fn(),
    };
    return { roots, runtimes, instances, helm, deps };
  }

  it("installs a minted slot while a foreign activation holds another Shared slot without failing the pass", async () => {
    const h = convergenceFleet(["default", "minted"]);
    await runGatewayConvergencePass(h.deps);
    delete h.instances.minted;
    h.helm.upsertInstance.mockClear();
    const busy = assignment("u1", "alice", { state: "quiescing", updatedByOperationId: "builder-activate-alice" });
    const handoff = createSurgeHandoffHarness(vi.fn, { assignments: [busy], targetVersion: "abc1234" });
    h.deps.reconcileSurgeHandoff.mockImplementation(input => reconcileSurgeUserHandoff(handoff.deps, {
      ...input, requiresUserMigration: true,
    }));

    await expect(runGatewayConvergencePass(h.deps)).resolves.toBeUndefined();

    expect(h.helm.upsertInstance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ gatewayId: "minted" }));
    expect(handoff.assignments()).toEqual([busy]);
    expect(handoff.events).toEqual([]);
    expect(h.roots.default.liveRelease).toBeNull();
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringMatching(/default.*deferred.*foreign assignment gate/));
    expect(h.deps.log.mock.calls.flat().filter(line => line.includes("⚠"))).toEqual([]);
  });

  it("installs new gateways when another runtime has not reported a heartbeat", async () => {
    const h = convergenceFleet(["default", "minted"]);
    h.runtimes.default = servingRuntime({ lifecycle: "provisioning" });

    await expect(runGatewayConvergencePass(h.deps)).resolves.toBeUndefined();

    expect(h.helm.upsertInstance.mock.calls.map(([opts]) => opts.gatewayId).sort()).toEqual(["default", "minted"]);
  });

  function reportedHeartbeat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      status: "booting", lastHeartbeatAt: 10, version: "abc1234", openclawVersion: null,
      internalUrl: "http://octogee-gateway-default:18789", startedAt: 5, mountedCustomers: [], migratingIn: [],
      ...overrides,
    };
  }

  it("keeps a heartbeat config status written after the pass read when it upserts the gateway", async () => {
    const h = convergenceFleet(["default"]);
    h.runtimes.default = servingRuntime({
      lifecycle: "provisioning",
      helm: { imageTag: "abc1234", replicas: 1, availableReplicas: null },
      heartbeat: reportedHeartbeat(),
    });
    const configStatus = { runtimeReady: true, openclawVersion: "2026.7.2", observedAt: 15 };
    h.deps.prepareGatewayConfig.mockImplementation(async (config: any) => {
      h.runtimes.default = {
        ...h.runtimes.default,
        heartbeat: { ...(h.runtimes.default.heartbeat as Record<string, unknown>), configStatus, lastHeartbeatAt: 20 },
      };
      return config;
    });

    await runGatewayConvergencePass(h.deps);

    expect(h.helm.upsertInstance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ gatewayId: "default" }));
    expect(h.runtimes.default.heartbeat).toEqual(reportedHeartbeat({ configStatus, lastHeartbeatAt: 20 }));
  });

  it("resets the heartbeat of a gateway resuming from zero replicas", async () => {
    const h = convergenceFleet(["default"]);
    h.runtimes.default = servingRuntime({
      lifecycle: "serving",
      helm: { imageTag: "abc1234", replicas: 0, availableReplicas: 0 },
      heartbeat: reportedHeartbeat({ status: "ready", configStatus: { runtimeReady: true } }),
    });

    await runGatewayConvergencePass(h.deps);

    expect(h.helm.upsertInstance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ gatewayId: "default" }));
    expect(h.runtimes.default).toMatchObject({
      lifecycle: "provisioning",
      heartbeat: {
        status: "unknown", lastHeartbeatAt: null, version: null, openclawVersion: null,
        internalUrl: null, startedAt: null, mountedCustomers: [], migratingIn: [],
      },
      helm: { replicas: 1, availableReplicas: null },
    });
    expect(h.runtimes.default.heartbeat).not.toHaveProperty("configStatus");
  });

  it.each(["provisioning", "serving"])("marks a released Ready slot live ahead of blocked Helm installs with lifecycle=%s", async lifecycle => {
    const minted = Array.from({ length: 8 }, (_, i) => `minted-${i}`);
    const h = convergenceFleet([...minted, "released"]);
    await runGatewayConvergencePass(h.deps);
    for (const id of minted) delete h.instances[id];
    h.runtimes.released.lifecycle = lifecycle;
    h.runtimes.released.heartbeat = { status: "ready", version: "abc1234" };
    h.helm.upsertInstance.mockClear();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    h.helm.upsertInstance.mockImplementation(async () => { await held; });

    const applying = runGatewayConvergencePass(h.deps);
    try {
      await vi.waitFor(() => expect(h.roots.released.liveRelease).toBe(2));
      expect(h.runtimes.released.lifecycle).toBe("serving");
      expect(h.helm.upsertInstance).toHaveBeenCalled();
    } finally {
      release();
      await applying;
    }
  });

  it("upserts a burst of minted slots in one pass with at most four active gateways", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `minted-${i}`);
    const h = convergenceFleet(ids);
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    h.helm.upsertInstance.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await held;
      active -= 1;
    });

    const applying = runGatewayConvergencePass(h.deps);
    try {
      await vi.waitFor(() => expect(h.helm.upsertInstance).toHaveBeenCalledTimes(4));
      expect(active).toBe(4);
    } finally {
      release();
      await applying;
    }
    expect(peak).toBe(4);
    expect(h.helm.upsertInstance.mock.calls.map(([opts]) => opts.gatewayId).sort()).toEqual(ids.sort());
  });

  it.each([
    { state: "quiescing" as const, updatedByOperationId: null },
    { state: "migrating" as const, updatedByOperationId: "builder-activate-alice" },
  ])("fails the pass for an assignment gate with state=$state owner=$updatedByOperationId", async gate => {
    const h = convergenceFleet(["default", "minted"]);
    await runGatewayConvergencePass(h.deps);
    delete h.instances.minted;
    h.helm.upsertInstance.mockClear();
    const blocked = assignment("u1", "alice", gate);
    const handoff = createSurgeHandoffHarness(vi.fn, { assignments: [blocked], targetVersion: "abc1234" });
    h.deps.reconcileSurgeHandoff.mockImplementation(input => reconcileSurgeUserHandoff(handoff.deps, {
      ...input, requiresUserMigration: true,
    }));

    await expect(runGatewayConvergencePass(h.deps)).rejects.toThrow("(source=converge-gateway) default: foreign assignment gate");
    expect(h.helm.upsertInstance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ gatewayId: "minted" }));
    expect(handoff.assignments()).toEqual([blocked]);
    expect(handoff.events).toEqual([]);
  });

  it("retains runtime exclusivity until every worker finishes after another worker fails", async () => {
    const h = convergenceFleet(["broken", "slow", "minted"]);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const events: string[] = [];
    h.helm.upsertInstance.mockImplementation(async ({ gatewayId }) => {
      if (gatewayId === "broken") throw new Error("Helm unavailable");
      if (gatewayId === "slow") await held;
      events.push(gatewayId);
    });
    const converge = serializeGatewayConvergence(() => runGatewayConvergencePass(h.deps));
    const applying = converge().catch(error => error);
    const recovery = converge.runExclusive(async () => { events.push("recovery"); });
    try {
      await vi.waitFor(() => expect(h.helm.upsertInstance).toHaveBeenCalledTimes(3));
      expect(events).toEqual(["minted"]);
    } finally {
      release();
      const failure = await applying;
      await recovery;
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain("broken: Helm unavailable");
    }
    expect(events).toEqual(["minted", "slow", "recovery"]);
  });

  function retainedGateway(input: { desiredStatus?: string; gatewayClass?: string } = {}) {
    const gatewayId = "shared-1";
    const roots = { [gatewayId]: durableRoot({ gatewayId, ...input }) };
    const runtimes = { [gatewayId]: servingRuntime({ gatewayId, runtime: "cluster" }) };
    const users: Record<string, any> = { u: { username: "alice", provisioning: {
      status: "complete", openclaw: { gatewayId, status: "complete" },
    } } };
    const operations = { return: { kind: "migrate-user", status: "running", startedAt: 100,
      input: { uid: "u", fromGatewayId: "builder-alice", toGatewayId: gatewayId }, cutoverCommittedAt: 50,
      schedulerHandoff: { uid: "u", slug: "alice", fromGatewayId: "builder-alice", toGatewayId: gatewayId } } };
    const assignments = { [`${gatewayId}/u`]: { uid: "u", slug: "alice", gatewayId, source: "onboarding", epoch: 3, state: "serving" } };
    const store = fixtureStoreOver({ roots, runtimes, users, operations, assignments,
      releases: { [gatewayId]: { 2: releaseArtifact(gatewayId, 2, "abc1234") } } });
    const helm = {
      upsertInstance: vi.fn(async (_opts: Record<string, unknown>) => {}), removeInstance: vi.fn(async () => {}),
      readDeployedInstances: vi.fn(async () => ({ [gatewayId]: { gatewayId, enabled: true, release: 2,
        image: { repository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway", tag: "abc1234" },
        chartFingerprint: "chart", deploymentIntentFingerprint: "stale-intent", replicas: 1 } })),
    };
    const deps = { store, helm: helm as never, kubeOps: {} as never, chartFingerprint: "chart",
      prepareGatewayConfig: vi.fn(async (config: any) => config),
      ensureIsolatedPodHome: vi.fn(async () => {}), reconcileSurgeHandoff: vi.fn(async () => ({ ready: true })), log: vi.fn() };
    const stateDeps: FleetStateDeps = { store };
    return { roots, runtimes, users, operations, deps, helm, stateDeps };
  }

  const POD_PROFILE = { isolation: "isolated", sizingTier: "s", fallbackStorageGb: null, computer: { runtime: "cluster", homeSizeGiB: 10 } };
  const VM_PROFILE = {
    isolation: "isolated", sizingTier: "m", fallbackStorageGb: null,
    computer: { runtime: "gce-vm", desktop: "x11", machineType: "e2-medium", provisioningModel: "STANDARD", bootDisk: { sizeGb: 80, type: "pd-balanced" }, homeSizeGiB: 50 },
  };
  const BUILDER_RELEASE = { profileImages: { builder: { imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder", imageTag: `abc1234@sha256:${"b".repeat(64)}` } } };

  function isolatedPodPass(roots: Record<string, Record<string, unknown>>, runtimes: Record<string, Record<string, unknown>>, sizingProfiles: Record<string, unknown>) {
    const order: string[] = [];
    const helm = {
      upsertInstance: vi.fn(async (opts: Record<string, unknown>) => { order.push(`helm ${String(opts.gatewayId)}`); }),
      readDeployedInstances: vi.fn(async () => ({})),
    };
    const ensureIsolatedPodHome = vi.fn(async (input: { gatewayId: string }) => { order.push(`home ${input.gatewayId}`); });
    const store = fixtureStoreOver({ roots, runtimes, users: { u: {} }, operations: {}, assignments: {},
      config: { orchestrator: { sizingProfiles } },
      releases: Object.fromEntries(Object.keys(roots).map(id => [id, { 2: releaseArtifact(id, 2, "abc1234", BUILDER_RELEASE) }])) });
    const deps = { store, helm: helm as never, kubeOps: {} as never, chartFingerprint: "chart",
      prepareGatewayConfig: vi.fn(async (config: any) => config), ensureIsolatedPodHome,
      reconcileSurgeHandoff: vi.fn(async () => ({ ready: true })), log: vi.fn() };
    const upserted = (gatewayId: string) => (helm.upsertInstance.mock.calls as unknown as Array<[Record<string, unknown>]>)
      .find(([opts]) => opts.gatewayId === gatewayId)?.[0];
    return { deps, helm, ensureIsolatedPodHome, order, upserted };
  }

  it("converges an existing cluster user despite retained GCE VM state", async () => {
    const roots = {
      hobby: durableRoot({ gatewayId: "hobby", gatewayClass: "isolated", profile: null, imageProfile: "isolated", sizingTier: "s", ownerUid: "u", builderSlug: "alice", liveRelease: null }),
      healthy: durableRoot({ gatewayId: "healthy", liveRelease: null }),
    };
    const runtimes: Record<string, Record<string, unknown>> = { hobby: servingRuntime({ gatewayId: "hobby", runtime: "cluster" }) };
    const h = isolatedPodPass(roots, runtimes, { pod: POD_PROFILE });

    await runGatewayConvergencePass(h.deps);
    expect(runtimes.hobby).toMatchObject({ runtime: "cluster" });
    expect(h.helm.upsertInstance.mock.calls.map(([opts]: any) => opts.gatewayId).sort()).toEqual(["healthy", "hobby"]);
    const hobby = h.upserted("hobby")!;
    expect(hobby.builderIdentity).toEqual({ ownerUid: "u", builderSlug: "alice" });
    expect(hobby).not.toHaveProperty("ownerUid");
    expect(hobby).not.toHaveProperty("builderSlug");
    expect(h.upserted("healthy")).not.toHaveProperty("builderIdentity");
  });

  it("gives an isolated gateway that runs as a pod its home claim before Helm, and rolls it by recreate", async () => {
    const roots = {
      pod: durableRoot({ gatewayId: "pod", gatewayClass: "isolated", profile: null, imageProfile: "isolated", sizingTier: "s", ownerUid: "u", builderSlug: "alice", liveRelease: null }),
      healthy: durableRoot({ gatewayId: "healthy", liveRelease: null }),
    };
    const runtimes: Record<string, Record<string, unknown>> = {};
    const h = isolatedPodPass(roots, runtimes, { pod: POD_PROFILE });

    await runGatewayConvergencePass(h.deps);

    expect(runtimes.pod).toMatchObject({ runtime: "cluster" });
    expect(h.ensureIsolatedPodHome).toHaveBeenCalledTimes(1);
    expect(h.ensureIsolatedPodHome).toHaveBeenCalledWith({ gatewayId: "pod", homeSizeGiB: 10, served: false });
    expect(h.order.indexOf("home pod")).toBeLessThan(h.order.indexOf("helm pod"));
    expect(h.upserted("pod")).toMatchObject({ rollStrategy: "recreate" });
    expect(h.upserted("healthy")).toMatchObject({ rollStrategy: "surge" });
  });

  it("neither claims nor checks a pod gateway's home once its runtime mutation stops being allowed during the pass", async () => {
    const roots: Record<string, Record<string, unknown>> = {
      pod: durableRoot({ gatewayId: "pod", gatewayClass: "isolated", profile: null, imageProfile: "isolated", sizingTier: "s", ownerUid: "u", builderSlug: "alice", liveRelease: null }),
    };
    const h = isolatedPodPass(roots, {}, { pod: POD_PROFILE });
    h.ensureIsolatedPodHome.mockRejectedValue(new Error("isolated gateway pod is served but its home claim octogee-gateway-pod-data is missing"));
    const transaction = h.deps.store.transaction.bind(h.deps.store);
    h.deps.store.transaction = (async (options, work) => {
      const result = await transaction(options, work);
      if (options.label === "converge-gateway.upsert-runtime") delete roots.pod;
      return result;
    }) as typeof h.deps.store.transaction;

    await runGatewayConvergencePass(h.deps);

    expect(h.ensureIsolatedPodHome).not.toHaveBeenCalled();
    expect(h.helm.upsertInstance).not.toHaveBeenCalled();
  });

  it.each([
    ["no profile at its tier", { pod: POD_PROFILE }, "isolated gateway pod runs as a pod, and no isolated sizing profile at tier m describes one"],
    ["a VM profile at its tier", { vm: VM_PROFILE }, "isolated gateway pod runs as a pod, but the isolated sizing profile at tier m describes a gce-vm computer"],
  ])("refuses to start a pod gateway with %s", async (_name, sizingProfiles, error) => {
    const roots = {
      pod: durableRoot({ gatewayId: "pod", gatewayClass: "isolated", profile: null, imageProfile: "isolated", sizingTier: "m", ownerUid: "u", builderSlug: "alice", liveRelease: null }),
    };
    const h = isolatedPodPass(roots, { pod: servingRuntime({ gatewayId: "pod", runtime: "cluster" }) }, sizingProfiles);

    await expect(runGatewayConvergencePass(h.deps)).rejects.toThrow(error);
    expect(h.ensureIsolatedPodHome).not.toHaveBeenCalled();
    expect(h.helm.upsertInstance).not.toHaveBeenCalled();
  });

  it("moves past a user whose VM Compute is still creating, so the next converge takes the runtime lock", async () => {
    const roots = {
      creating: durableRoot({ gatewayId: "creating", liveRelease: null }),
      next: durableRoot({ gatewayId: "next", liveRelease: null }),
    };
    const runtimes: Record<string, Record<string, unknown>> = {};
    const store = fixtureStoreOver({ roots, runtimes, users: {}, operations: {}, assignments: {},
      releases: Object.fromEntries(Object.keys(roots).map(id => [id, { 2: releaseArtifact(id, 2, "abc1234") }])) });
    const upsertInstance = vi.fn(async ({ gatewayId }: { gatewayId: string }) => {
      if (gatewayId === "creating") throw new VmCreationPendingError("VM c is being created; converging it once Compute finishes");
    });
    const helm = { upsertInstance, readDeployedInstance: vi.fn(async () => null), readDeployedInstances: vi.fn(async () => ({})) };
    const log = vi.fn();
    const converge = serializeGatewayConvergence((gatewayIds) => runGatewayConvergencePass({ store, helm: helm as never, kubeOps: {} as never,
      chartFingerprint: "chart", prepareGatewayConfig: vi.fn(async (config: any) => config),
      ensureIsolatedPodHome: vi.fn(async () => {}), reconcileSurgeHandoff: vi.fn(async () => ({ ready: true })), log }, gatewayIds));

    await converge(["creating"]);
    await converge(["next"]);
    expect(upsertInstance.mock.calls.map(([opts]) => opts.gatewayId)).toEqual(["creating", "next"]);
    expect(log.mock.calls.flat().filter((line) => String(line).includes("⚠"))).toEqual([]);
  });

  it("holds same-release stale Helm intent until native restore acknowledges user custody", async () => {
    const h = retainedGateway();
    const intent = await beginUserRestore(h.stateDeps, { uid: "u", slug: "alice", gatewayId: "shared-1",
      fromGatewayId: "builder-alice", assignmentEpoch: 3, operationId: "return", claimStartedAt: 100, attemptId: "native" });
    const before = structuredClone(h.runtimes);
    await expect(runGatewayConvergencePass(h.deps)).rejects.toThrow("outcome is unresolved");
    expect(h.helm.upsertInstance).not.toHaveBeenCalled();
    expect(h.runtimes).toEqual(before);
    expect(h.users.u.provisioning.openclaw.restoreFence).toMatchObject({ phase: "dispatched", attemptId: "native" });
    await acknowledgeUserRestore(h.stateDeps, intent);
    await runGatewayConvergencePass(h.deps);
    expect(h.users.u.provisioning.openclaw.restoreFence).toBeUndefined();
    expect(h.operations.return).toMatchObject({ restoreAttempt: { phase: "acknowledged" } });
    expect(h.helm.upsertInstance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ gatewayId: "shared-1", imageTag: "abc1234", replicas: 1 }));
  });

  it("keeps native handoff progress available while user restore custody remains", async () => {
    const h = retainedGateway();
    await runGatewayConvergencePass(h.deps);
    const applied = h.helm.upsertInstance.mock.calls[0][0];
    const instances = await h.helm.readDeployedInstances();
    instances["shared-1"].deploymentIntentFingerprint = String(applied.deploymentIntentFingerprint);
    h.helm.readDeployedInstances.mockResolvedValue(instances);
    h.helm.upsertInstance.mockClear();
    h.users.u.provisioning.openclaw.restoreFence = { phase: "dispatched" };
    await runGatewayConvergencePass(h.deps);
    expect(h.deps.reconcileSurgeHandoff).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ gatewayId: "shared-1" }));
    expect(h.helm.upsertInstance).not.toHaveBeenCalled();
    expect(h.helm.removeInstance).not.toHaveBeenCalled();
    expect(h.users.u.provisioning.openclaw.restoreFence).toEqual({ phase: "dispatched" });
  });

  it.each(["running", "retired"])("orders native restore admission after in-flight Helm work for %s gateways", async desiredStatus => {
    const h = retainedGateway({ desiredStatus });
    const events: string[] = [];
    let releaseHelm!: () => void;
    let helmEntered!: () => void;
    const held = new Promise<void>(resolve => { releaseHelm = resolve; });
    const entered = new Promise<void>(resolve => { helmEntered = resolve; });
    const mutate = async () => {
      events.push("helm-start");
      helmEntered();
      await held;
      expect(h.users.u.provisioning.openclaw.restoreFence).toBeUndefined();
      events.push("helm-end");
    };
    h.helm.upsertInstance.mockImplementation(mutate);
    h.helm.removeInstance.mockImplementation(mutate);
    const converge = serializeGatewayConvergence(() => runGatewayConvergencePass(h.deps));
    const applying = converge();
    await entered;
    const restoring = runGatewayRuntimeExclusive(() => {
      events.push("restore-begin");
      return beginUserRestore(h.stateDeps, { uid: "u", slug: "alice", gatewayId: "shared-1",
        fromGatewayId: "builder-alice", assignmentEpoch: 3, operationId: "return", claimStartedAt: 100, attemptId: "native" });
    });
    await Promise.resolve();
    expect(h.users.u.provisioning.openclaw.restoreFence).toBeUndefined();
    releaseHelm();
    await applying;
    const intent = await restoring;
    expect(events).toEqual(["helm-start", "helm-end", "restore-begin"]);
    expect(desiredStatus === "retired" ? h.helm.removeInstance : h.helm.upsertInstance).toHaveBeenCalledOnce();
    expect(h.users.u.provisioning.openclaw.restoreFence).toMatchObject({ attemptId: "native", phase: "dispatched" });
    await acknowledgeUserRestore(h.stateDeps, intent);
    expect(h.users.u.provisioning.openclaw.restoreFence).toBeUndefined();
  });

  it("keeps acquired user custody after the queue releases until native acknowledgement", async () => {
    const h = retainedGateway();
    const converge = serializeGatewayConvergence(() => runGatewayConvergencePass(h.deps));
    const restoring = runGatewayRuntimeExclusive(() => beginUserRestore(h.stateDeps, { uid: "u", slug: "alice", gatewayId: "shared-1",
      fromGatewayId: "builder-alice", assignmentEpoch: 3, operationId: "return", claimStartedAt: 100, attemptId: "native" }));
    const applying = converge();
    const intent = await restoring;
    await expect(applying).rejects.toThrow("outcome is unresolved");
    expect(h.helm.upsertInstance).not.toHaveBeenCalled();
    await expect(acknowledgeUserRestore(h.stateDeps, { ...intent, attemptId: "wrong" })).rejects.toThrow();
    await expect(converge()).rejects.toThrow("outcome is unresolved");
    await acknowledgeUserRestore(h.stateDeps, intent);
    await converge();
    expect(h.helm.upsertInstance).toHaveBeenCalledOnce();
  });

  it("orders the real operation handler's native restore admission behind Helm and releases before restore work", async () => {
    const h = retainedGateway();
    Object.assign(h.operations.return, { id: "return", status: "pending", startedAt: null, createdAt: 1, steps: [] });
    const events: string[] = [];
    let releaseHelm!: () => void;
    let helmEntered!: () => void;
    let handlerEntered!: () => void;
    const held = new Promise<void>(resolve => { releaseHelm = resolve; });
    const entered = new Promise<void>(resolve => { helmEntered = resolve; });
    const handling = new Promise<void>(resolve => { handlerEntered = resolve; });
    h.helm.upsertInstance.mockImplementation(async () => {
      events.push("helm-start");
      helmEntered();
      await held;
      events.push("helm-end");
    });
    const converge = serializeGatewayConvergence(() => runGatewayConvergencePass(h.deps));
    const applying = converge();
    await entered;
    const handler = vi.fn(async (_op, ctx) => {
      handlerEntered();
      await ctx.withUserRestoreFence({ uid: "u", slug: "alice", gatewayId: "shared-1",
        fromGatewayId: "builder-alice", assignmentEpoch: 3 }, async () => {
        events.push("restore-work");
        expect(h.users.u.provisioning.openclaw.restoreFence).toMatchObject({ phase: "dispatched" });
        await runGatewayRuntimeExclusive(async () => undefined);
      });
      return { success: true, steps: [] };
    });
    const operation = processOperation(h.operations.return as never,
      { ...h.deps, handlers: { "migrate-user": handler } } as never);
    await handling;
    await new Promise<void>(resolve => setImmediate(resolve));
    releaseHelm();
    await Promise.all([applying, operation]);
    expect(events).toEqual(["helm-start", "helm-end", "restore-work"]);
    expect(h.operations.return).toMatchObject({ status: "succeeded", restoreAttempt: { phase: "acknowledged" } });
    expect(h.users.u.provisioning.openclaw.restoreFence).toBeUndefined();
  });

  it("releases the queue after Helm failure so a native restore can acquire its own custody", async () => {
    const h = retainedGateway();
    h.helm.upsertInstance.mockRejectedValue(new Error("Helm failed"));
    const converge = serializeGatewayConvergence(() => runGatewayConvergencePass(h.deps));
    const applying = converge();
    const restoring = runGatewayRuntimeExclusive(() => beginUserRestore(h.stateDeps, { uid: "u", slug: "alice", gatewayId: "shared-1",
      fromGatewayId: "builder-alice", assignmentEpoch: 3, operationId: "return", claimStartedAt: 100, attemptId: "native" }));
    await expect(applying).rejects.toThrow("Helm failed");
    const intent = await restoring;
    expect(h.users.u.provisioning.openclaw.restoreFence).toMatchObject({ attemptId: "native" });
    await acknowledgeUserRestore(h.stateDeps, intent);
  });

  it("rechecks user custody immediately before applying Helm", async () => {
    const h = retainedGateway();
    h.deps.log.mockImplementation((message: string) => {
      if (message.startsWith("[converge-gateway]")) h.users.u.provisioning.openclaw.restoreFence = {};
    });
    await expect(runGatewayConvergencePass(h.deps)).rejects.toThrow("outcome is unresolved");
    expect(h.helm.upsertInstance).not.toHaveBeenCalled();
  });

  it("does not block a gateway for unrelated user custody", async () => {
    const h = retainedGateway();
    h.users.u.provisioning.openclaw = { gatewayId: "elsewhere", restoreFence: {},
      sourceTransferFence: { sourceGatewayId: "elsewhere", targetGatewayId: "another" } };
    await runGatewayConvergencePass(h.deps);
    expect(h.helm.upsertInstance).toHaveBeenCalledOnce();
  });

  it.each(["restore", "malformed-restore", "source", "target", "mirrored-transfer", "restart"])("holds generic Helm convergence for %s custody", async (fence) => {
    const h = retainedGateway();
    const openclaw = h.users.u.provisioning.openclaw;
    if (fence === "restore" || fence === "malformed-restore") openclaw.restoreFence = fence === "restore" ? { phase: "dispatched" } : null;
    if (fence === "source" || fence === "target") {
      openclaw.gatewayId = "elsewhere";
      openclaw.sourceTransferFence = { [fence === "source" ? "sourceGatewayId" : "targetGatewayId"]: "shared-1" };
    }
    if (fence === "mirrored-transfer") openclaw.sourceTransferFence = {};
    if (fence === "restart") h.roots["shared-1"].runtimeRestartFence = {};
    await expect(runGatewayConvergencePass(h.deps)).rejects.toThrow(fence === "malformed-restore" ? "restoreFence is not a map" : "outcome is unresolved");
    expect(h.helm.upsertInstance).not.toHaveBeenCalled();
    expect(h.helm.removeInstance).not.toHaveBeenCalled();
  });

  it.each(["paused", "retired"])("holds %s runtime mutation while user restore custody remains", async (desiredStatus) => {
    const h = retainedGateway({ desiredStatus });
    h.users.u.provisioning.openclaw.restoreFence = {};
    await expect(runGatewayConvergencePass(h.deps)).rejects.toThrow("outcome is unresolved");
    expect(h.helm.upsertInstance).not.toHaveBeenCalled();
    expect(h.helm.removeInstance).not.toHaveBeenCalled();
  });

  it("waits out a pending final home checkpoint quietly while still failing the pass for real errors", async () => {
    const removeInstance = vi.fn(async ({ gatewayId }: { gatewayId: string }) => {
      if (gatewayId === "parking") throw new FinalHomeCheckpointPendingError("VM c is taking its final home checkpoint (requested at 1); parking on a later converge");
      throw new Error("compute API unavailable");
    });
    const log = vi.fn();
    const passDeps = (roots: Record<string, Record<string, unknown>>) => ({
      store: fixtureStoreOver({ roots, runtimes: {}, users: {}, operations: {}, assignments: {} }),
      helm: {
        removeInstance,
        readDeployedInstances: vi.fn(async () => Object.fromEntries(Object.keys(roots).map((gatewayId) => [gatewayId, { enabled: true, image: { repository: "repo", tag: "abc1234" }, gatewayId }]))),
      } as never,
      kubeOps: {} as never,
      chartFingerprint: "chart",
      prepareGatewayConfig: vi.fn(async (config) => config),
      ensureIsolatedPodHome: vi.fn(async () => {}), reconcileSurgeHandoff: vi.fn(async () => ({ ready: true })),
      log,
    });

    await runGatewayConvergencePass(passDeps({ parking: durableRoot({ gatewayId: "parking", desiredStatus: "retired" }) }));
    expect(removeInstance).toHaveBeenCalledWith({ namespace: expect.any(String), gatewayId: "parking" });
    expect(log.mock.calls.flat().filter((line) => String(line).includes("⚠"))).toEqual([]);

    await expect(runGatewayConvergencePass(passDeps({
      parking: durableRoot({ gatewayId: "parking", desiredStatus: "retired" }),
      broken: durableRoot({ gatewayId: "broken", desiredStatus: "retired" }),
    }))).rejects.toThrow("(source=converge-gateway) broken: compute API unavailable");
    expect(log).toHaveBeenCalledWith("[converge-gateway] ⚠ broken: compute API unavailable");
    expect(log.mock.calls.flat().filter((line) => String(line).includes("⚠ parking"))).toEqual([]);
  });
});

describe("gateway convergence observations", () => {
  it("reads only selected Helm releases for targeted convergence", async () => {
    const readDeployedInstances = vi.fn(async () => ({}));
    let activeReads = 0;
    let maxActiveReads = 0;
    const readDeployedInstance = vi.fn(async ({ gatewayId }: { gatewayId: string }) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await Promise.resolve();
      activeReads -= 1;
      return gatewayId === "default"
        ? {
            enabled: true,
            image: { repository: "repo", tag: "abc1234" },
            gatewayId,
          }
        : null;
    });

    await expect(readGatewayConvergenceInstances(
      { readDeployedInstance, readDeployedInstances },
      "octogee-test",
      ["default", "canary"],
    )).resolves.toEqual({
      default: {
        enabled: true,
        image: { repository: "repo", tag: "abc1234" },
        gatewayId: "default",
      },
    });
    expect(readDeployedInstance.mock.calls).toEqual([
      [{ namespace: "octogee-test", gatewayId: "default" }],
      [{ namespace: "octogee-test", gatewayId: "canary" }],
    ]);
    expect(maxActiveReads).toBe(1);
    expect(readDeployedInstances).not.toHaveBeenCalled();
  });
});

describe("startReconciler — durable root authority (GATEWAY-SIMPLE-ROLL-SPEC)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses fleet mutation while a stray (non-runtime) glmGateways doc exists", async () => {
    const callbacks: MirrorFeeds = {};
    const log = vi.fn();
    const syncFleetIngress = vi.fn(async () => {});
    const stop = startReconciler({
      ...reconcilerState({
        roots: { default: durableRoot() },
        runtimes: {
          "default-r2": {
            docKind: "revision",
            revisionId: "default-r2",
            gateway: "default",
            release: 2,
            lifecycle: "serving",
          },
        },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      syncFleetIngress,
      log,
    });

    await runTick(callbacks);
    stop();

    expect(syncFleetIngress).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/stray glmGateway document\(s\): default-r2 \(not a runtime doc of a durable gateway, fields: .*; delete glmGateways\/default-r2\)/),
    );
  });

  it("names deletion for a vm-only stray that no durable root owns", async () => {
    const callbacks: MirrorFeeds = {};
    const log = vi.fn();
    const syncFleetIngress = vi.fn(async () => {});
    const stop = startReconciler({
      ...reconcilerState({
        roots: { default: durableRoot() },
        runtimes: {
          "jefe-s-3e8d49e8": { vm: { status: "TERMINATED", stopReason: "idle", instanceName: "octogee-pool-dd5de412", updatedAt: 1 } },
        },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      syncFleetIngress,
      log,
    });

    await runTick(callbacks);
    stop();

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("stray glmGateway document(s): jefe-s-3e8d49e8 (not a runtime doc of a durable gateway, fields: vm; delete glmGateways/jefe-s-3e8d49e8)"),
    );
  });

  it("refuses fleet mutation for an invalid durable root", async () => {
    const callbacks: MirrorFeeds = {};
    const log = vi.fn();
    const syncFleetIngress = vi.fn(async () => {});
    const stop = startReconciler({
      ...reconcilerState({
        roots: { default: durableRoot(), legacy: { gatewayId: "legacy", desiredStatus: "running" } },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      syncFleetIngress,
      log,
    });

    await runTick(callbacks);
    stop();

    expect(syncFleetIngress).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/legacy.* is malformed/u),
    );
  });

  it("restarts the bare gateway deployment after a model-key change", async () => {
    const callbacks: MirrorFeeds = {};
    const restartGatewayDeployment = vi.fn(async () => {});
    const stop = startReconciler({
      ...reconcilerState({
        roots: {
          default: durableRoot({
            profile: "isolated",
            gatewayClass: "isolated",
            imageProfile: "isolated",
            ownerUid: "uid-b",
            builderSlug: "b",
          }),
        },
        runtimes: { default: servingRuntime() },
        releases: { default: { 2: releaseArtifact("default", 2, "abc1234") } },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      modelKeySecretEnsurer: {
        syncGatewayModelKeySecret: vi.fn(async () => ({ changed: true })),
      } as never,
      restartGatewayDeployment,
      log: vi.fn(),
    });

    await runTick(callbacks);
    stop();

    expect(restartGatewayDeployment).toHaveBeenCalledWith("default");
  });

  it("publishes the fleet ingress from every non-retired durable root", async () => {
    const callbacks: MirrorFeeds = {};
    const syncFleetIngress = vi.fn(async () => {});
    const stop = startReconciler({
      ...reconcilerState({
        roots: {
          default: durableRoot(),
          paused: durableRoot({ gatewayId: "paused", desiredStatus: "paused" }),
          gone: durableRoot({ gatewayId: "gone", desiredStatus: "retired" }),
        },
        runtimes: { default: servingRuntime() },
        releases: {
          default: { 2: releaseArtifact("default", 2, "abc1234") },
          paused: { 2: releaseArtifact("paused", 2, "abc1234") },
        },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      syncFleetIngress,
      log: vi.fn(),
    });

    await runTick(callbacks);
    stop();

    expect(syncFleetIngress).toHaveBeenCalledWith([
      { gatewayId: "default" },
      { gatewayId: "paused" },
    ]);
  });

  it("runs the convergence arm each tick after dependencies sync", async () => {
    const callbacks: MirrorFeeds = {};
    const convergeGateways = vi.fn(async () => {});
    const stop = startReconciler({
      ...reconcilerState({
        roots: { default: durableRoot() },
        runtimes: { default: servingRuntime() },
        releases: { default: { 2: releaseArtifact("default", 2, "abc1234") } },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      convergeGateways,
      log: vi.fn(),
    });

    await runTick(callbacks);
    stop();

    expect(convergeGateways).toHaveBeenCalledTimes(1);
  });

  it("limits runtime changes to targeted gateway convergence", async () => {
    const callbacks: MirrorFeeds = {};
    const syncFleetIngress = vi.fn(async () => {});
    const convergeGateways = vi.fn(async () => {});
    const stop = startReconciler({
      ...reconcilerState({
        roots: { default: durableRoot() },
        runtimes: { default: servingRuntime() },
        releases: { default: { 2: releaseArtifact("default", 2, "abc1234") } },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      syncFleetIngress,
      convergeGateways,
      log: vi.fn(),
    });

    callbacks.fleetRegistry?.(runtimeReset([{
        type: "added",
        doc: { id: "default", data: () => servingRuntime() },
      }]));
    callbacks.gateways?.(rootReset([{
        type: "added",
        doc: { id: "default", data: () => durableRoot() },
      }]));
    await vi.advanceTimersByTimeAsync(1_000);
    syncFleetIngress.mockClear();
    convergeGateways.mockClear();

    callbacks.fleetRegistry?.(runtimeChanges([{
        type: "modified",
        doc: { id: "default", data: () => servingRuntime({ release: 3 }) },
      }]));
    await vi.advanceTimersByTimeAsync(1_000);
    stop();

    expect(convergeGateways).toHaveBeenCalledWith(["default"]);
    expect(syncFleetIngress).not.toHaveBeenCalled();
  });

  it("does not reconcile the fleet when a root doc only records a reconcile error", async () => {
    const callbacks: MirrorFeeds = {};
    const convergeGateways = vi.fn(async () => {});
    const stop = startReconciler({
      ...reconcilerState({
        roots: { default: durableRoot() },
        runtimes: { default: servingRuntime() },
        releases: { default: { 2: releaseArtifact("default", 2, "abc1234") } },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      convergeGateways,
      log: vi.fn(),
    });

    callbacks.gateways?.(rootReset([{
        type: "added",
        doc: { id: "default", data: () => durableRoot() },
      }]));
    await vi.advanceTimersByTimeAsync(1_000);
    convergeGateways.mockClear();

    callbacks.gateways?.(rootChanges([{
        type: "modified",
        doc: {
          id: "default",
          data: () => durableRoot({
            lastError: { slug: "alice", message: "mount failed", at: 2 },
          }),
        },
      }]));
    await vi.advanceTimersByTimeAsync(1_000);
    stop();

    expect(convergeGateways).not.toHaveBeenCalled();
  });

  it("runs a full safety reconciliation only after the configured interval", async () => {
    const callbacks: MirrorFeeds = {};
    const convergeGateways = vi.fn(async () => {});
    const stop = startReconciler({
      ...reconcilerState({
        roots: { default: durableRoot() },
        runtimes: { default: servingRuntime() },
        releases: { default: { 2: releaseArtifact("default", 2, "abc1234") } },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      convergeGateways,
      reconcileSafetyRefreshMs: 5_000,
      log: vi.fn(),
    });

    await runTick(callbacks);
    convergeGateways.mockClear();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(convergeGateways).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_001);
    stop();

    expect(convergeGateways).toHaveBeenCalledTimes(1);
    expect(convergeGateways).toHaveBeenCalledWith(undefined);
  });

  it("logs bounded timing for each reconciliation phase", async () => {
    const callbacks: MirrorFeeds = {};
    const log = vi.fn();
    const stop = startReconciler({
      ...reconcilerState({
        roots: { default: durableRoot() },
        runtimes: { default: servingRuntime() },
        releases: { default: { 2: releaseArtifact("default", 2, "abc1234") } },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      convergeGateways: vi.fn(async () => {}),
      log,
    });

    await runTick(callbacks);
    stop();

    for (const phase of [
      "durable-state",
      "runtime-dependencies",
      "convergence",
      "fleet-ingress",
    ]) {
      expect(log).toHaveBeenCalledWith(
        `[glm-controller] reconcile phase=${phase} started`,
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^\\[glm-controller\\] reconcile phase=${phase} completed durationMs=\\d+$`),
        ),
      );
    }
  });

  it("serializes global and targeted convergence passes", async () => {
    const started: Array<readonly string[] | undefined> = [];
    let releaseFirst: (() => void) | undefined;
    const firstPass = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const converge = serializeGatewayConvergence(async (gatewayIds) => {
      started.push(gatewayIds);
      if (started.length === 1) await firstPass;
    });

    const global = converge();
    const targeted = converge(["default-b"]);
    await Promise.resolve();

    expect(started).toEqual([undefined]);
    releaseFirst?.();
    await Promise.all([global, targeted]);
    expect(started).toEqual([undefined, ["default-b"]]);
  });
  it('serializes runtime recovery with convergence and releases the turn after failure', async () => {
    const events: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const converge = serializeGatewayConvergence(async () => { events.push('converge'); });
    const recovery = converge.runExclusive(async () => { events.push('recover'); await pending; throw new Error('lost reply'); });
    const observed = expect(recovery).rejects.toThrow('lost reply');
    const next = converge();
    await Promise.resolve();
    expect(events).toEqual(['recover']);
    release(); await observed; await next;
    expect(events).toEqual(['recover', 'converge']);
  });
});

describe("startReconciler — targeted gateways ahead of a queued full reconcile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function userRoot(gatewayId: string): Record<string, unknown> {
    return durableRoot({
      gatewayId,
      profile: "isolated",
      gatewayClass: "isolated",
      imageProfile: "isolated",
      ownerUid: `uid-${gatewayId}`,
      builderSlug: gatewayId,
      liveRelease: null,
    });
  }

  function startRecordingReconciler(options: { reconcileSafetyRefreshMs?: number } = {}) {
    const callbacks: MirrorFeeds = {};
    const events: string[] = [];
    const roots: Record<string, Record<string, unknown>> = { default: durableRoot() };
    const stop = startReconciler({
      ...reconcilerState({ roots, runtimes: { default: servingRuntime() }, callbacks }),
      helm: {} as never,
      handlers: {} as never,
      modelKeySourceIssuer: {
        syncGatewayModelKeySource: async ({ gatewayId }: { gatewayId: string }) => {
          events.push(`source:${gatewayId}`);
          return { gatewayId, changed: false, action: "unchanged" };
        },
      } as never,
      modelKeySecretEnsurer: {
        syncGatewayModelKeySecret: async ({ gatewayId }: { gatewayId: string }) => {
          events.push(`secret:${gatewayId}`);
          return { changed: false };
        },
      } as never,
      convergeGateways: async (gatewayIds?: readonly string[]) => {
        events.push(`converge:${gatewayIds?.join(",") ?? "fleet"}`);
      },
      ...options,
      log: vi.fn(),
    });
    return { callbacks, events, roots, stop };
  }

  async function primeListeners(callbacks: MirrorFeeds): Promise<void> {
    callbacks.gateways?.(rootReset([{ type: "added", doc: { id: "default", data: () => durableRoot() } }]));
    callbacks.fleetRegistry?.(runtimeReset([{ type: "added", doc: { id: "default", data: () => servingRuntime() } }]));
    await vi.advanceTimersByTimeAsync(1_000);
  }

  async function openUserLease(): Promise<string[]> {
    const { callbacks, events, roots, stop } = startRecordingReconciler();
    await primeListeners(callbacks);
    events.length = 0;

    roots.fresh = userRoot("fresh");
    callbacks.gateways?.(rootChanges([{ type: "added", doc: { id: "fresh", data: () => roots.fresh } }]));
    await vi.advanceTimersByTimeAsync(1_000);
    stop();
    return events;
  }

  it("converges a newly allocated user before the fleet's runtime dependencies sync", async () => {
    const events = await openUserLease();

    expect(events).toContain("converge:fresh");
    expect(events.indexOf("converge:fresh")).toBeLessThan(events.indexOf("source:default"));
    expect(events.at(-1)).toBe("converge:fleet");
  });

  it("syncs a targeted gateway's model-key source and secret before converging it", async () => {
    const events = await openUserLease();

    expect(events.slice(0, events.indexOf("converge:fresh"))).toEqual([
      "source:fresh",
      "secret:fresh",
    ]);
  });

  it("does not resync the targeted gateways' dependencies in the same tick's full pass", async () => {
    const events = await openUserLease();

    expect(events.filter((event) => event.endsWith(":fresh"))).toEqual([
      "source:fresh",
      "secret:fresh",
      "converge:fresh",
    ]);
  });

  it("keeps a runtime change queued behind a pending full reconcile and converges it first", async () => {
    const { callbacks, events, stop } = startRecordingReconciler({ reconcileSafetyRefreshMs: 5_000 });
    await primeListeners(callbacks);
    await vi.advanceTimersByTimeAsync(4_500);
    events.length = 0;

    callbacks.fleetRegistry?.(runtimeChanges([{
        type: "modified",
        doc: { id: "default", data: () => servingRuntime({ release: 3 }) },
      }]));
    await vi.advanceTimersByTimeAsync(1_000);
    stop();

    expect(events.filter((event) => event.startsWith("converge:"))).toEqual([
      "converge:default",
      "converge:fleet",
    ]);
  });

  it("converges a gateway once when its recheck delay passes", async () => {
    const { callbacks, events, stop } = startRecordingReconciler();
    await primeListeners(callbacks);
    events.length = 0;

    requestGatewayRecheck("default");
    requestGatewayRecheck("default");
    await vi.advanceTimersByTimeAsync(14_000);
    const beforeDelay = events.filter((event) => event.startsWith("converge:"));
    await vi.advanceTimersByTimeAsync(2_000);
    stop();

    expect(beforeDelay).toEqual([]);
    expect(events.filter((event) => event.startsWith("converge:"))).toEqual(["converge:default"]);
  });

  it("drops a pending recheck when the reconciler stops", async () => {
    const { callbacks, events, stop } = startRecordingReconciler();
    await primeListeners(callbacks);
    events.length = 0;

    requestGatewayRecheck("default");
    stop();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(events).toEqual([]);
  });

  it("reconciles the whole fleet once from the listeners' first deliveries", async () => {
    const { callbacks, events, stop } = startRecordingReconciler();
    await primeListeners(callbacks);
    stop();

    expect(events.filter((event) => event.startsWith("converge:"))).toEqual(["converge:fleet"]);
  });
});
