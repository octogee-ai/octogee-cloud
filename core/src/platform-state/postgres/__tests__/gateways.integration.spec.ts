import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
import { releasePayloadHash } from "@octogee/shared/types/gateway-releases";
import type { GatewayVmRuntimeBundle } from "@octogee/shared/types/glm";
import { parseAssignmentDoc } from "../../../assignment-doc.js";
import { initialGatewayReleaseDocuments } from "../../../gateway-live-release.js";
import {
  AlreadyExistsError,
  DuplicateRecordError,
  FenceMismatchError,
  MalformedRecordError,
  MissingRecordError,
} from "../../errors.js";
import type { AppendGatewayReleaseInput, GatewayAssignment, GatewayRoot, GatewayRuntimeRestartFenceValue } from "../../gateways.js";
import type { WatchChange, WatchEvent } from "../../store.js";
import { createHarness, dsn, recordingListener, type PlatformStateHarness, type RecordingListener } from "./fixtures/harness.js";

const NOW = 1_762_500_000_000;
const ARTIFACT = { imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway", imageTag: "753c212" };
const WAIT = { timeout: 20_000, interval: 20 };
const ALLOCATION = { kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-1", generation: 3, claimedByUid: "uid-ceckert" } as const;

function mutableConfig(overrides: Partial<GatewayMutableConfig> = {}): GatewayMutableConfig {
  return {
    configSchemaVersion: 1,
    profile: "isolated",
    gatewayClass: "isolated",
    imageProfile: "isolated",
    sizingTier: "l",
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: { controlUiEnabled: true },
    ownerUid: "uid-ceckert",
    builderSlug: "ceckert",
    modelBrokerLimits: null,
    ...overrides,
  };
}

function initialDocuments(gatewayId: string, config: Partial<GatewayMutableConfig> = {}) {
  return initialGatewayReleaseDocuments({
    gatewayId,
    config: mutableConfig(config),
    artifact: ARTIFACT,
    createdBy: "glm-controller",
    now: NOW,
    desiredStatus: "running",
  });
}

function rootFor(gatewayId: string, overrides: Partial<GatewayRoot> = {}, config: Partial<GatewayMutableConfig> = {}): GatewayRoot {
  return { ...initialDocuments(gatewayId, config).gatewayDoc, ...overrides };
}

const SHARED_CONFIG: Partial<GatewayMutableConfig> = {
  gatewayClass: "shared",
  profile: null,
  imageProfile: "standard",
  ownerUid: null,
  builderSlug: null,
  builderAccess: null,
  sizingTier: null,
};

function assignment(gatewayId: string, uid: string, overrides: Partial<GatewayAssignment> = {}): GatewayAssignment {
  return {
    uid,
    slug: uid,
    gatewayId,
    source: "onboarding",
    state: "serving",
    epoch: 1,
    createdAt: NOW,
    updatedAt: NOW,
    updatedByOperationId: "op-place",
    ...overrides,
  };
}

function appendInput(gatewayId: string, overrides: Partial<AppendGatewayReleaseInput> = {}): AppendGatewayReleaseInput {
  const payload = { ...ARTIFACT, imageTag: "8a1b2c3" };
  return {
    gatewayId,
    expectedLatestRelease: 1,
    createdAt: NOW + 5,
    createdBy: "admin:ops",
    sourceRelease: 1,
    note: "roll",
    payload,
    payloadHash: releasePayloadHash(payload),
    activate: false,
    updatedBy: "admin:ops",
    ...overrides,
  };
}

function vmBundle(gatewayId: string): GatewayVmRuntimeBundle {
  return {
    version: "1",
    gatewayId,
    imageRepository: ARTIFACT.imageRepository,
    imageTag: ARTIFACT.imageTag,
    init: null,
    containers: [{ name: "gateway", image: "gateway:1", env: {}, command: null, args: null, mounts: [] }],
    volumes: [{ name: "state", kind: "emptyDir" }],
    hostAliases: {},
    kubernetes: { apiHost: "10.0.0.1", apiPort: "443", caCert: "ca" },
    renderedAt: NOW,
  };
}

function restartFence(attemptId: string): GatewayRuntimeRestartFenceValue {
  return { attemptId, gatewayId: "walter", kind: "source-recovery", phase: "dispatched", startedAt: NOW };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function changeKeys<A extends "gateways" | "assignments">(listener: RecordingListener<A>): string[] {
  return listener.events
    .flatMap((event: WatchEvent<A>) => (event.kind === "changes" ? [...event.changes] : []))
    .map((change: WatchChange<A>) => `${change.type}:${change.key}`);
}

describe.skipIf(!dsn)("PostgreSQL gateway repositories", { timeout: 30_000 }, () => {
  let harness: PlatformStateHarness;
  const roots = () => harness.store.gateways.roots;
  const releases = () => harness.store.gateways.releases;
  const assignments = () => harness.store.gateways.assignments;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function users(...uids: string[]): Promise<void> {
    for (const uid of uids) await harness.query("INSERT INTO $schema.users (uid) VALUES ($1::text)", [uid]);
  }

  async function mint(gatewayId: string, config: Partial<GatewayMutableConfig> = {}): Promise<void> {
    const { gatewayDoc, releaseDoc } = initialDocuments(gatewayId, config);
    await harness.store.transaction({ label: "mint gateway" }, async (tx) => {
      await tx.gateways.roots.create(gatewayDoc);
      await tx.gateways.releases.createInitial(releaseDoc);
    });
  }

  async function rowCount(table: string, gatewayId: string): Promise<number> {
    const [row] = await harness.query(`SELECT count(*)::int AS count FROM $schema.${table} WHERE gateway_id = $1::text`, [gatewayId]);
    return row.count as number;
  }

  describe("roots", () => {
    it("mints a root with its first release and reads both back exactly as built", async () => {
      await mint("walter");
      const { gatewayDoc, releaseDoc } = initialDocuments("walter");

      expect(await roots().get("walter")).toEqual({ ...gatewayDoc, revision: expect.stringMatching(/^\d+$/) });
      expect(await releases().get("walter", 1)).toEqual(releaseDoc);
      expect(await roots().get("ghost")).toBeNull();
      expect(await failure(roots().create(gatewayDoc))).toBeInstanceOf(AlreadyExistsError);
    });

    it("round-trips every optional root field, keeping a null retirement claim apart from an absent one", async () => {
      const full: GatewayRoot = rootFor(
        "walter",
        {
          liveRelease: 1,
          retireAfter: NOW + 60_000,
          retirementVersion: 2,
          retirementClaim: null,
          runtimeRestartFence: restartFence("a"),
          lastError: { slug: "ceckert", message: "boom", at: NOW },
          lastPreStopFlush: { podName: "pod-1", at: NOW },
          configBackfill: { sourceRelease: 1, sourcePayloadHash: "hash", at: NOW },
        },
        {
          allocation: ALLOCATION,
          gcpProject: "octogee-test",
          gatewayContainerSecurityContext: { runAsUser: 1000 },
          serviceAccountName: "octogee-gw-walter",
          serviceAccount: { create: true, annotations: { "iam.gke.io/gcp-service-account": "gw@octogee.iam" } },
          modelBrokerLimits: { spendWindowUsd: 5, requestsPerMinute: 60 },
        },
      );
      await roots().create(full);
      await roots().create(rootFor("flexo"));

      const { revision: _revision, ...stored } = (await roots().get("walter"))!;
      expect(stored).toEqual(full);
      expect(await roots().get("flexo")).not.toHaveProperty("retirementClaim");
      expect(await roots().get("flexo")).not.toHaveProperty("allocation");
    });

    it("reads a null preemption as absent and refuses any other value", async () => {
      await roots().create({ ...rootFor("walter"), preemption: null });
      expect(await roots().get("walter")).not.toHaveProperty("preemption");

      expect(await failure(roots().patch("walter", { preemption: "spot" as never }))).toBeInstanceOf(MalformedRecordError);
    });

    it("writes lastError.at as server time, null as null, and a clear as an absent field", async () => {
      await roots().create(rootFor("walter"));

      await roots().patch("walter", { lastError: { slug: "ceckert", message: "boom", at: { serverNow: true } } });
      const stamped = (await roots().get("walter"))?.lastError;
      expect(stamped).toEqual({ slug: "ceckert", message: "boom", at: expect.any(Number) });
      expect(Math.abs((stamped?.at ?? 0) - Date.now())).toBeLessThan(60_000);

      await roots().patch("walter", { lastError: null }, { lastErrorSlug: "ceckert" });
      expect((await roots().get("walter"))?.lastError).toBeNull();

      await roots().patch("walter", { lastError: { clear: true } });
      expect(await roots().get("walter")).not.toHaveProperty("lastError");
    });

    it("refuses to patch a missing root, fenced or not", async () => {
      expect(await failure(roots().patch("ghost", { desiredStatus: "paused" }))).toBeInstanceOf(MissingRecordError);
      expect(await failure(roots().patch("ghost", { desiredStatus: "paused" }, { updatedAt: NOW }))).toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "gateway", key: "ghost" },
      });
    });

    it("refuses to change the root's identity or its release counter through a patch", async () => {
      await roots().create(rootFor("walter"));
      expect(await failure(roots().patch("walter", { latestRelease: 9 } as never))).toBeInstanceOf(TypeError);
      expect(await failure(roots().patch("walter", { createdBy: "someone" } as never))).toBeInstanceOf(TypeError);
    });

    it("applies a patch whose fences match and names the first fence that does not", async () => {
      await roots().create(rootFor("walter", { retirementVersion: 2 }, { allocation: ALLOCATION }));
      const current = await roots().get("walter");

      await roots().patch(
        "walter",
        { desiredStatus: "paused", updatedAt: NOW + 1 },
        {
          revision: current?.revision,
          updatedAt: NOW,
          latestRelease: 1,
          retirementVersion: 2,
          desiredStatus: ["running"],
          allocationGeneration: 3,
        },
      );
      expect(await roots().get("walter")).toMatchObject({ desiredStatus: "paused", updatedAt: NOW + 1 });

      const mismatches = await Promise.all([
        failure(roots().patch("walter", { updatedAt: NOW + 2 }, { revision: current?.revision })),
        failure(roots().patch("walter", { updatedAt: NOW + 2 }, { updatedAt: NOW })),
        failure(roots().patch("walter", { updatedAt: NOW + 2 }, { latestRelease: 2 })),
        failure(roots().patch("walter", { updatedAt: NOW + 2 }, { retirementVersion: null })),
        failure(roots().patch("walter", { updatedAt: NOW + 2 }, { desiredStatus: ["running"] })),
        failure(roots().patch("walter", { updatedAt: NOW + 2 }, { allocationGeneration: 4 })),
        failure(roots().patch("walter", { updatedAt: NOW + 2 }, { lastErrorSlug: "ceckert" })),
      ]);
      expect(mismatches.map((error) => (error as FenceMismatchError).fence)).toEqual([
        "revision",
        "updatedAt",
        "latestRelease",
        "retirementVersion",
        "status",
        "generation",
        "present",
      ]);
      for (const error of mismatches) expect(error).toBeInstanceOf(FenceMismatchError);
      expect(mismatches[3]).toMatchObject({ expected: null, actual: 2 });
      expect(mismatches[6]).toMatchObject({ expected: "ceckert", actual: null });
      expect((await roots().get("walter"))?.updatedAt).toBe(NOW + 1);
    });

    it("matches an absent retirementVersion or allocation against a null fence", async () => {
      await roots().create(rootFor("walter"));
      await roots().patch("walter", { retirementVersion: 1 }, { retirementVersion: null, allocationGeneration: null });
      expect((await roots().get("walter"))?.retirementVersion).toBe(1);
    });

    it("sets, replaces and clears the disposable isolated allocation", async () => {
      await roots().create(rootFor("walter"));

      await roots().patch("walter", { allocation: ALLOCATION });
      expect((await roots().get("walter"))?.allocation).toEqual(ALLOCATION);

      await roots().patch("walter", { allocation: { ...ALLOCATION, generation: 4 } }, { allocationGeneration: 3 });
      expect((await roots().get("walter"))?.allocation).toMatchObject({ generation: 4 });

      await roots().patch("walter", { allocation: null });
      expect(await roots().get("walter")).not.toHaveProperty("allocation");

      expect(await failure(roots().patch("walter", { allocation: { ...ALLOCATION, kind: "other" } as never }))).toBeInstanceOf(
        MalformedRecordError,
      );
    });

    it("compares and sets the runtime restart fence from the expected value only", async () => {
      await roots().create(rootFor("walter"));

      await roots().compareAndSetRuntimeRestartFence("walter", null, restartFence("a"));
      expect((await roots().get("walter"))?.runtimeRestartFence).toEqual(restartFence("a"));

      const stale = await failure(roots().compareAndSetRuntimeRestartFence("walter", restartFence("b"), restartFence("c")));
      expect(stale).toMatchObject({ constructor: FenceMismatchError, fence: "runtimeRestartFence", actual: restartFence("a") });
      expect(await failure(roots().compareAndSetRuntimeRestartFence("walter", null, restartFence("c")))).toBeInstanceOf(FenceMismatchError);

      const reordered = { startedAt: NOW, phase: "dispatched", kind: "source-recovery", gatewayId: "walter", attemptId: "a" };
      await roots().compareAndSetRuntimeRestartFence("walter", reordered, null);
      expect(await roots().get("walter")).not.toHaveProperty("runtimeRestartFence");
      expect(await failure(roots().compareAndSetRuntimeRestartFence("ghost", null, restartFence("a")))).toBeInstanceOf(MissingRecordError);
    });

    it("finds a root by service account name and refuses two", async () => {
      await roots().create(rootFor("walter", {}, { serviceAccountName: "octogee-gw-walter" }));
      expect((await roots().findByServiceAccountName("octogee-gw-walter"))?.gatewayId).toBe("walter");
      expect(await roots().findByServiceAccountName("nobody")).toBeNull();

      await roots().create(rootFor("flexo", {}, { serviceAccountName: "octogee-gw-walter" }));
      expect(await failure(roots().findByServiceAccountName("octogee-gw-walter"))).toMatchObject({
        constructor: DuplicateRecordError,
        aggregate: "gateway",
        lookup: "serviceAccountName",
        keysFound: ["flexo", "walter"],
      });
    });

    it("lists by gateway class and owner and reads many by id", async () => {
      await roots().create(rootFor("walter"));
      await roots().create(rootFor("flexo", {}, { ownerUid: "uid-flexo", builderSlug: "flexo" }));
      await roots().create(rootFor("shared-a", {}, SHARED_CONFIG));

      expect((await roots().list({ gatewayClass: "shared" })).map((root) => root.gatewayId)).toEqual(["shared-a"]);
      expect((await roots().list({ ownerUid: "uid-flexo" })).map((root) => root.gatewayId)).toEqual(["flexo"]);
      expect((await roots().list({ gatewayClass: "isolated", ownerUid: "uid-flexo" })).map((root) => root.gatewayId)).toEqual(["flexo"]);
      expect((await roots().list()).map((root) => root.gatewayId)).toEqual(["flexo", "shared-a", "walter"]);
      expect([...(await roots().getMany(["walter", "ghost", "flexo"])).keys()].sort()).toEqual(["flexo", "walter"]);
      expect((await roots().getMany([])).size).toBe(0);
    });

    it("deletes a fenced root and cascades its releases and assignments, leaving its VM runtime bundle", async () => {
      await users("uid-ceckert");
      await mint("walter");
      await roots().patch("walter", { retirementVersion: 4 });
      await assignments().put(assignment("walter", "uid-ceckert"));
      await harness.store.gateways.vmRuntime.put("walter", vmBundle("walter"));

      expect(await failure(roots().delete("walter", { retirementVersion: 3 }))).toBeInstanceOf(FenceMismatchError);
      expect(await roots().get("walter")).not.toBeNull();
      expect(await failure(roots().delete("ghost", { retirementVersion: 3 }))).toBeInstanceOf(MissingRecordError);

      await roots().delete("walter", { retirementVersion: 4 });
      expect(await roots().get("walter")).toBeNull();
      expect(await rowCount("gateway_releases", "walter")).toBe(0);
      expect(await rowCount("gateway_assignments", "walter")).toBe(0);
      expect(await harness.store.gateways.vmRuntime.get("walter")).not.toBeNull();
      await roots().delete("walter");
    });

    it("deletes a root with children inside a transaction through the cascade", async () => {
      await users("uid-flexo");
      await mint("flexo");
      await assignments().put(assignment("flexo", "uid-flexo"));

      await harness.store.transaction({ label: "delete parent" }, async (tx) => {
        expect(await tx.gateways.assignments.isEmpty("flexo")).toBe(false);
        await tx.gateways.roots.delete("flexo");
      });

      expect(await roots().get("flexo")).toBeNull();
      expect(await rowCount("gateway_releases", "flexo")).toBe(0);
      expect(await rowCount("gateway_assignments", "flexo")).toBe(0);
    });
  });

  describe("releases", () => {
    it("appends the next release under the latestRelease fence and activates it only when asked", async () => {
      await mint("walter");
      const input = appendInput("walter");

      expect(await releases().append(input)).toBe(2);
      expect(await releases().get("walter", 2)).toEqual({
        gatewayId: "walter",
        release: 2,
        createdAt: NOW + 5,
        createdBy: "admin:ops",
        sourceRelease: 1,
        note: "roll",
        payloadHash: input.payloadHash,
        payload: input.payload,
      });
      expect(await roots().get("walter")).toMatchObject({ latestRelease: 2, desiredRelease: 1, updatedAt: NOW + 5, updatedBy: "admin:ops" });

      expect(await releases().append(appendInput("walter", { expectedLatestRelease: 2, createdAt: NOW + 6, note: null, activate: true }))).toBe(3);
      expect(await roots().get("walter")).toMatchObject({ latestRelease: 3, desiredRelease: 3, updatedAt: NOW + 6 });
    });

    it("refuses an append against a stale latestRelease and writes nothing", async () => {
      await mint("walter");

      const stale = await failure(releases().append(appendInput("walter", { expectedLatestRelease: 2, activate: true })));

      expect(stale).toMatchObject({ constructor: FenceMismatchError, fence: "latestRelease", expected: 2, actual: 1 });
      expect(await releases().get("walter", 3)).toBeNull();
      expect(await roots().get("walter")).toMatchObject({ latestRelease: 1, desiredRelease: 1, updatedAt: NOW });
    });

    it("deletes every release of one gateway and leaves other gateways alone", async () => {
      await mint("walter");
      await mint("fry");
      await releases().append(appendInput("walter"));

      await roots().deleteChildren("walter");

      expect(await releases().list("walter", "asc")).toEqual([]);
      expect((await releases().list("fry", "asc")).map((release) => release.release)).toEqual([1]);
    });

    it("lets exactly one of two concurrent appends at the same latestRelease win", async () => {
      await mint("walter");

      const results = await Promise.allSettled([releases().append(appendInput("walter")), releases().append(appendInput("walter"))]);

      expect(results.filter((result) => result.status === "fulfilled")).toEqual([{ status: "fulfilled", value: 2 }]);
      const [rejected] = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(rejected.reason).toBeInstanceOf(FenceMismatchError);
      expect((await releases().list("walter", "asc")).map((release) => release.release)).toEqual([1, 2]);
    });

    it("refuses to append to a missing root", async () => {
      expect(await failure(releases().append(appendInput("ghost")))).toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "gateway", key: "ghost" },
      });
    });

    it("rolls an append back when a later write in the same transaction fails", async () => {
      await mint("walter");

      const failed = await failure(
        harness.store.transaction({ label: "append then fail" }, async (tx) => {
          await tx.gateways.releases.append(appendInput("walter"));
          await tx.gateways.roots.patch("walter", { desiredStatus: "paused" }, { retirementVersion: 9 });
        }),
      );

      expect(failed).toBeInstanceOf(FenceMismatchError);
      expect(await roots().get("walter")).toMatchObject({ latestRelease: 1, desiredStatus: "running" });
      expect(await releases().get("walter", 2)).toBeNull();
    });

    it("lists releases in either order with a limit", async () => {
      await mint("walter");
      await releases().append(appendInput("walter"));
      await releases().append(appendInput("walter", { expectedLatestRelease: 2 }));

      expect((await releases().list("walter", "desc", 2)).map((release) => release.release)).toEqual([3, 2]);
      expect((await releases().list("walter", "asc")).map((release) => release.release)).toEqual([1, 2, 3]);
      expect(await releases().list("ghost", "asc")).toEqual([]);
    });

    it("creates an initial release once, replaces it, and refuses one beyond the root's latest release", async () => {
      await roots().create(rootFor("walter"));
      const { releaseDoc } = initialDocuments("walter");

      await releases().createInitial(releaseDoc);
      expect(await failure(releases().createInitial(releaseDoc))).toMatchObject({
        constructor: AlreadyExistsError,
        record: { aggregate: "gateway-release", key: "walter/1" },
      });

      await releases().replace({ ...releaseDoc, note: "rewritten" });
      expect((await releases().get("walter", 1))?.note).toBe("rewritten");

      expect(await failure(releases().createInitial({ ...releaseDoc, release: 2 }))).toMatchObject({ code: "23514" });
      expect(await releases().get("walter", 2)).toBeNull();
      expect(await failure(releases().createInitial({ ...releaseDoc, gatewayId: "ghost" }))).toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "gateway", key: "ghost" },
      });
    });

    it("reads a hash-verified retired Mac payload through the in-memory schema upgrade and refuses an unverifiable one", async () => {
      await roots().create(rootFor("walter"));
      const legacy = { ...ARTIFACT, macOpsTokenProtocol: { version: 1 } };
      await harness.query(
        `INSERT INTO $schema.gateway_releases (gateway_id, release, created_at, created_by, source_release, note, payload_hash, payload)
         VALUES ('walter', 1, $1::bigint, 'admin:ops', NULL, NULL, $2::text, $3::jsonb)`,
        [NOW, releasePayloadHash(legacy as never), JSON.stringify(legacy)],
      );

      expect(await releases().get("walter", 1)).toMatchObject({ payload: ARTIFACT, payloadHash: releasePayloadHash(ARTIFACT) });
      const [stored] = await harness.query("SELECT payload FROM $schema.gateway_releases WHERE gateway_id = 'walter' AND release = 1");
      expect(JSON.parse(stored.payload as string)).toEqual(legacy);

      await harness.query("UPDATE $schema.gateway_releases SET payload_hash = 'tampered' WHERE gateway_id = 'walter'");
      expect(await failure(releases().get("walter", 1))).toBeInstanceOf(MalformedRecordError);
    });
  });

  describe("assignments", () => {
    beforeEach(async () => {
      await users("uid-a", "uid-b", "uid-ceckert");
      await roots().create(rootFor("walter"));
      await roots().create(rootFor("flexo"));
    });

    it("puts the full assignment that parseAssignmentDoc reads back unchanged", async () => {
      const doc = assignment("walter", "uid-ceckert", {
        state: "quiescing",
        epoch: 4,
        updatedByOperationId: "op-surge",
        handoffProgress: [{ phase: "copy", status: "running", at: NOW, migrationId: "mig-1", slug: "uid-ceckert", source: "shared-0" }],
        sharedSurgeForwardRecovery: { operationId: "op-surge", targetPodUid: "pod-t", receivingPodUid: "pod-r" },
      });
      await assignments().put(doc);

      const stored = await assignments().get("walter", "uid-ceckert");
      const { revision, ...record } = stored!;
      expect(record).toEqual(doc);
      expect(revision).toMatch(/^\d+$/);
      expect(parseAssignmentDoc("uid-ceckert", record)).toEqual(doc);
      expect(await assignments().get("walter", "uid-none")).toBeNull();
    });

    it("replaces the whole assignment on put, dropping fields the new one lacks", async () => {
      await assignments().put(
        assignment("walter", "uid-a", { handoffProgress: [{ phase: "copy", status: "done", at: NOW, migrationId: "m", slug: "uid-a", source: "s" }] }),
      );
      await assignments().put(assignment("walter", "uid-a", { epoch: 2 }));

      const stored = await assignments().get("walter", "uid-a");
      expect(stored).toMatchObject({ epoch: 2 });
      expect(stored).not.toHaveProperty("handoffProgress");
    });

    it("reads an inconsistent shared surge marker as malformed", async () => {
      await assignments().put(
        assignment("walter", "uid-a", {
          state: "serving",
          sharedSurgeForwardRecovery: { operationId: "op-surge", targetPodUid: "pod-t", receivingPodUid: "pod-r" },
        }),
      );
      expect(await failure(assignments().get("walter", "uid-a"))).toMatchObject({
        constructor: MalformedRecordError,
        record: { aggregate: "gateway-assignment", key: "walter/uid-a" },
      });
    });

    it("creates an assignment once and refuses one whose gateway or user is missing", async () => {
      await assignments().create(assignment("walter", "uid-a"));

      expect(await failure(assignments().create(assignment("walter", "uid-a")))).toMatchObject({
        constructor: AlreadyExistsError,
        record: { aggregate: "gateway-assignment", key: "walter/uid-a" },
      });
      expect(await failure(assignments().create(assignment("ghost", "uid-a")))).toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "gateway", key: "ghost" },
      });
      expect(await failure(assignments().put(assignment("walter", "uid-stranger")))).toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "builder", key: "uid-stranger" },
      });
    });

    it("finds an assignment by slug within one gateway and refuses a second assignment with that slug", async () => {
      await assignments().put(assignment("walter", "uid-a", { slug: "ceckert" }));
      expect((await assignments().findBySlug("walter", "ceckert"))?.uid).toBe("uid-a");
      expect(await assignments().findBySlug("flexo", "ceckert")).toBeNull();

      expect(await failure(assignments().put(assignment("walter", "uid-b", { slug: "ceckert" })))).toMatchObject({
        constructor: DuplicateRecordError,
        aggregate: "gateway-assignment",
        lookup: "gateway_id, slug",
        value: "walter, ceckert",
      });
      await assignments().put(assignment("flexo", "uid-b", { slug: "ceckert" }));
    });

    it("reads assignments across gateways by uid, by slug, and all of them, also inside a transaction", async () => {
      await assignments().put(assignment("walter", "uid-a", { slug: "ceckert" }));
      await assignments().put(assignment("flexo", "uid-a", { slug: "ceckert", state: "quiescing" }));
      await assignments().put(assignment("flexo", "uid-b"));
      const keys = (records: readonly GatewayAssignment[]) => records.map((record) => `${record.gatewayId}/${record.uid}`);

      expect(keys(await assignments().listForUid("uid-a"))).toEqual(["flexo/uid-a", "walter/uid-a"]);
      expect(keys(await assignments().listForSlug("ceckert"))).toEqual(["flexo/uid-a", "walter/uid-a"]);
      expect(keys(await assignments().listAll())).toEqual(["flexo/uid-a", "flexo/uid-b", "walter/uid-a"]);
      expect(
        keys(await harness.store.transaction({ label: "group read", readOnly: true }, (tx) => tx.gateways.assignments.listForUid("uid-a"))),
      ).toEqual(["flexo/uid-a", "walter/uid-a"]);
    });

    it("lists one gateway's roster with a limit and reports whether it is empty", async () => {
      expect(await assignments().isEmpty("walter")).toBe(true);
      await assignments().put(assignment("walter", "uid-b"));
      await assignments().put(assignment("walter", "uid-a"));
      await assignments().put(assignment("flexo", "uid-ceckert"));

      expect(await assignments().isEmpty("walter")).toBe(false);
      expect((await assignments().list("walter")).map((record) => record.uid)).toEqual(["uid-a", "uid-b"]);
      expect(await assignments().list("walter", 1)).toHaveLength(1);
    });

    it("patches and deletes under epoch, state and updatedAt fences", async () => {
      await assignments().put(assignment("walter", "uid-a", { epoch: 2, state: "quiescing" }));
      const current = await assignments().get("walter", "uid-a");

      await assignments().patch(
        "walter",
        "uid-a",
        { state: "serving", epoch: 3, updatedAt: NOW + 1 },
        { revision: current?.revision, epoch: 2, state: ["quiescing"], updatedAt: NOW },
      );
      expect(await assignments().get("walter", "uid-a")).toMatchObject({ state: "serving", epoch: 3, updatedAt: NOW + 1 });

      const mismatches = await Promise.all([
        failure(assignments().patch("walter", "uid-a", { epoch: 9 }, { revision: current?.revision })),
        failure(assignments().patch("walter", "uid-a", { epoch: 9 }, { epoch: 2 })),
        failure(assignments().patch("walter", "uid-a", { epoch: 9 }, { state: ["migrating"] })),
        failure(assignments().delete("walter", "uid-a", { updatedAt: NOW })),
      ]);
      expect(mismatches.map((error) => (error as FenceMismatchError).fence)).toEqual(["revision", "epoch", "status", "updatedAt"]);
      expect(mismatches[1]).toMatchObject({ expected: 2, actual: 3 });

      expect(await failure(assignments().patch("walter", "uid-a", { createdAt: 1 } as never))).toBeInstanceOf(TypeError);
      await assignments().delete("walter", "uid-a", { epoch: 3 });
      expect(await assignments().get("walter", "uid-a")).toBeNull();
      expect(await failure(assignments().patch("walter", "uid-a", { epoch: 4 }))).toBeInstanceOf(MissingRecordError);
      expect(await failure(assignments().delete("walter", "uid-a", { epoch: 4 }))).toBeInstanceOf(MissingRecordError);
      await assignments().delete("walter", "uid-a");
    });

    it("loses a user's assignments when the user row is deleted", async () => {
      await assignments().put(assignment("walter", "uid-a"));
      await assignments().put(assignment("flexo", "uid-a"));

      await harness.query("DELETE FROM $schema.users WHERE uid = 'uid-a'");

      expect(await assignments().listForUid("uid-a")).toEqual([]);
    });
  });

  describe("VM runtime", () => {
    it("replaces and deletes the whole bundle", async () => {
      await harness.store.gateways.vmRuntime.put("walter", vmBundle("walter"));
      expect(await harness.store.gateways.vmRuntime.get("walter")).toEqual({ ...vmBundle("walter"), revision: expect.any(String) });

      await harness.store.gateways.vmRuntime.put("walter", { ...vmBundle("walter"), imageTag: "8a1b2c3" });
      expect((await harness.store.gateways.vmRuntime.get("walter"))?.imageTag).toBe("8a1b2c3");

      await harness.store.gateways.vmRuntime.delete("walter");
      expect(await harness.store.gateways.vmRuntime.get("walter")).toBeNull();
    });

    it("refuses a bundle for another gateway and reads a foreign stored bundle as malformed", async () => {
      expect(await failure(harness.store.gateways.vmRuntime.put("walter", vmBundle("flexo")))).toBeInstanceOf(MalformedRecordError);

      await harness.query("INSERT INTO $schema.gateway_vm_runtime (gateway_id, bundle) VALUES ('walter', $1::jsonb)", [
        JSON.stringify(vmBundle("flexo")),
      ]);
      expect(await failure(harness.store.gateways.vmRuntime.get("walter"))).toBeInstanceOf(MalformedRecordError);
    });
  });

  describe("watches", () => {
    it("delivers a root snapshot, then additions, modifications and removals", async () => {
      await roots().create(rootFor("walter"));
      const all = recordingListener<"gateways">();
      const one = recordingListener<"gateways">();
      harness.store.watch({ aggregate: "gateways", filter: {} }, all);
      harness.store.watch({ aggregate: "gateways", filter: { gatewayId: "walter" } }, one);

      await vi.waitFor(() => expect(all.events[0]).toMatchObject({ kind: "snapshot", records: [expect.objectContaining({ gatewayId: "walter" })] }), WAIT);
      await vi.waitFor(() => expect(one.events[0]).toMatchObject({ kind: "snapshot", records: [expect.objectContaining({ gatewayId: "walter" })] }), WAIT);
      await roots().create(rootFor("flexo"));
      await vi.waitFor(() => expect(changeKeys(all)).toEqual(["added:flexo"]), WAIT);
      await roots().patch("walter", { desiredStatus: "paused" });
      await vi.waitFor(() => expect(changeKeys(all)).toEqual(["added:flexo", "modified:walter"]), WAIT);
      await roots().delete("flexo");
      await vi.waitFor(() => expect(changeKeys(all)).toEqual(["added:flexo", "modified:walter", "removed:flexo"]), WAIT);

      const modified = all.events.flatMap((event) => (event.kind === "changes" ? [...event.changes] : []))[1];
      expect(modified.record).toMatchObject({ desiredStatus: "paused" });
      await vi.waitFor(() => expect(changeKeys(one)).toEqual(["modified:walter"]), WAIT);
      expect(all.errors).toEqual([]);
    });

    it("follows one gateway's assignments and every gateway's assignments keyed by gateway and uid", async () => {
      await users("uid-a");
      await roots().create(rootFor("walter"));
      await roots().create(rootFor("flexo"));
      await assignments().put(assignment("walter", "uid-a"));
      const one = recordingListener<"assignments">();
      const all = recordingListener<"assignments">();
      harness.store.watch({ aggregate: "assignments", filter: { gatewayId: "walter" } }, one);
      harness.store.watch({ aggregate: "assignments", filter: {} }, all);

      await vi.waitFor(() => expect(one.events[0]).toMatchObject({ kind: "snapshot", records: [expect.objectContaining({ uid: "uid-a" })] }), WAIT);
      await vi.waitFor(() => expect(all.events[0]).toMatchObject({ kind: "snapshot" }), WAIT);
      await assignments().put(assignment("flexo", "uid-a"));
      await vi.waitFor(() => expect(changeKeys(all)).toEqual(["added:flexo/uid-a"]), WAIT);
      await assignments().patch("walter", "uid-a", { epoch: 2 });
      await vi.waitFor(() => expect(changeKeys(all)).toEqual(["added:flexo/uid-a", "modified:walter/uid-a"]), WAIT);
      await vi.waitFor(() => expect(changeKeys(one)).toEqual(["modified:walter/uid-a"]), WAIT);
      await assignments().delete("walter", "uid-a");
      await vi.waitFor(() => expect(changeKeys(one)).toEqual(["modified:walter/uid-a", "removed:walter/uid-a"]), WAIT);
      expect(one.errors).toEqual([]);
    });
  });
});
