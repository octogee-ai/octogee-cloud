import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresModelBrokerUsageLedger } from "../../../model-broker-usage-ledger.js";
import { AlreadyExistsError, FenceMismatchError, MissingRecordError } from "../../errors.js";
import type { UserSecretInput, ModelBrokerGatewayToken, ModelBrokerToken } from "../../secrets.js";
import { createHarness, dsn, type PlatformStateHarness } from "./fixtures/harness.js";

const NOW = 1_762_500_000_000;
const hashOf = (value: string) => createHash("sha256").update(value).digest("hex");

const defaultAgentSecret: UserSecretInput = {
  kind: "coach-mattermost",
  secretId: "coachMattermost",
  projectId: null,
  personalToken: "default-agent-pat",
  mattermostUserId: "mm-coach",
  createdAt: NOW,
  rotatedAt: NOW + 1,
};

describe.skipIf(!dsn)("PostgreSQL secrets and access repositories", { timeout: 30_000 }, () => {
  let harness: PlatformStateHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function user(uid: string): Promise<void> {
    await harness.query("INSERT INTO $schema.users (uid) VALUES ($1::text)", [uid]);
  }

  describe("User secrets", () => {
    beforeEach(async () => {
      await user("u1");
    });

    it("round-trips each Mattermost secret kind with its project and a server createdAt", async () => {
      await harness.store.secrets.put("u1", defaultAgentSecret);
      await harness.store.secrets.put("u1", {
        kind: "builder-mattermost",
        secretId: "mattermost",
        projectId: null,
        personalToken: "user-pat",
        mattermostUserId: null,
        createdAt: { serverNow: true },
        rotatedAt: null,
      });
      await harness.store.secrets.put("u1", {
        kind: "project-agent-mattermost",
        secretId: "projectAgentMattermost-site",
        projectId: "site",
        personalToken: "agent-pat",
        mattermostUserId: "mm-agent",
        createdAt: NOW,
        rotatedAt: null,
      });

      expect(await harness.store.secrets.get("u1", "coachMattermost")).toEqual({ ...defaultAgentSecret, revision: expect.any(String) });
      expect(await harness.store.secrets.get("u1", "mattermost")).toEqual({
        kind: "builder-mattermost",
        secretId: "mattermost",
        projectId: null,
        personalToken: "user-pat",
        mattermostUserId: null,
        createdAt: expect.any(Number),
        rotatedAt: null,
        revision: expect.any(String),
      });
      expect(await harness.store.secrets.get("u1", "projectAgentMattermost-site")).toMatchObject({
        kind: "project-agent-mattermost",
        projectId: "site",
        mattermostUserId: "mm-agent",
      });
      expect(await harness.store.secrets.get("u1", "missing")).toBeNull();
    });

    it("replaces a secret whole and moves its revision", async () => {
      await harness.store.secrets.put("u1", defaultAgentSecret);
      const before = (await harness.store.secrets.get("u1", "coachMattermost"))!;

      await harness.store.secrets.put("u1", { ...defaultAgentSecret, personalToken: "rotated", mattermostUserId: null, rotatedAt: null });

      const after = await harness.store.secrets.get("u1", "coachMattermost");
      expect(after).toMatchObject({ personalToken: "rotated", mattermostUserId: null, createdAt: NOW, rotatedAt: null });
      expect(after?.revision).not.toBe(before.revision);
    });

    it("rejects a secret whose kind or project disagrees with its id and writes nothing", async () => {
      await expect(harness.store.secrets.put("u1", { ...defaultAgentSecret, secretId: "mattermost" })).rejects.toBeInstanceOf(TypeError);
      await expect(
        harness.store.secrets.put("u1", {
          ...defaultAgentSecret,
          kind: "project-agent-mattermost",
          secretId: "projectAgentMattermost-site",
          projectId: "docs",
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(await harness.store.secrets.list("u1")).toEqual([]);
    });

    it("round-trips a connector secret, keeping other token fields in the detail", async () => {
      const connector: UserSecretInput = {
        kind: "connector",
        secretId: "google",
        encryptedAccessToken: "enc-access",
        encryptedRefreshToken: "enc-refresh",
        detail: { provider: "google", tokens: { expiresAt: NOW + 3_600_000, tokenType: "bearer" }, updatedAt: NOW },
      };

      await harness.store.secrets.put("u1", connector);

      expect(await harness.store.secrets.get("u1", "google")).toEqual({ ...connector, revision: expect.any(String) });
    });

    it("reads encrypted tokens carried inside the detail and drops an emptied tokens map", async () => {
      await harness.store.secrets.put("u1", {
        kind: "connector",
        secretId: "github",
        encryptedAccessToken: null,
        encryptedRefreshToken: null,
        detail: { provider: "github", tokens: { encryptedAccessToken: "enc-in-detail" } },
      });

      expect(await harness.store.secrets.get("u1", "github")).toEqual({
        kind: "connector",
        secretId: "github",
        encryptedAccessToken: "enc-in-detail",
        encryptedRefreshToken: null,
        detail: { provider: "github" },
        revision: expect.any(String),
      });
    });

    it("lists secrets by kind and deletes one", async () => {
      await harness.store.secrets.put("u1", defaultAgentSecret);
      await harness.store.secrets.put("u1", { ...defaultAgentSecret, kind: "builder-mattermost", secretId: "mattermost" });
      await harness.store.secrets.put("u1", {
        kind: "connector",
        secretId: "google",
        encryptedAccessToken: "enc",
        encryptedRefreshToken: null,
        detail: { provider: "google" },
      });

      expect((await harness.store.secrets.list("u1")).map((secret) => secret.kind)).toEqual([
        "coach-mattermost",
        "connector",
        "builder-mattermost",
      ]);
      expect((await harness.store.secrets.list("u1", "connector")).map((secret) => secret.secretId)).toEqual(["google"]);

      await harness.store.secrets.delete("u1", "google");
      expect(await harness.store.secrets.get("u1", "google")).toBeNull();
    });

    it("refuses a secret for an unknown user and drops a user's secrets with the user", async () => {
      await expect(harness.store.secrets.put("ghost", defaultAgentSecret)).rejects.toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "builder", key: "ghost" },
      });
      await harness.store.secrets.put("u1", defaultAgentSecret);

      await harness.query("DELETE FROM $schema.users WHERE uid = 'u1'");

      expect(await harness.store.secrets.list("u1")).toEqual([]);
    });
  });

  describe("gateway tickets", () => {
    const ticket = { ticketId: "t1", uid: "u1", gatewayId: "g1", expiresAt: NOW + 30_000, grant: { purpose: "preview", payload: { channelId: "c1" } } };

    it("creates a ticket once and reads it back", async () => {
      await harness.store.access.gatewayTickets.create(ticket);

      expect(await harness.store.access.gatewayTickets.get("t1")).toEqual({ ...ticket, revision: expect.any(String) });
      expect(await harness.store.access.gatewayTickets.get("missing")).toBeNull();
      await expect(harness.store.access.gatewayTickets.create(ticket)).rejects.toBeInstanceOf(AlreadyExistsError);
      await expect(harness.store.access.gatewayTickets.create({ ...ticket, ticketId: "t2", grant: { uid: "u2" } })).rejects.toBeInstanceOf(
        TypeError,
      );
    });

    it("deletes a ticket only at the fenced revision", async () => {
      await harness.store.access.gatewayTickets.create(ticket);
      const minted = (await harness.store.access.gatewayTickets.get("t1"))!;
      await harness.query(`UPDATE $schema.gateway_tickets SET access_grant = '{"redeemed": true}' WHERE ticket_id = 't1'`);

      await expect(harness.store.access.gatewayTickets.delete("t1", { revision: minted.revision })).rejects.toMatchObject({
        constructor: FenceMismatchError,
        fence: "revision",
      });
      await expect(harness.store.access.gatewayTickets.delete("missing", { revision: minted.revision })).rejects.toBeInstanceOf(
        MissingRecordError,
      );
      const current = (await harness.store.access.gatewayTickets.get("t1"))!;
      await harness.store.access.gatewayTickets.delete("t1", { revision: current.revision });
      expect(await harness.store.access.gatewayTickets.get("t1")).toBeNull();
      await harness.store.access.gatewayTickets.delete("t1");
    });


    it("counts a uid's live tickets per purpose, excluding expired tickets and other purposes", async () => {
      const tickets = harness.store.access.gatewayTickets;
      await tickets.create({ ...ticket, ticketId: "live", expiresAt: NOW + 1, grant: { purpose: "voice-ws", payload: {} } });
      await tickets.create({ ...ticket, ticketId: "expired", expiresAt: NOW, grant: { purpose: "voice-ws", payload: {} } });
      await tickets.create({ ...ticket, ticketId: "other-purpose", expiresAt: NOW + 1, grant: { purpose: "preview", payload: {} } });
      await tickets.create({ ...ticket, ticketId: "other-uid", uid: "u2", expiresAt: NOW + 1, grant: { purpose: "voice-ws", payload: {} } });

      expect(await tickets.countLive("u1", "voice-ws", NOW)).toBe(1);
      expect(await tickets.countLive("u1", "unknown", NOW)).toBe(0);
    });

    it("counts recorded mints strictly after the window start and sweeps them at expiry", async () => {
      const tickets = harness.store.access.gatewayTickets;
      await tickets.recordMint({ uid: "u1", purpose: "voice-ws", mintedAt: NOW, expiresAt: NOW + 10 });
      await tickets.recordMint({ uid: "u1", purpose: "voice-ws", mintedAt: NOW + 1, expiresAt: NOW + 11 });
      await tickets.recordMint({ uid: "u1", purpose: "preview", mintedAt: NOW + 1, expiresAt: NOW + 11 });

      expect(await tickets.countMintsSince("u1", "voice-ws", NOW)).toBe(1);
      expect(await tickets.countMintsSince("u1", "voice-ws", NOW - 1)).toBe(2);

      await harness.store.sweepExpired(NOW + 11, 100);
      expect(await tickets.countMintsSince("u1", "voice-ws", NOW - 1)).toBe(1);
    });

    it("never admits more concurrent mints than the cap, retrying the losers against the new count", async () => {
      const mint = (id: string) =>
        harness.store.transaction({ label: "capped-mint", maxAttempts: 10 }, async (tx) => {
          const live = await tx.access.gatewayTickets.countLive("u1", "voice-ws", NOW);
          if (live >= 2) throw new RangeError("capped");
          await tx.access.gatewayTickets.create({ ...ticket, ticketId: id, expiresAt: NOW + 30_000, grant: { purpose: "voice-ws", payload: {} } });
          await tx.access.gatewayTickets.recordMint({ uid: "u1", purpose: "voice-ws", mintedAt: NOW, expiresAt: NOW + 3_600_000 });
        });

      const results = await Promise.allSettled(["a", "b", "c", "d", "e"].map(mint));

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
      expect(results.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason)).toEqual(
        Array.from({ length: 3 }, () => expect.any(RangeError)),
      );
      expect(await harness.store.access.gatewayTickets.countLive("u1", "voice-ws", NOW)).toBe(2);
      expect(await harness.store.access.gatewayTickets.countMintsSince("u1", "voice-ws", NOW - 1)).toBe(2);
    });

    it("patches named grant fields, keeps the others and moves the revision", async () => {
      await harness.store.access.gatewayTickets.create(ticket);
      const minted = (await harness.store.access.gatewayTickets.get("t1"))!;

      await harness.store.access.gatewayTickets.patchGrant("t1", { sessionId: "s1", turns: { a: { state: "pending" } } });

      const patched = (await harness.store.access.gatewayTickets.get("t1"))!;
      expect(patched).toEqual({
        ...ticket,
        grant: { ...ticket.grant, sessionId: "s1", turns: { a: { state: "pending" } } },
        revision: expect.any(String),
      });
      expect(patched.revision).not.toBe(minted.revision);
    });

    it("refuses a typed field in a grant patch and writes nothing", async () => {
      await harness.store.access.gatewayTickets.create(ticket);

      await expect(harness.store.access.gatewayTickets.patchGrant("t1", { expiresAt: NOW + 1 })).rejects.toBeInstanceOf(TypeError);

      expect((await harness.store.access.gatewayTickets.get("t1"))?.expiresAt).toBe(ticket.expiresAt);
    });

    it("patches a grant only at the fenced revision and refuses a missing ticket", async () => {
      await harness.store.access.gatewayTickets.create(ticket);
      const minted = (await harness.store.access.gatewayTickets.get("t1"))!;
      await harness.store.access.gatewayTickets.patchGrant("t1", { sessionId: "s1" });

      await expect(harness.store.access.gatewayTickets.patchGrant("t1", { sessionId: "s2" }, { revision: minted.revision })).rejects.toBeInstanceOf(
        FenceMismatchError,
      );
      expect((await harness.store.access.gatewayTickets.get("t1"))?.grant.sessionId).toBe("s1");
      await expect(harness.store.access.gatewayTickets.patchGrant("missing", { sessionId: "s2" })).rejects.toBeInstanceOf(MissingRecordError);
      await expect(harness.store.access.gatewayTickets.patchGrant("missing", { sessionId: "s2" }, { revision: minted.revision })).rejects.toBeInstanceOf(
        MissingRecordError,
      );
    });

    it("keeps both entries when concurrent transactions extend one grant map", async () => {
      await harness.store.access.gatewayTickets.create({ ...ticket, grant: { turns: {} } });
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reads = 0;
      const addTurn = (turnId: string) =>
        harness.store.transaction({ label: `turn-${turnId}` }, async (tx) => {
          const current = (await tx.access.gatewayTickets.get("t1"))!;
          reads += 1;
          if (reads === 2) release();
          await bothRead;
          await tx.access.gatewayTickets.patchGrant("t1", {
            turns: { ...(current.grant.turns as Record<string, unknown>), [turnId]: { state: "pending" } },
          });
        });

      await Promise.all([addTurn("a"), addTurn("b")]);

      expect((await harness.store.access.gatewayTickets.get("t1"))?.grant.turns).toEqual({
        a: { state: "pending" },
        b: { state: "pending" },
      });
    });

    it("is swept with control tickets and sessions once expiresAt passes", async () => {
      await harness.store.access.gatewayTickets.create({ ...ticket, ticketId: "expired", expiresAt: NOW - 1 });
      await harness.store.access.gatewayTickets.create({ ...ticket, ticketId: "live", expiresAt: NOW + 60_000 });
      await harness.store.access.controlTickets.create({
        ticketHash: "h1",
        uid: "u1",
        gatewayId: "g1",
        createdAt: NOW - 10,
        expiresAt: NOW - 1,
        redeemedAt: null,
        grant: {},
      });
      await harness.store.access.controlSessions.put({
        sessionHash: "s1",
        uid: "u1",
        gatewayId: "g1",
        createdAt: null,
        expiresAt: NOW - 1,
        attachmentId: null,
        grant: {},
      });

      expect(await harness.store.sweepExpired(NOW, 10)).toEqual({ operations: 0, operationAudits: 0, accessGrants: 3, modelBrokerUsageEvents: 0, subscriptionFlows: 0 });
      expect(await harness.store.access.gatewayTickets.get("live")).not.toBeNull();
      expect(await harness.store.access.gatewayTickets.get("expired")).toBeNull();
      expect(await harness.store.access.controlTickets.get("h1")).toBeNull();
      expect(await harness.store.access.controlSessions.get("s1")).toBeNull();
    });
  });

  describe("control tickets", () => {
    const controlTicket = {
      ticketHash: hashOf("ticket"),
      uid: "u1",
      gatewayId: "g1",
      createdAt: NOW,
      expiresAt: NOW + 60_000,
      redeemedAt: null,
      grant: { workspaceSlug: "acme", revisionId: "rev-1" },
    };

    it("creates a ticket with a server createdAt and refuses typed fields in the grant", async () => {
      await harness.store.access.controlTickets.create({ ...controlTicket, createdAt: { serverNow: true } });

      expect(await harness.store.access.controlTickets.get(controlTicket.ticketHash)).toEqual({
        ...controlTicket,
        createdAt: expect.any(Number),
        revision: expect.any(String),
      });
      await expect(
        harness.store.access.controlTickets.create({ ...controlTicket, ticketHash: "other", grant: { redeemedAt: 1 } }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(harness.store.access.controlTickets.create(controlTicket)).rejects.toBeInstanceOf(AlreadyExistsError);
    });

    it("marks a ticket redeemed once and refuses a replay", async () => {
      await harness.store.access.controlTickets.create(controlTicket);

      await harness.store.access.controlTickets.markRedeemed(controlTicket.ticketHash, NOW + 5, { redeemedAt: null });

      expect((await harness.store.access.controlTickets.get(controlTicket.ticketHash))?.redeemedAt).toBe(NOW + 5);
      await expect(
        harness.store.access.controlTickets.markRedeemed(controlTicket.ticketHash, NOW + 6, { redeemedAt: null }),
      ).rejects.toMatchObject({ constructor: FenceMismatchError, fence: "absent", expected: null, actual: NOW + 5 });
      await expect(harness.store.access.controlTickets.markRedeemed("missing", NOW, { redeemedAt: null })).rejects.toBeInstanceOf(
        MissingRecordError,
      );
      expect((await harness.store.access.controlTickets.get(controlTicket.ticketHash))?.redeemedAt).toBe(NOW + 5);
    });

    it("lets exactly one of two concurrent redemptions win", async () => {
      await harness.store.access.controlTickets.create(controlTicket);
      const redeem = async (at: number) => {
        await harness.store.access.controlTickets.markRedeemed(controlTicket.ticketHash, at, { redeemedAt: null });
        return at;
      };

      const outcomes = await Promise.allSettled([redeem(NOW + 1), redeem(NOW + 2)]);

      const won = outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
      const lost = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]).toBeInstanceOf(FenceMismatchError);
      expect((await harness.store.access.controlTickets.get(controlTicket.ticketHash))?.redeemedAt).toBe(won[0]);
    });
  });

  describe("control sessions", () => {
    it("puts, replaces, reads and deletes a session with an attachment and no creation time", async () => {
      await harness.store.access.controlSessions.put({
        sessionHash: "mobile",
        uid: "u1",
        gatewayId: "g1",
        createdAt: NOW,
        expiresAt: NOW + 1,
        attachmentId: null,
        grant: { stale: true },
      });
      const session = {
        sessionHash: "mobile",
        uid: "u1",
        gatewayId: "g1",
        createdAt: null,
        expiresAt: NOW + 60_000,
        attachmentId: "enrollment-1",
        grant: { workspaceSlug: "acme", revisionId: "g1" },
      };

      await harness.store.access.controlSessions.put(session);

      expect(await harness.store.access.controlSessions.get("mobile")).toEqual({ ...session, revision: expect.any(String) });
      await expect(
        harness.store.access.controlSessions.put({ ...session, grant: { mobileEnrollmentId: "x" } }),
      ).rejects.toBeInstanceOf(TypeError);
      await harness.store.access.controlSessions.delete("mobile");
      expect(await harness.store.access.controlSessions.get("mobile")).toBeNull();
    });
  });

  describe("gateway access audit", () => {
    const denialId = (gatewayId: string, uid: string, reason: string, minute: number) =>
      `denied-${createHash("sha256").update(`${gatewayId}\0${uid}\0${reason}\0${minute}`).digest("hex")}`;

    it("records a denial under the per-minute id", async () => {
      const id = await harness.store.access.accessAudit.record({
        at: NOW + 12_345,
        gatewayId: "g1",
        uid: "u2",
        reason: "membership_required",
        detail: { workspaceSlug: "acme", source: "agent" },
      });

      expect(id).toBe(denialId("g1", "u2", "membership_required", Math.floor((NOW + 12_345) / 60_000)));
      const rows = await harness.query("SELECT id, at, gateway_id, uid, reason, detail FROM $schema.gateway_access_audit");
      expect(rows.map((row) => ({ ...row, detail: JSON.parse(row.detail as string) as unknown }))).toEqual([
        { id, at: NOW + 12_345, gateway_id: "g1", uid: "u2", reason: "membership_required", detail: { workspaceSlug: "acme", source: "agent" } },
      ]);
    });

    it("collapses repeated denials within a minute into one row and keys a denial without a grantee", async () => {
      const denial = { gatewayId: "g1", uid: "u2", reason: "membership_required", detail: { source: "agent" } };
      const minute = Math.floor(NOW / 60_000) * 60_000;

      const first = await harness.store.access.accessAudit.record({ ...denial, at: minute + 1 });
      const repeat = await harness.store.access.accessAudit.record({ ...denial, at: minute + 59_999 });
      const next = await harness.store.access.accessAudit.record({ ...denial, at: minute + 60_000 });
      const anonymous = await harness.store.access.accessAudit.record({ ...denial, uid: null, at: minute + 1 });

      expect(repeat).toBe(first);
      expect(next).not.toBe(first);
      expect(anonymous).toBe(denialId("g1", "", "membership_required", minute / 60_000));
      const rows = await harness.query("SELECT id, at FROM $schema.gateway_access_audit ORDER BY at, id");
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === first)).toEqual({ id: first, at: minute + 59_999 });
    });
  });

  describe("user erasure", () => {
    const seedFor = async (uid: string, suffix: string) => {
      await harness.store.access.gatewayTickets.create({ ticketId: `t-${suffix}`, uid, gatewayId: "g1", expiresAt: NOW + 30_000, grant: { purpose: "preview" } });
      await harness.store.access.gatewayTickets.recordMint({ uid, purpose: "voice-ws", mintedAt: NOW, expiresAt: NOW + 10 });
      await harness.store.access.controlTickets.create({ ticketHash: hashOf(`ticket-${suffix}`), uid, gatewayId: "g1", createdAt: NOW, expiresAt: NOW + 60_000, redeemedAt: null, grant: {} });
      await harness.store.access.controlSessions.put({ sessionHash: `s-${suffix}`, uid, gatewayId: "g1", createdAt: NOW, expiresAt: NOW + 1, attachmentId: null, grant: {} });
      await harness.store.access.accessAudit.record({ at: NOW, gatewayId: `grantee-${suffix}`, uid, reason: "membership_required", detail: {} });
      await harness.store.access.accessAudit.record({ at: NOW, gatewayId: `owner-${suffix}`, uid: null, reason: "membership_required", detail: { ownerUid: uid } });
      await harness.store.access.accessAudit.record({ at: NOW, gatewayId: `actor-${suffix}`, uid: null, reason: "membership_required", detail: { actorUid: uid } });
    };

    it("lists and erases every access record that names the user and leaves other users' records", async () => {
      await seedFor("u1", "one");
      await seedFor("u2", "two");

      const listed = await harness.store.access.listRecordsForUid("u1");
      expect(listed).toHaveLength(7);
      expect(listed.some((record) => record.includes("two"))).toBe(false);

      await harness.store.access.eraseForUid("u1");

      expect(await harness.store.access.listRecordsForUid("u1")).toEqual([]);
      expect(await harness.store.access.listRecordsForUid("u2")).toHaveLength(7);
      expect(await harness.store.access.gatewayTickets.get("t-one")).toBeNull();
      expect(await harness.store.access.gatewayTickets.get("t-two")).not.toBeNull();
    });

    it("lists and erases the user's model broker usage, spend and rate rows and leaves other users' rows", async () => {
      const ledger = createPostgresModelBrokerUsageLedger(harness.pool, harness.schema);
      const spendPeriods = [{ period: "window" as const, startMs: NOW }, { period: "week" as const, startMs: NOW }];
      for (const uid of ["u1", "u10"]) {
        await ledger.record({
          eventId: `event-${uid}`,
          ownerKey: uid,
          createdAt: NOW,
          expiresAt: NOW + 60_000,
          event: { ownerUid: uid, gatewayId: "shared-1" },
          totalTokens: 10,
          costUsd: 0.01,
          chargeUsd: 0.01,
          spendPeriods,
        });
        await ledger.reserveRequest(uid, NOW);
        await ledger.reserveRequest(`${uid}:embedding`, NOW);
      }

      expect([...await harness.store.access.listRecordsForUid("u1")].sort()).toEqual([
        "modelBrokerRateWindows/u1",
        "modelBrokerRateWindows/u1:embedding",
        "modelBrokerSpendPeriods/u1/week",
        "modelBrokerSpendPeriods/u1/window",
        "modelBrokerUsageEvents/event-u1",
      ]);

      await harness.store.access.eraseForUid("u1");

      expect(await harness.store.access.listRecordsForUid("u1")).toEqual([]);
      expect(await harness.store.access.listRecordsForUid("u10")).toHaveLength(5);
      await expect(ledger.readSpend("u10", "window", NOW)).resolves.toMatchObject({ requestCount: 1 });
    });
  });

  describe("model broker tokens", () => {
    const token = (overrides: Partial<ModelBrokerToken> = {}): ModelBrokerToken => ({
      tokenHash: hashOf("token-1"),
      gatewayId: "g1",
      ownerUid: null,
      provider: "anthropic",
      purpose: "model",
      secretName: "anthropic-key",
      createdAt: NOW,
      expiresAt: null,
      limits: { spendWindowUsd: 5, spendWeekUsd: null, requestsPerMinute: 60 },
      railPolicy: { freeTier: false, houseFallback: true },
      trace: null,
      revoked: false,
      revokedAt: null,
      ...overrides,
    });

    it("round-trips a token with its limits, rail policy and trace, once", async () => {
      await harness.store.access.modelBrokerTokens.create(token());
      const traced = token({ tokenHash: hashOf("token-2"), ownerUid: "u1", purpose: "embeddings", expiresAt: NOW + 1, trace: { requestId: "r1" }, limits: { spendWindowUsd: 0.25, spendWeekUsd: 10, requestsPerMinute: null } });
      await harness.store.access.modelBrokerTokens.create(traced);

      expect(await harness.store.access.modelBrokerTokens.get(hashOf("token-1"))).toEqual({ ...token(), revision: expect.any(String) });
      expect(await harness.store.access.modelBrokerTokens.get(traced.tokenHash)).toEqual({ ...traced, revision: expect.any(String) });
      expect(await harness.store.access.modelBrokerTokens.get(hashOf("missing"))).toBeNull();
      await expect(harness.store.access.modelBrokerTokens.create(token())).rejects.toBeInstanceOf(AlreadyExistsError);
    });

    it("revokes a token and refuses to revoke one that does not exist", async () => {
      await harness.store.access.modelBrokerTokens.create(token());

      await harness.store.access.modelBrokerTokens.revoke(hashOf("token-1"), NOW + 1);

      expect(await harness.store.access.modelBrokerTokens.get(hashOf("token-1"))).toMatchObject({ revoked: true, revokedAt: NOW + 1 });
      await expect(harness.store.access.modelBrokerTokens.revoke(hashOf("missing"), NOW)).rejects.toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "model-broker-token", key: hashOf("missing") },
      });
    });

    it("lists an owner's tokens and deletes one with the pointers that name it", async () => {
      await harness.store.access.modelBrokerTokens.create(token({ tokenHash: hashOf("a"), ownerUid: "u1" }));
      await harness.store.access.modelBrokerTokens.create(token({ tokenHash: hashOf("b"), ownerUid: "u1" }));
      await harness.store.access.modelBrokerTokens.create(token({ tokenHash: hashOf("c"), ownerUid: "u2" }));
      await harness.store.access.modelBrokerGatewayTokens.put({
        pointerKey: "g1",
        gatewayId: "g1",
        ownerUid: "u1",
        provider: "anthropic",
        secretName: "anthropic-key",
        tokenHash: hashOf("b"),
        updatedAt: NOW,
      });

      await harness.store.access.modelBrokerTokens.delete(hashOf("b"));

      expect((await harness.store.access.modelBrokerTokens.listForOwner("u1")).map((record) => record.tokenHash)).toEqual([hashOf("a")]);
      expect(await harness.store.access.modelBrokerGatewayTokens.get("g1")).toBeNull();
    });
  });

  describe("model broker gateway token pointers", () => {
    const pointer = (overrides: Partial<ModelBrokerGatewayToken> = {}): ModelBrokerGatewayToken => ({
      pointerKey: "g1:embeddings",
      gatewayId: "g1",
      ownerUid: "u1",
      provider: "openai",
      secretName: "openai-key",
      tokenHash: hashOf("token-1"),
      updatedAt: NOW,
      ...overrides,
    });

    beforeEach(async () => {
      for (const name of ["token-1", "token-2"]) {
        await harness.store.access.modelBrokerTokens.create({
          tokenHash: hashOf(name),
          gatewayId: "g1",
          ownerUid: "u1",
          provider: "openai",
          purpose: "embeddings",
          secretName: "openai-key",
          createdAt: NOW,
          expiresAt: null,
          limits: { spendWindowUsd: null, spendWeekUsd: null, requestsPerMinute: null },
          railPolicy: {},
          trace: null,
          revoked: false,
          revokedAt: null,
        });
      }
    });

    it("puts, replaces, lists and deletes pointers", async () => {
      await harness.store.access.modelBrokerGatewayTokens.put(pointer());
      await harness.store.access.modelBrokerGatewayTokens.put(pointer({ pointerKey: "g2", gatewayId: "g2", ownerUid: null }));
      await harness.store.access.modelBrokerGatewayTokens.put(pointer({ tokenHash: hashOf("token-2"), updatedAt: NOW + 1 }));

      expect(await harness.store.access.modelBrokerGatewayTokens.get("g1:embeddings")).toEqual({
        ...pointer({ tokenHash: hashOf("token-2"), updatedAt: NOW + 1 }),
        revision: expect.any(String),
      });
      expect(await harness.store.access.modelBrokerGatewayTokens.get("g2")).toMatchObject({ ownerUid: null });
      expect((await harness.store.access.modelBrokerGatewayTokens.listForOwner("u1")).map((record) => record.pointerKey)).toEqual([
        "g1:embeddings",
      ]);

      await harness.store.access.modelBrokerGatewayTokens.delete("g1:embeddings");
      expect(await harness.store.access.modelBrokerGatewayTokens.get("g1:embeddings")).toBeNull();
    });

    it("refuses a pointer to a token that does not exist", async () => {
      await expect(harness.store.access.modelBrokerGatewayTokens.put(pointer({ tokenHash: hashOf("missing") }))).rejects.toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "model-broker-token", key: hashOf("missing") },
      });
    });
  });
});
