import { describe, expect, it } from "vitest";
import {
  DuplicateRecordError,
  FenceMismatchError,
  MissingRecordError,
  UnsupportedOperationError,
} from "../../errors.js";
import { lease, NOW, uids, useUserFixture, type UserFixture } from "./fixtures/users.js";
import { dsn } from "./fixtures/harness.js";

const BOB_SITE = "octogee-bob-site";

async function seedFleet({ records, place, harness }: UserFixture): Promise<void> {
  await records.create({ uid: "alice", createdAt: NOW });
  await records.admit("alice", { slug: "alice", persona: null, createdAt: NOW, provisioningStartedAt: NOW });
  await records.patch("alice", {
    role: "admin",
    mattermostUserId: "mm-alice",
    openclaw: { status: "complete", agentId: "octogee-alice-coach" },
    home: { computer: { instanceId: "i-alice", gatewayId: "alice-s-1" } as never },
  });
  await place("alice", "g1");

  await records.create({ uid: "bob", createdAt: NOW + 1 });
  await records.admit("bob", { slug: "bob", persona: null, createdAt: NOW, provisioningStartedAt: NOW });
  await records.patch("bob", { openclaw: { status: "provisioning" } });
  await records.addAgents("bob", ["octogee-bob-coach", BOB_SITE]);
  await records.setFence("bob", "sourceTransferFence", { sourceGatewayId: "g2", targetGatewayId: "g1" }, "absent");
  await place("bob", "g1");

  await records.create({ uid: "carol", createdAt: NOW + 2 });
  await records.patch("carol", { slug: "carol", openclaw: { status: "complete" } });
  await records.setFence("carol", "computerRecovery", { operationId: "op-recover", gatewayId: "g1" });

  await harness.query("INSERT INTO $schema.users (uid, slug) VALUES ('dave', 'dave')");
  await records.patch("dave", { openclaw: { agentId: BOB_SITE } });
  await records.addAgents("dave", [BOB_SITE]);
}

describe.skipIf(!dsn)("PostgreSQL user records: queries", () => {
  const fixture = useUserFixture();

  it("answers each lookup and returns the role with every record", async () => {
    const { records } = fixture();
    await seedFleet(fixture());

    expect(await records.findBySlug("alice")).toMatchObject({ uid: "alice", role: "admin" });
    expect((await records.findBySlug("bob"))!.uid).toBe("bob");
    expect(await records.findBySlug("nobody")).toBeNull();
    expect((await records.findByMattermostUserId("mm-alice"))!.uid).toBe("alice");
    expect(await records.findByMattermostUserId("mm-nobody")).toBeNull();
    expect((await records.findByVmInstanceId("i-alice"))!.uid).toBe("alice");
    expect(await records.findByVmInstanceId("i-none")).toBeNull();

    const many = await records.getMany(["alice", "missing", "bob", "alice"]);
    expect([...many.keys()].sort()).toEqual(["alice", "bob"]);
    expect(many.get("alice")!.role).toBe("admin");
    expect(await records.getMany([])).toEqual(new Map());
  });

  it("finds users by primary agent id or by roster, with each source bounded by the limit", async () => {
    const { records } = fixture();
    await seedFleet(fixture());

    expect(uids(await records.listByAgentId("octogee-alice-coach", 10))).toEqual(["alice"]);
    expect(uids(await records.listByAgentId(BOB_SITE, 10))).toEqual(["bob", "dave"]);
    expect(uids(await records.listByAgentId(BOB_SITE, 1))).toEqual(["bob", "dave"]);
    expect(uids(await records.listByAgentId("octogee-bob-coach", 10))).toEqual(["bob"]);
    expect(await records.listByAgentId("octogee-nobody", 10)).toEqual([]);
  });

  it("lists by gateway, admission and OpenClaw status", async () => {
    const { records } = fixture();
    await seedFleet(fixture());

    expect(uids(await records.listByGateway("g1"))).toEqual(["alice", "bob"]);
    expect(uids(await records.listByGateway("g1", { openclawStatus: "complete" }))).toEqual(["alice"]);
    expect(await records.listByGateway("g1", { limit: 1 })).toHaveLength(1);
    expect(await records.listByGateway("g9")).toEqual([]);
    expect(uids(await records.listAdmitted())).toEqual(["alice", "bob"]);
    expect(uids(await records.listByOpenClawStatus("complete"))).toEqual(["alice", "carol"]);
  });

  it("returns the four gateway fence holder sets from one read", async () => {
    const { records } = fixture();
    await seedFleet(fixture());

    const holders = await records.listGatewayFenceHolders("g1");
    expect({
      assigned: uids(holders.assigned),
      sourceTransferSource: uids(holders.sourceTransferSource),
      sourceTransferTarget: uids(holders.sourceTransferTarget),
      computerRecovery: uids(holders.computerRecovery),
    }).toEqual({ assigned: ["alice", "bob"], sourceTransferSource: [], sourceTransferTarget: ["bob"], computerRecovery: ["carol"] });
    expect(holders.assigned.find((record) => record.uid === "alice")!.role).toBe("admin");
    expect(uids((await records.listGatewayFenceHolders("g2")).sourceTransferSource)).toEqual(["bob"]);
  });

  it("lists every user including unadmitted records without createdAt and retains roles", async () => {
    const { records } = fixture();
    await seedFleet(fixture());

    const all = await records.listAll();
    expect(uids(all)).toEqual(["alice", "bob", "carol", "dave"]);
    expect(all.find((record) => record.uid === "alice")!.role).toBe("admin");
    expect(all.find((record) => record.uid === "dave")!.createdAt).toBeNull();
  });

  it("lists newest first by createdAt with records lacking one last, and pages with a uid cursor", async () => {
    const { records, harness } = fixture();
    await seedFleet(fixture());
    await harness.query("INSERT INTO $schema.users (uid) VALUES ('erin')");

    const first = await records.list({ limit: 2 });
    expect(first.items.map((record) => record.uid)).toEqual(["carol", "bob"]);
    expect(first.next).toBe("bob");
    const second = await records.list({ limit: 2, after: first.next! });
    expect(second.items.map((record) => record.uid)).toEqual(["alice", "erin"]);
    expect(second.items[0].role).toBe("admin");
    expect(second.items[1].createdAt).toBeNull();
    expect(second.next).toBe("erin");
    const third = await records.list({ limit: 2, after: second.next! });
    expect(third.items.map((record) => record.uid)).toEqual(["dave"]);
    expect(third.next).toBeNull();
    expect((await records.list({ limit: 10 })).items.map((record) => record.uid)).toEqual(["carol", "bob", "alice", "erin", "dave"]);
    expect(await records.list({ limit: 2, after: "dave" })).toEqual({ items: [], next: null });
    await expect(records.list({ limit: 2, after: "gone" })).rejects.toMatchObject({
      constructor: MissingRecordError, record: { aggregate: "builder", key: "gone" },
    });
  });
});

describe.skipIf(!dsn)("PostgreSQL user records: uniqueness", () => {
  const fixture = useUserFixture();

  it("refuses a second user with the same slug, Mattermost user or VM instance", async () => {
    const { records } = fixture();
    await seedFleet(fixture());
    await records.create({ uid: "eve", createdAt: NOW });

    await expect(records.patch("eve", { slug: "alice" })).rejects.toMatchObject({
      constructor: DuplicateRecordError, aggregate: "builder", lookup: "slug", value: "alice", keysFound: ["eve"],
    });
    await expect(records.patch("eve", { mattermostUserId: "mm-alice" })).rejects.toMatchObject({
      constructor: DuplicateRecordError, lookup: "mattermostUserId", value: "mm-alice",
    });
    await expect(records.patch("eve", { home: { computer: { instanceId: "i-alice" } as never } })).rejects.toMatchObject({
      constructor: DuplicateRecordError, lookup: "vmInstanceId", value: "i-alice",
    });
    await expect(records.admit("eve", { slug: "bob", persona: null, createdAt: NOW, provisioningStartedAt: NOW })).rejects.toMatchObject({
      constructor: DuplicateRecordError, lookup: "slug", value: "bob",
    });
    expect(await records.get("eve")).toMatchObject({ slug: null, mattermostUserId: null, admitted: false, home: {} });
  });

  it("frees a unique value once its holder clears it", async () => {
    const { records } = fixture();
    await seedFleet(fixture());
    await records.create({ uid: "eve", createdAt: NOW });

    await records.patch("alice", { mattermostUserId: { clear: true }, home: { computer: { clear: true } } });
    await records.patch("eve", { mattermostUserId: "mm-alice", home: { computer: { instanceId: "i-alice" } as never } });
    expect((await records.findByMattermostUserId("mm-alice"))!.uid).toBe("eve");
    expect((await records.findByVmInstanceId("i-alice"))!.uid).toBe("eve");
  });
});

describe.skipIf(!dsn)("PostgreSQL user records: transactions", () => {
  const fixture = useUserFixture();

  it("reads fence holders and records before a transaction's writes and refuses any read after them", async () => {
    const { records, store } = fixture();
    await seedFleet(fixture());

    await store.transaction({ label: "activate" }, async (tx) => {
      const holders = await tx.users.records.listGatewayFenceHolders("g1");
      const alice = (await tx.users.records.get("alice"))!;
      expect(uids(holders.computerRecovery)).toEqual(["carol"]);
      expect(alice.role).toBe("admin");
      await tx.users.records.setActivationLease("alice", lease(), { leaseId: null, generation: null });
      await tx.users.records.patch("alice", { home: { homeStorage: { admittedAt: NOW } } });
    });
    expect(await records.get("alice")).toMatchObject({ activationLease: lease(), home: { homeStorage: { admittedAt: NOW } } });

    await expect(
      store.transaction({ label: "read-late" }, async (tx) => {
        await tx.users.records.patch("bob", { workspaceId: "bob" });
        await tx.users.records.listByGateway("g1");
      }),
    ).rejects.toMatchObject({ constructor: UnsupportedOperationError, operation: "builders.records.listByGateway", reason: "read-after-write" });
    await expect(
      store.transaction({ label: "read-only", readOnly: true }, (tx) => tx.users.records.addAgents("bob", ["octogee-bob-extra"])),
    ).rejects.toMatchObject({ constructor: UnsupportedOperationError, reason: "write-in-read-only-transaction" });
    expect((await records.get("bob"))!.workspaceId).toBeNull();
  });

  it("checks a second fenced write to the same user against the first and rolls both back on a mismatch", async () => {
    const { records, store } = fixture();
    await seedFleet(fixture());

    await expect(
      store.transaction({ label: "fence-twice" }, async (tx) => {
        const bob = (await tx.users.records.get("bob"))!;
        await tx.users.records.setFence("bob", "restoreFence", { operationId: "op-restore" }, "absent");
        await tx.users.records.patch("bob", { workspaceId: "bob" }, { revision: bob.revision });
      }),
    ).rejects.toMatchObject({ constructor: FenceMismatchError, fence: "revision" });

    const bob = (await records.get("bob"))!;
    expect(bob.workspaceId).toBeNull();
    expect(bob.fences).not.toHaveProperty("restoreFence");
  });

  it("commits roster and record writes together or not at all", async () => {
    const { records, store } = fixture();
    await seedFleet(fixture());

    await expect(
      store.transaction({ label: "roster" }, async (tx) => {
        await tx.users.records.addAgents("bob", ["octogee-bob-extra"]);
        await tx.users.records.setActivatedAgents("bob", ["coach", "extra"]);
        throw new Error("abandon");
      }),
    ).rejects.toThrow("abandon");
    expect((await records.get("bob"))!.agents).toEqual({ agentIds: ["octogee-bob-coach", BOB_SITE], activatedAgents: [] });
  });
});

describe.skipIf(!dsn)("PostgreSQL user records: deletion", () => {
  const fixture = useUserFixture();

  it("round trips a fenced native export without queuing it for the legacy schedule restorer", async () => {
    const { users } = fixture();
    await seedFleet(fixture());
    const transfer = { migrationId: "mig-1", slug: "bob", sourceGatewayId: "g2", targetGatewayId: "g1",
      records: [], skipped: [], snapshotAt: NOW };
    const nativeExport = { agentIds: ["octogee-bob-coach"], snapshot: { jobs: [], scratch: [] } };
    await users.scheduleTransfers.put("bob", { ...transfer, nativeExport });
    await users.scheduleTransfers.put("bob", { ...transfer, migrationId: "legacy" });

    expect(await users.scheduleTransfers.get("bob", transfer.migrationId)).toMatchObject({ nativeExport });
    expect((await users.scheduleTransfers.listUnrestored()).map(({ transfer }) => transfer.migrationId)).toEqual(["legacy"]);
  });

  it("deletes the user with its roster, child records and assignments, and leaves other users alone", async () => {
    const { records, users, count, row } = fixture();
    await seedFleet(fixture());
    await users.placementReceipts.create("bob", {
      schemaVersion: 1, kind: "activated", at: NOW, builderSlug: "bob", leaseId: "lease-1", generation: 1, cause: null, sizingTier: null,
      entitlementTier: null, gatewayId: "g1", sharedGatewayId: null, requestedAt: null, wakeDurationMs: null, activeDurationMs: null,
      operationId: null, retirementOperationId: null, operatorTerminated: false, error: null,
    });
    await users.scheduleTransfers.put("bob", {
      migrationId: "mig-1", slug: "bob", sourceGatewayId: "g2", targetGatewayId: "g1", records: [], skipped: [], snapshotAt: NOW,
    });
    await users.agentStores.put("bob", {
      kind: "gateway-state", storeId: "store-1", schema: "gateway_state", gatewayId: "g1", generation: 1, assignmentEpoch: null, recordedAt: NOW,
    });

    await records.delete("bob");

    expect(await records.get("bob")).toBeNull();
    for (const table of ["user_agents", "placement_receipts", "schedule_transfers", "agent_stores", "gateway_assignments"]) {
      expect(await count(table, "bob"), table).toBe(0);
    }
    expect(await row("gateway_assignments", "uid = $1::text", ["alice"])).toBeDefined();
    expect((await records.get("alice"))!.gateway).toMatchObject({ gatewayId: "g1" });
    await records.delete("bob");
  });

  it("deletes inside a transaction together with the transaction's other writes", async () => {
    const { records, store, count } = fixture();
    await seedFleet(fixture());

    await store.transaction({ label: "erase" }, async (tx) => {
      await tx.users.records.delete("dave");
      await tx.users.records.patch("alice", { workspaceId: "alice" });
    });
    expect(await records.get("dave")).toBeNull();
    expect(await count("user_agents", "dave")).toBe(0);
    expect((await records.get("alice"))!.workspaceId).toBe("alice");
  });
});
