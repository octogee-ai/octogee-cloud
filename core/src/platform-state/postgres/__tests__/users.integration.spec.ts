import { describe, expect, it } from "vitest";
import type { PlatformUserRecord } from "../../users.js";
import { FenceMismatchError, MalformedRecordError, MissingRecordError } from "../../errors.js";
import { DAY, lease, NOW, REVISION, useUserFixture } from "./fixtures/users.js";
import { dsn } from "./fixtures/harness.js";

const MISSING_USER = { constructor: MissingRecordError, record: { aggregate: "builder", key: "nobody" } };

describe.skipIf(!dsn)("PostgreSQL user records: round trip", () => {
  const fixture = useUserFixture();

  it("returns every platform field the write methods store", async () => {
    const { records, place } = fixture();
    const restoreFence = { operationId: "op-restore", gatewayId: "shared-a", requestedAt: NOW };
    const sourceTransferFence = { operationId: "op-move", sourceGatewayId: "alice-s-1", targetGatewayId: "shared-a", reservedAt: NOW };
    const computerRecovery = { operationId: "op-recover", gatewayId: "alice-s-1", instanceId: "i-1", sharedGatewayId: "shared-a", assignmentEpoch: 3 };
    const migration = { state: "moving" as const, phase: "transferring" as const, operationId: "op-move", startedAt: NOW };
    const retirement = { operationId: "op-return", gatewayId: "alice-s-1", requestedAt: NOW };
    const runtimeReset = {
      status: "pending" as const, uid: "alice", slug: "alice", operationId: "op-reset", sourceGatewayId: "alice-s-1",
      targetGatewayId: "shared-a", generation: 2, disposableLeaseId: "lease-1", disposableLeaseGeneration: 1, requestedAt: NOW,
    };
    const home = {
      computer: { instanceName: "alice-vm", zone: "us-central1-a", instanceId: "i-alice", gatewayId: "alice-s-1", parkedAt: NOW } as never,
      homeCheckpoint: { name: "c-1", size: 10, sha256: "abc", instanceId: "i-alice", completedAt: NOW },
      homeDisk: { id: "123", bootImage: { name: "image-1" } },
      homeStorage: { runtime: "gce-vm", layout: "portable", retained: [], admittedAt: NOW },
      homeMigration: { state: "copying" },
      homeErasure: [{ diskId: "old-1", requestedAt: NOW }],
      homeCapacity: { desiredGiB: 20, allocatedGiB: 30, status: "shrink-pending" },
      projectStorageNativeBoot: true,
    };

    await records.create({ uid: "alice", createdAt: NOW });
    await records.admit("alice", { slug: "alice", persona: { vibe: "playful", timeZone: "America/Denver" }, createdAt: NOW, provisioningStartedAt: NOW + 1 });
    await records.patch("alice", {
      mattermostUserId: "mm-alice",
      workspaceId: "alice",
      role: "user",
      provisioning: { status: "complete", gitRepoUrl: "https://git.example/alice/workspace", gitCreatedAt: NOW + 2 },
      openclaw: {
        status: "complete", version: "v1", agentId: "octogee-alice-coach", customerDir: "/data/customers/alice", provisionedAt: NOW + 3,
        mounted: true, managedBy: "cowboy", greeting: { status: "sent" }, toolchain: { status: "ready", updatedAt: NOW },
      },
      accountLifecycle: { status: "deletion_scheduled", deletionId: "del-1", eraseAfter: NOW + 90 * DAY },
      home,
    });
    await place("alice", "shared-a");
    await records.setGatewayMirror("alice", { gatewayId: "shared-a", gatewayAssignedAt: NOW + 4, gatewayProfile: "standard", controlUiEnabled: false });
    await records.addAgents("alice", ["octogee-alice-site", "octogee-alice-coach"]);
    await records.setActivatedAgents("alice", ["coach"]);
    await records.setActivationLease("alice", lease(), { leaseId: null, generation: null });
    await records.setFence("alice", "restoreFence", restoreFence);
    await records.setFence("alice", "sourceTransferFence", sourceTransferFence, "absent");
    await records.setFence("alice", "computerRecovery", computerRecovery, "absent");
    await records.setFence("alice", "migration", migration, "absent");
    await records.setFence("alice", "pendingNativeSchedulerRetirement", retirement, "absent");
    await records.setFence("alice", "runtimeReset", runtimeReset, "absent");

    const expected: PlatformUserRecord = {
      uid: "alice",
      slug: "alice",
      mattermostUserId: "mm-alice",
      admitted: true,
      persona: { vibe: "playful", timeZone: "America/Denver" },
      workspaceId: "alice",
      role: "user",
      createdAt: NOW,
      updatedAt: expect.any(Number) as never,
      provisioning: { status: "complete", startedAt: NOW + 1, gitRepoUrl: "https://git.example/alice/workspace", gitCreatedAt: NOW + 2 },
      gateway: { gatewayId: "shared-a", gatewayAssignedAt: NOW + 4, gatewayProfile: "standard", controlUiEnabled: false },
      openclaw: {
        status: "complete", version: "v1", agentId: "octogee-alice-coach", customerDir: "/data/customers/alice", provisionedAt: NOW + 3,
        mounted: true, managedBy: "cowboy", greeting: { status: "sent" }, toolchain: { status: "ready", updatedAt: NOW },
      },
      agents: { agentIds: ["octogee-alice-coach", "octogee-alice-site"], activatedAgents: ["coach"] },
      accountLifecycle: { status: "deletion_scheduled", deletionId: "del-1", eraseAfter: NOW + 90 * DAY },
      activationLease: lease(),
      fences: { restoreFence, sourceTransferFence, computerRecovery, migration, pendingNativeSchedulerRetirement: retirement, runtimeReset },
      home,
    };
    expect(await records.get("alice")).toEqual({ ...expected, revision: expect.stringMatching(REVISION) });
  });

  it("reads a created record with empty groups and an absent one as null", async () => {
    const { records } = fixture();
    await records.create({ uid: "fresh", createdAt: NOW });

    expect(await records.get("fresh")).toEqual({
      uid: "fresh", slug: null, mattermostUserId: null, admitted: false, persona: null, workspaceId: null, role: null,
      createdAt: NOW, updatedAt: expect.any(Number), provisioning: {}, gateway: null, openclaw: {},
      agents: { agentIds: [], activatedAgents: [] }, accountLifecycle: null, activationLease: null, fences: {}, home: {},
      revision: expect.stringMatching(REVISION),
    });
    expect(await records.get("nobody")).toBeNull();
  });

  it("rejects a stored value of the wrong shape instead of guessing", async () => {
    const { records, harness } = fixture();
    for (const uid of ["fence", "erasure", "lease"]) await records.create({ uid, createdAt: NOW });
    await harness.query(`UPDATE $schema.users SET restore_fence = '"x"'::jsonb WHERE uid = 'fence'`);
    await harness.query(`UPDATE $schema.users SET home_erasure = '[1]'::jsonb WHERE uid = 'erasure'`);
    await harness.query(`UPDATE $schema.users SET activation_lease = '{"leaseId": 7, "generation": 1, "status": "active"}'::jsonb WHERE uid = 'lease'`);

    await expect(records.get("fence")).rejects.toMatchObject({
      constructor: MalformedRecordError, record: { aggregate: "builder", key: "fence" }, detail: "restore_fence is not a map",
    });
    await expect(records.get("erasure")).rejects.toMatchObject({ detail: "home_erasure is not a list of maps" });
    await expect(records.get("lease")).rejects.toMatchObject({ detail: "activation_lease.leaseId is not a string" });
  });

  it("creates the record by setting only createdAt, keeping every other field of an existing one", async () => {
    const { records } = fixture();
    await records.admit("alice", { slug: "alice", persona: { vibe: "calm" }, createdAt: NOW, provisioningStartedAt: NOW });
    const before = Date.now();
    await records.create({ uid: "alice", createdAt: { serverNow: true } });
    await records.create({ uid: "fresh", createdAt: NOW });

    const alice = (await records.get("alice"))!;
    expect(alice.createdAt).toBeGreaterThanOrEqual(before - 5_000);
    expect(alice).toMatchObject({ admitted: true, slug: "alice", persona: { vibe: "calm" }, provisioning: { status: "in_progress", startedAt: NOW } });
    expect((await records.get("fresh"))!.createdAt).toBe(NOW);
  });
});

describe.skipIf(!dsn)("PostgreSQL user records: admission", () => {
  const fixture = useUserFixture();

  it("admits a created user, begins provisioning, and refuses a second claim", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    const before = Date.now();
    await records.admit("alice", { slug: "alice", persona: { vibe: "playful" }, createdAt: NOW, provisioningStartedAt: { serverNow: true } });

    const admitted = (await records.get("alice"))!;
    expect(admitted).toMatchObject({ admitted: true, slug: "alice", persona: { vibe: "playful" }, provisioning: { status: "in_progress" } });
    expect(admitted.provisioning.startedAt).toBeGreaterThanOrEqual(before - 5_000);
    expect((await records.listAdmitted()).map((record) => record.uid)).toEqual(["alice"]);

    await expect(records.admit("alice", { slug: "alice", persona: null, createdAt: NOW, provisioningStartedAt: NOW })).rejects.toMatchObject({
      constructor: FenceMismatchError,
      fence: "absent",
      expected: { provisioningStatus: null },
      actual: { provisioningStatus: "in_progress" },
    });
    expect(await records.get("alice")).toEqual(admitted);
  });

  it("admits by creating the record with its creation time when it is absent and refuses a slug that differs from the record's", async () => {
    const { records } = fixture();
    await records.admit("fresh", { slug: "fresh", persona: null, createdAt: NOW + 3, provisioningStartedAt: NOW });
    expect(await records.get("fresh")).toMatchObject({
      admitted: true, slug: "fresh", persona: null, createdAt: NOW + 3, provisioning: { status: "in_progress", startedAt: NOW },
    });

    await records.create({ uid: "bob", createdAt: NOW });
    await records.patch("bob", { slug: "bob" });
    await expect(records.admit("bob", { slug: "robert", persona: null, createdAt: NOW, provisioningStartedAt: NOW })).rejects.toMatchObject({
      constructor: FenceMismatchError, fence: "present", expected: { slug: "robert" }, actual: { slug: "bob" },
    });
    expect(await records.get("bob")).toMatchObject({ admitted: false, slug: "bob", provisioning: {} });
  });

  it("stamps a server creation time on admission, fills one a record lacks, and keeps the one a record has", async () => {
    const { records, harness } = fixture();
    const before = Date.now();
    await records.admit("fresh", { slug: "fresh", persona: null, createdAt: { serverNow: true }, provisioningStartedAt: NOW });
    expect((await records.get("fresh"))!.createdAt).toBeGreaterThanOrEqual(before - 5_000);

    await harness.query("INSERT INTO $schema.users (uid) VALUES ('undated')");
    await records.admit("undated", { slug: "undated", persona: null, createdAt: NOW + 1, provisioningStartedAt: NOW });
    expect((await records.get("undated"))!.createdAt).toBe(NOW + 1);

    await records.create({ uid: "alice", createdAt: NOW });
    await records.admit("alice", { slug: "alice", persona: null, createdAt: NOW + 2, provisioningStartedAt: NOW });
    expect((await records.get("alice"))!.createdAt).toBe(NOW);
  });

  it("admits a record that has no slug yet by writing the slug it was handed", async () => {
    const { records } = fixture();
    await records.create({ uid: "carol", createdAt: NOW });
    await records.admit("carol", { slug: "carol", persona: { timeZone: "UTC" }, createdAt: NOW, provisioningStartedAt: NOW });
    expect(await records.findBySlug("carol")).toMatchObject({ uid: "carol", admitted: true, persona: { timeZone: "UTC" } });
  });
});

describe.skipIf(!dsn)("PostgreSQL user records: patches", () => {
  const fixture = useUserFixture();

  it("round-trips archive custody independently of retained-home provenance", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    const archive = {
      phase: "archived" as const, operationId: "archive-1", gatewayId: "user-gateway", instanceId: "104",
      snapshot: { projectId: "test-project", name: "home-1", id: "105",
        sourceDisk: "projects/test-project/zones/us-central1-b/disks/original", sourceDiskId: "103", sizeGb: 10 },
    };
    await records.patch("alice", { home: { homeDisk: { id: "103" }, homeArchive: archive } });
    expect((await records.get("alice"))?.home).toMatchObject({ homeDisk: { id: "103" }, homeArchive: archive });

    await records.patch("alice", { home: { homeArchive: { clear: true } } });
    expect((await records.get("alice"))?.home).toMatchObject({ homeDisk: { id: "103" } });
    expect((await records.get("alice"))?.home).not.toHaveProperty("homeArchive");
  });

  it("patches each group field by field, so siblings survive and cleared fields disappear", async () => {
    const { records } = fixture();
    await records.admit("alice", { slug: "alice-renamed", persona: null, createdAt: NOW, provisioningStartedAt: NOW });
    await records.patch("alice", {
      accountLifecycle: { status: "suspended", suspendedAt: NOW },
      provisioning: { status: "complete", gitRepoUrl: "https://git.example/alice/workspace", gitCreatedAt: NOW },
      openclaw: { status: "provisioning", customerDir: "/c/alice", toolchain: { status: "installing" } },
      home: { homeStorage: { runtime: "gce-vm", retained: [{ id: "1" }] }, projectStorageNativeBoot: false },
    });

    await records.patch("alice", {
      accountLifecycle: { clear: true },
      provisioning: { gitCreatedAt: NOW + 1 },
      openclaw: { status: "complete", toolchain: { clear: true }, managedBy: "operator" },
      home: { homeStorage: { runtime: "gce-vm", retained: [] }, projectStorageNativeBoot: { clear: true } },
    });

    expect(await records.get("alice")).toMatchObject({
      slug: "alice-renamed",
      accountLifecycle: null,
      provisioning: { status: "complete", startedAt: NOW, gitRepoUrl: "https://git.example/alice/workspace", gitCreatedAt: NOW + 1 },
      openclaw: { status: "complete", customerDir: "/c/alice", managedBy: "operator" },
      home: { homeStorage: { runtime: "gce-vm", retained: [] } },
    });
    expect((await records.get("alice"))!.openclaw).not.toHaveProperty("toolchain");
    expect((await records.get("alice"))!.home).not.toHaveProperty("projectStorageNativeBoot");
  });

  it("replaces the whole account lifecycle, so fields the new value omits are gone", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    await records.patch("alice", { accountLifecycle: { status: "deletion_scheduled", deletionId: "del-1", eraseAfter: NOW } });
    await records.patch("alice", { accountLifecycle: { status: "active" } });
    expect((await records.get("alice"))!.accountLifecycle).toEqual({ status: "active" });
  });

  it("reads the role alone, and reports none for an unknown user", async () => {
    const { records } = fixture();
    await records.create({ uid: "role-reader", createdAt: NOW });
    await records.patch("role-reader", { role: "admin" });

    expect(await records.getRole("role-reader")).toBe("admin");
    await records.patch("role-reader", { role: { clear: true } });
    expect(await records.getRole("role-reader")).toBeNull();
    expect(await records.getRole("nobody")).toBeNull();
  });

  it("stores the role on the record, reads it in a transaction, and clears it", async () => {
    const { records, store } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });

    await records.patch("alice", { role: "admin" });
    expect((await records.get("alice"))!.role).toBe("admin");
    expect(await store.transaction({ label: "role" }, async (tx) => (await tx.users.records.get("alice"))!.role)).toBe("admin");

    await records.patch("alice", { role: { clear: true }, workspaceId: "alice" });
    expect(await records.get("alice")).toMatchObject({ role: null, workspaceId: "alice" });
    await expect(records.patch("nobody", { role: "admin" })).rejects.toMatchObject(MISSING_USER);
  });

  it("advances the revision on a role-only patch, so a stale revision cannot patch the role back", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    const before = (await records.get("alice"))!;

    await records.patch("alice", { role: "admin" }, { revision: before.revision });

    const after = (await records.get("alice"))!;
    expect(after.revision).not.toBe(before.revision);
    await expect(records.patch("alice", { role: { clear: true } }, { revision: before.revision })).rejects.toBeInstanceOf(FenceMismatchError);
    expect((await records.get("alice"))!.role).toBe("admin");
  });

  it("refuses to patch a missing user or a field the record does not carry", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    const before = await records.get("alice");

    await expect(records.patch("nobody", { workspaceId: "x" })).rejects.toMatchObject(MISSING_USER);
    await expect(records.patch("alice", { openclaw: { lastError: "x" } } as never)).rejects.toThrow(TypeError);
    await expect(records.patch("alice", { tier: "pro" } as never)).rejects.toThrow(TypeError);
    await expect(records.patch("alice", { accountLifecycle: { status: "active", reason: "x" } } as never)).rejects.toThrow(TypeError);
    await expect(records.patch("alice", { openclaw: { mounted: "yes" } } as never)).rejects.toThrow(TypeError);
    expect(await records.get("alice")).toEqual(before);
    expect(await records.get("nobody")).toBeNull();
  });
});

describe.skipIf(!dsn)("PostgreSQL user records: agent roster", () => {
  const fixture = useUserFixture();

  it("adds agent ids once, removes them, and replaces the activated roles", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });

    await records.addAgents("alice", ["octogee-alice-site", "octogee-alice-coach", "octogee-alice-site"]);
    await records.addAgents("alice", ["octogee-alice-coach"]);
    await records.setActivatedAgents("alice", ["coach", "site"]);
    expect((await records.get("alice"))!.agents).toEqual({
      agentIds: ["octogee-alice-coach", "octogee-alice-site"],
      activatedAgents: ["coach", "site"],
    });

    await records.removeAgents("alice", ["octogee-alice-site", "octogee-alice-unknown"]);
    await records.setActivatedAgents("alice", ["coach"]);
    expect((await records.get("alice"))!.agents).toEqual({ agentIds: ["octogee-alice-coach"], activatedAgents: ["coach"] });
  });

  it("moves the record's revision with every roster change, so a revision fence sees it", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    const read = (await records.get("alice"))!;

    await records.addAgents("alice", ["octogee-alice-coach"]);
    const added = (await records.get("alice"))!;
    expect(added.revision).not.toBe(read.revision);
    await expect(records.patch("alice", { workspaceId: "alice" }, { revision: read.revision })).rejects.toMatchObject({
      constructor: FenceMismatchError, fence: "revision", expected: read.revision, actual: added.revision,
    });
    await records.removeAgents("alice", ["octogee-alice-coach"]);
    expect((await records.get("alice"))!.revision).not.toBe(added.revision);
  });

  it("refuses roster writes for a missing user and treats an empty list as nothing to do", async () => {
    const { records, harness } = fixture();
    await expect(records.addAgents("nobody", ["octogee-x-coach"])).rejects.toMatchObject(MISSING_USER);
    await expect(records.removeAgents("nobody", ["octogee-x-coach"])).rejects.toMatchObject(MISSING_USER);
    await expect(records.setActivatedAgents("nobody", ["coach"])).rejects.toMatchObject(MISSING_USER);
    await records.addAgents("nobody", []);
    await records.removeAgents("nobody", []);
    expect(await harness.query("SELECT * FROM $schema.user_agents")).toEqual([]);
  });
});
