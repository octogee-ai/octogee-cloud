import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { releasePayloadHash, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { SHARED_POOL_SCALER_CREATOR } from "@octogee/shared/types/shared-gateway-pool";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { createAdminFleetMutationRunner } from "./admin-fleet-router.js";
import { addAdminSharedPoolRoutes, readFleetState } from "./admin-shared-pool-router.js";
import type { GatewayKubernetesReader } from "./fleet-state-sections.js";
import type { PlatformStateStore } from "./platform-state/store.js";

type Data = Record<string, unknown>;

const records = new Map<string, Data>();
const NOW = 2_000_000;
const CONTROLLER_STARTED_AT = 100;
const PLATFORM: ReleasePayload = { imageRepository: "registry.example/gateway", imageTag: `abc1234@sha256:${"a".repeat(64)}` };
const PREVIOUS: ReleasePayload = { imageRepository: "registry.example/gateway", imageTag: `def5678@sha256:${"d".repeat(64)}` };

const reader: GatewayKubernetesReader = (runtime) => runtime === null
  ? { kubernetes: { status: "unknown", totalPods: null, readyPods: null, ageMs: null }, kubernetesObservedAt: null }
  : { kubernetes: { status: "ready", totalPods: 1, readyPods: 1, ageMs: 5 }, kubernetesObservedAt: NOW - 5 };

function store(): PlatformStateStore {
  return createDocumentFixtureStore(records, { serializeTransactions: true });
}

function app(options: { platformStore?: PlatformStateStore; readGatewayKubernetes?: GatewayKubernetesReader } = {}) {
  const platformStore = options.platformStore ?? store();
  const server = express();
  server.use(express.json());
  addAdminSharedPoolRoutes(server, {
    store: platformStore,
    platformArtifact: PLATFORM,
    controllerStartedAt: CONTROLLER_STARTED_AT,
    journal: createAdminFleetMutationRunner(platformStore),
    now: () => NOW,
    ...(options.readGatewayKubernetes ? { readGatewayKubernetes: options.readGatewayKubernetes } : {}),
  });
  server.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return server;
}

function root(gatewayId: string, overrides: Data = {}): Data {
  return {
    gatewayId, createdAt: 1, createdBy: SHARED_POOL_SCALER_CREATOR, updatedAt: 10, updatedBy: "test", configSchemaVersion: 1,
    profile: null, gatewayClass: "shared", imageProfile: "standard", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: null, builderSlug: null, modelBrokerLimits: null, allocation: null,
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running", ...overrides,
  };
}

function seedGateway(gatewayId: string, overrides: Data = {}, payload: ReleasePayload = PLATFORM, withRuntime = true): void {
  records.set(`gateways/${gatewayId}`, root(gatewayId, overrides));
  records.set(`gateways/${gatewayId}/releases/1`, {
    gatewayId, release: 1, createdAt: 1, createdBy: "test", sourceRelease: null, note: null, payloadHash: releasePayloadHash(payload), payload,
  });
  if (withRuntime) {
    records.set(`glmGateways/${gatewayId}`, {
      docKind: "runtime", gatewayId, release: 1, lifecycle: "serving",
      helm: { imageRepository: payload.imageRepository, imageTag: payload.imageTag },
      heartbeat: { status: "ready", version: "abc1234", mountedCustomers: [], lastHeartbeatAt: NOW },
    });
  }
}

const LEASE = { leaseId: "lease-1", generation: 2, status: "provisioning", targetGatewayId: "gw-isolated", sourceGatewayId: "shared-aaaaaaaaaaaa", sourceAssignmentEpoch: 3 };

function seedUsers(): void {
  records.set("users/uid-a", {
    username: "alice",
    onboardingStep: "complete",
    accountLifecycle: { status: "active" },
    provisioning: {
      status: "complete",
      openclaw: {
        gatewayId: "shared-aaaaaaaaaaaa", gatewayProfile: "standard", status: "complete", managedBy: "operator",
        activationLease: LEASE, migration: { operationId: "op-m" }, runtimeReset: { operationId: "op-r" },
        greeting: { sent: true },
      },
      computer: { instanceId: "vm-1" },
      homeMigration: { step: "copy" },
      homeStorage: { bytes: 10 },
      homeCapacity: { gb: 30 },
      homeErasure: [{ at: 1 }],
      computerRecovery: { operationId: "op-c", gatewayId: "gw-isolated" },
    },
  });
  records.set("users/uid-b", { username: "bob", onboardingStep: "complete", provisioning: { status: "complete" } });
}

function seedOperations(): void {
  records.set("glmOperations/migrate-pending", { kind: "migrate-user", status: "pending", createdBy: "x", createdAt: 1, input: { uid: "uid-a" }, steps: [] });
  records.set("glmOperations/migrate-running", { kind: "migrate-user", status: "running", createdBy: "x", createdAt: 2, startedAt: 3, input: { uid: "uid-b" }, steps: [] });
  records.set("glmOperations/migrate-done", { kind: "migrate-user", status: "succeeded", createdBy: "x", createdAt: 1, input: { uid: "uid-a" }, steps: [] });
  records.set("glmOperations/restart-pending", { kind: "restart-gateway", status: "pending", createdBy: "x", createdAt: 1, input: { gatewayId: "shared-aaaaaaaaaaaa" }, steps: [] });
}

function seedFleet(): void {
  seedGateway("shared-aaaaaaaaaaaa");
  seedGateway("shared-bbbbbbbbbbbb", {}, PREVIOUS);
  seedGateway("shared-cccccccccccc", { desiredStatus: "draining" });
  seedGateway("gw-isolated", { gatewayClass: "isolated", profile: "builder", ownerUid: "uid-a" }, PLATFORM, false);
  records.set("gateways/shared-aaaaaaaaaaaa/assignments/uid-a", {
    uid: "uid-a", gatewayId: "shared-aaaaaaaaaaaa", slug: "alice", source: "repair", state: "serving", epoch: 3, createdAt: 1, updatedAt: 1, updatedByOperationId: null,
  });
  records.set("glmControllerState/sharedPoolScaler", { schemaVersion: 1, actionSequence: 3, lastActionAt: 5, replacements: [] });
  seedUsers();
  seedOperations();
}

beforeEach(() => {
  records.clear();
  records.set("config/orchestrator", { sharedGatewayAutoscaling: { enabled: true, buildersPerGateway: 4 } });
});

describe("GET /fleet/state sections", () => {
  it("answers without sections exactly as the full read did", async () => {
    seedFleet();
    const platformStore = store();

    const res = await request(app({ platformStore, readGatewayKubernetes: reader })).get("/fleet/state").expect(200);

    const expected = await readFleetState(platformStore, {
      operationStatuses: ["pending", "running"],
      platformArtifact: PLATFORM,
      controllerStartedAt: CONTROLLER_STARTED_AT,
      now: NOW,
    });
    expect(res.text).toBe(JSON.stringify(expected));
  });

  it("answers only the requested sections, in the canonical section order", async () => {
    seedFleet();

    const res = await request(app()).get("/fleet/state?sections=assignments,config").expect(200);

    expect(Object.keys(res.body)).toEqual(["generatedAt", "fleetControllerStartedAt", "sections", "config", "assignments"]);
    expect(res.body).toMatchObject({ generatedAt: NOW, fleetControllerStartedAt: CONTROLLER_STARTED_AT, sections: ["config", "assignments"] });
    expect(res.body.assignments).toEqual([expect.objectContaining({ uid: "uid-a", gatewayId: "shared-aaaaaaaaaaaa", epoch: 3 })]);
  });

  it.each(["", "users,bogus", "users,,config"])("refuses the selector %j", async (sections) => {
    const res = await request(app()).get(`/fleet/state?sections=${sections}`).expect(400);
    expect(res.body.error).toContain("sections must be a comma-separated list of config, sharedPoolAutomation, users, gateways, releases, assignments, runtimes, operations, migrations");
  });

  it("refuses a repeated selector parameter", async () => {
    await request(app()).get("/fleet/state?sections=users&sections=config").expect(400);
  });

  it("answers each user with the activation lease, home, fences and gateway mirror the placement dispatch reads", async () => {
    seedFleet();

    const res = await request(app()).get("/fleet/state?sections=users").expect(200);

    expect(res.body.users).toEqual([
      {
        uid: "uid-a",
        slug: "alice",
        admitted: true,
        accountLifecycle: { status: "active" },
        provisioning: { status: "complete" },
        gateway: { gatewayId: "shared-aaaaaaaaaaaa", gatewayProfile: "standard" },
        openclaw: { status: "complete", managedBy: "operator" },
        activationLease: LEASE,
        fences: {
          computerRecovery: { operationId: "op-c", gatewayId: "gw-isolated" },
          migration: { operationId: "op-m" },
          runtimeReset: { operationId: "op-r" },
        },
        home: {
          computer: { instanceId: "vm-1" },
          homeStorage: { bytes: 10 },
          homeMigration: { step: "copy" },
          homeErasure: [{ at: 1 }],
          homeCapacity: { gb: 30 },
        },
      },
      {
        uid: "uid-b",
        slug: "bob",
        admitted: true,
        accountLifecycle: null,
        provisioning: { status: "complete" },
        gateway: null,
        openclaw: {},
        activationLease: null,
        fences: {},
        home: {},
      },
    ]);
  });

  it("answers each gateway with its Kubernetes reading and the time it was observed", async () => {
    seedFleet();
    const readGatewayKubernetes = vi.fn(reader);

    const res = await request(app({ readGatewayKubernetes })).get("/fleet/state?sections=gateways").expect(200);

    const byId = Object.fromEntries(res.body.gateways.map((gateway: Data) => [gateway.gatewayId, gateway]));
    expect(byId["shared-aaaaaaaaaaaa"]).toMatchObject({
      desiredStatus: "running",
      kubernetes: { status: "ready", totalPods: 1, readyPods: 1, ageMs: 5 },
      kubernetesObservedAt: NOW - 5,
    });
    expect(byId["gw-isolated"]).toMatchObject({
      kubernetes: { status: "unknown", totalPods: null, readyPods: null, ageMs: null },
      kubernetesObservedAt: null,
    });
    expect(readGatewayKubernetes).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "shared-aaaaaaaaaaaa" }), NOW);
    expect(readGatewayKubernetes).toHaveBeenCalledWith(null, NOW);
  });

  it("answers every gateway's Kubernetes reading as unknown when this server has no observer", async () => {
    seedFleet();

    const res = await request(app()).get("/fleet/state?sections=gateways").expect(200);

    for (const gateway of res.body.gateways as Data[]) {
      expect(gateway).toMatchObject({
        kubernetes: { status: "unknown", totalPods: null, readyPods: null, ageMs: null },
        kubernetesObservedAt: null,
      });
    }
  });

  it("answers the release hashes and the shared gateways whose latest release is the platform artifact", async () => {
    seedFleet();

    const res = await request(app()).get("/fleet/state?sections=releases").expect(200);

    expect(res.body).toMatchObject({
      platformArtifactHash: releasePayloadHash(PLATFORM),
      latestReleasePayloadHashes: {
        "shared-aaaaaaaaaaaa": releasePayloadHash(PLATFORM),
        "shared-bbbbbbbbbbbb": releasePayloadHash(PREVIOUS),
        "shared-cccccccccccc": releasePayloadHash(PLATFORM),
      },
      platformCurrentSharedGatewayIds: ["shared-aaaaaaaaaaaa", "shared-cccccccccccc"],
    });
  });

  it("answers active migrations whatever operation statuses the caller asked for", async () => {
    seedFleet();

    const res = await request(app()).get("/fleet/state?sections=migrations,operations&operationStatus=succeeded").expect(200);

    expect(res.body.migrations.map((operation: Data) => operation.id).sort()).toEqual(["migrate-pending", "migrate-running"]);
    expect(res.body.operations.map((operation: Data) => operation.id)).toEqual(["migrate-done"]);
  });

  it("reads only the records its sections need", async () => {
    seedFleet();
    const platformStore = store();
    const reads: string[] = [];
    const tracked: PlatformStateStore = {
      ...platformStore,
      transaction: (options, run) => platformStore.transaction(options, (transaction) => run(new Proxy(transaction, {
        get(target, area: string) {
          const value = Reflect.get(target, area) as unknown;
          return typeof value === "object" && value !== null ? tracking(value, area, reads) : value;
        },
      }))),
    } as PlatformStateStore;

    await request(app({ platformStore: tracked })).get("/fleet/state?sections=config").expect(200);

    expect(reads.filter((read) => read !== "config.orchestrator.get")).toEqual([]);
  });
});

function tracking(value: object, path: string, reads: string[]): object {
  return new Proxy(value, {
    get(target, key: string) {
      const member = Reflect.get(target, key) as unknown;
      if (typeof member === "function") {
        return (...args: unknown[]) => {
          reads.push(`${path}.${key}`);
          return (member as (...input: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof member === "object" && member !== null ? tracking(member, `${path}.${key}`, reads) : member;
    },
  });
}
