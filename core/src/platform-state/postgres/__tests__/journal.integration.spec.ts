import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissingRecordError } from "../../errors.js";
import type { OperationRecord } from "../../operations.js";
import { audit, claimedAudit, createHarness, dsn, operation, receipt, type PlatformStateHarness } from "./fixtures/harness.js";

function ids(records: readonly { readonly id: string }[]): string[] {
  return records.map((record) => record.id);
}

describe.skipIf(!dsn)("PostgreSQL journal repositories", () => {
  let harness: PlatformStateHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  describe("operations", () => {
    it("clears completed-operation input and creator without changing operation identity", async () => {
      const operations = harness.store.journal.operations;
      await operations.create(operation({ id: "op-clear", status: "succeeded" }));
      await operations.patch("op-clear", { input: { clear: true }, createdBy: { clear: true } });
      const stored = await operations.get("op-clear");
      expect(stored).toMatchObject({ id: "op-clear", status: "succeeded" });
      expect(stored).not.toHaveProperty("input");
      expect(stored).not.toHaveProperty("createdBy");
    });

    it("round-trips every operation field exactly, with a revision", async () => {
      const full: OperationRecord = {
        id: "op-full",
        kind: "migrate-user",
        status: "running",
        createdBy: "operator:chris",
        origin: "automatic",
        createdAt: 1_700_000_000_000,
        startedAt: 1_700_000_000_100,
        queuedAt: 1_700_000_000_050,
        firstStartedAt: 1_700_000_000_100,
        lastResumedAt: 1_700_000_000_200,
        completedAt: null,
        input: { uid: "uid-1", gatewayId: "g1", userSlug: "ada", nested: { list: [1, "two", null, { deep: true }] } },
        steps: [{ name: "prepare", status: "done", startedAt: 1, completedAt: 2 }, { name: "copy", status: "running" }],
        error: "transient",
        rolledBack: false,
        lastProgressAt: 1_700_000_000_300,
        resumeCount: 2,
        waitingOn: "rollout-1",
        nextAttemptAt: 1_700_000_001_000,
        attempts: 3,
        attemptHistory: [{ attempt: 1, steps: [], error: "first" } as never],
        output: { result: "ok" },
        progress: [{ phase: "copy", status: "running", at: 5, migrationId: "m1", slug: "ada", source: "g0" }],
        userMigrationV2: { phase: "preSynced" } as never,
        sourceTransferExecution: { mode: "copy" } as never,
        schedulerHandoff: { state: "held" } as never,
        schedulerHandoffReleased: false,
        schedulerHandoffReleasedAt: 9,
        schedulerHandoffLost: "lost",
        cutoverCommittedAt: 10,
        gatewayId: "g1",
        inputUid: "uid-1",
        expireAt: 1_800_000_000_000,
        cancellationRequestedAt: 11,
        cancelledByDeletionId: "deletion-1",
        retryRequestedAt: 12,
        retryRequestedBy: "operator:chris",
        supersededBy: { operationId: "op-next" },
        restoreAttempt: { attempt: 1 },
        restoreRuntimeRecovery: { state: "pending" },
        sourceRuntimeRecovery: { state: "done" },
        sourceRecoverySupersededBy: "op-other",
        sourceRecoveryRequestedAt: 13,
        sourceRecoveryRequestedBy: "operator:chris",
        nativeReturnSourceRecoveryReceipts: [{ id: "r1" }],
        forceDrainRequest: { requestedBy: "operator:chris" },
        rolloutLane: "canary",
      };
      await harness.store.journal.operations.create(full);

      const stored = await harness.store.journal.operations.get(full.id);

      const { revision, ...record } = stored!;
      expect(record).toEqual(full);
      expect(revision).toMatch(/^\d+$/);
    });

    it("returns null for a missing operation and only the found ones from getMany", async () => {
      const first = operation();
      const second = operation();
      await harness.store.journal.operations.create(first);
      await harness.store.journal.operations.create(second);

      expect(await harness.store.journal.operations.get("missing")).toBeNull();
      const many = await harness.store.journal.operations.getMany([first.id, "missing", second.id]);
      expect([...many.keys()].sort()).toEqual([first.id, second.id].sort());
      expect(many.get(first.id)?.id).toBe(first.id);
      expect((await harness.store.journal.operations.getMany([])).size).toBe(0);
    });

    it("lists by status and the unreleased scheduler handoffs among them", async () => {
      await harness.store.journal.operations.create(operation({ id: "pending-1" }));
      await harness.store.journal.operations.create(operation({ id: "running-held", status: "running", startedAt: 1, schedulerHandoffReleased: false }));
      await harness.store.journal.operations.create(operation({ id: "running-released", status: "running", startedAt: 1, schedulerHandoffReleased: true }));
      await harness.store.journal.operations.create(operation({ id: "failed-1", status: "failed" }));

      expect(ids(await harness.store.journal.operations.listByStatus(["running", "pending"]))).toEqual([
        "pending-1",
        "running-held",
        "running-released",
      ]);
      expect(ids(await harness.store.journal.operations.listUnreleasedSchedulerHandoffs(["running"]))).toEqual(["running-held"]);
      expect(await harness.store.journal.operations.listByStatus([])).toEqual([]);
    });

    it("lists a gateway's operations newest first and honours the limit", async () => {
      await harness.store.journal.operations.create(operation({ id: "old", gatewayId: "g1", createdAt: 1 }));
      await harness.store.journal.operations.create(operation({ id: "new", gatewayId: "g1", createdAt: 3 }));
      await harness.store.journal.operations.create(operation({ id: "mid", gatewayId: "g1", createdAt: 2 }));
      await harness.store.journal.operations.create(operation({ id: "elsewhere", gatewayId: "g2", createdAt: 4 }));

      expect(ids(await harness.store.journal.operations.listByGateway("g1"))).toEqual(["new", "mid", "old"]);
      expect(ids(await harness.store.journal.operations.listByGateway("g1", 2))).toEqual(["new", "mid"]);
    });

    it("lists by the gateway named in the operation input", async () => {
      await harness.store.journal.operations.create(operation({ id: "input-g1", input: { gatewayId: "g1" } }));
      await harness.store.journal.operations.create(operation({ id: "field-g1", gatewayId: "g1" }));

      expect(ids(await harness.store.journal.operations.listByInputGateway("g1"))).toEqual(["input-g1"]);
    });

    it("lists a uid's operations filtered by status and kind", async () => {
      await harness.store.journal.operations.create(operation({ id: "a", inputUid: "uid-1", kind: "rollout" }));
      await harness.store.journal.operations.create(operation({ id: "b", inputUid: "uid-1", kind: "erase-user", status: "running" }));
      await harness.store.journal.operations.create(operation({ id: "c", inputUid: "uid-2", kind: "rollout" }));

      expect(ids(await harness.store.journal.operations.listForUid("uid-1", {}))).toEqual(["a", "b"]);
      expect(ids(await harness.store.journal.operations.listForUid("uid-1", { statuses: ["running"] }))).toEqual(["b"]);
      expect(ids(await harness.store.journal.operations.listForUid("uid-1", { kind: "rollout" }))).toEqual(["a"]);
      expect(ids(await harness.store.journal.operations.listForUid("uid-1", { kind: "rollout", statuses: ["running"] }))).toEqual([]);
    });

    it("lists by kind with and without a status filter", async () => {
      await harness.store.journal.operations.create(operation({ id: "r1", kind: "rollout" }));
      await harness.store.journal.operations.create(operation({ id: "r2", kind: "rollout", status: "succeeded" }));
      await harness.store.journal.operations.create(operation({ id: "x1", kind: "retire-gateway" }));

      expect(ids(await harness.store.journal.operations.listByKind("rollout"))).toEqual(["r1", "r2"]);
      expect(ids(await harness.store.journal.operations.listByKind("rollout", ["succeeded"]))).toEqual(["r2"]);
    });

    it("lists operations that reference a uid through its field, its input, or its creator", async () => {
      await harness.store.journal.operations.create(operation({ id: "by-field", inputUid: "uid-1" }));
      await harness.store.journal.operations.create(operation({ id: "by-input", input: { uid: "uid-1" } }));
      await harness.store.journal.operations.create(operation({ id: "by-creator", createdBy: "uid-1" }));
      await harness.store.journal.operations.create(operation({ id: "unrelated", inputUid: "uid-2" }));

      expect(ids(await harness.store.journal.operations.listReferencingUid("uid-1"))).toEqual(["by-creator", "by-field", "by-input"]);
    });

    it("lists by user slug prefix, treating LIKE wildcards in the prefix literally", async () => {
      await harness.store.journal.operations.create(operation({ id: "s1", input: { userSlug: "ada-one" } }));
      await harness.store.journal.operations.create(operation({ id: "s2", input: { userSlug: "ada-two" } }));
      await harness.store.journal.operations.create(operation({ id: "s3", input: { userSlug: "adam" } }));
      await harness.store.journal.operations.create(operation({ id: "s4", input: { userSlug: "a%_x" } }));
      await harness.store.journal.operations.create(operation({ id: "s5", input: { userSlug: "abcx" } }));

      expect(ids(await harness.store.journal.operations.listByInputUserSlugPrefix("ada-"))).toEqual(["s1", "s2"]);
      expect(ids(await harness.store.journal.operations.listByInputUserSlugPrefix("a%_"))).toEqual(["s4"]);
    });

    it("enqueues with a minted id", async () => {
      const { id: _ignored, ...draft } = operation();

      const id = await harness.store.journal.operations.enqueue(draft);

      expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
      expect(await harness.store.journal.operations.get(id)).toMatchObject({ ...draft, id });
    });

    it("puts a whole operation, creating it or replacing every field", async () => {
      const original = operation({ waitingOn: "rollout-1", output: { a: 1 } });
      await harness.store.journal.operations.put(original);
      const replacement = operation({ id: original.id, status: "running", startedAt: 3 });

      await harness.store.journal.operations.put(replacement);

      const { revision: _revision, ...stored } = (await harness.store.journal.operations.get(original.id))!;
      expect(stored).toEqual(replacement);
    });

    it("patches fields and deletes", async () => {
      const created = operation();
      await harness.store.journal.operations.create(created);

      await harness.store.journal.operations.patch(created.id, { status: "succeeded", completedAt: 99, output: { done: true } });
      expect(await harness.store.journal.operations.get(created.id)).toMatchObject({ status: "succeeded", completedAt: 99, output: { done: true } });

      await harness.store.journal.operations.delete(created.id);
      expect(await harness.store.journal.operations.get(created.id)).toBeNull();
    });
  });

  describe("audits", () => {
    it("creates, reads by id and idempotency key, patches, and deletes", async () => {
      const recorded = audit({ releaseRollout: { releaseId: "r1" }, testProvenance: { environment: "test" } });
      await harness.store.journal.audits.create(recorded);

      const { revision, ...stored } = (await harness.store.journal.audits.get(recorded.id))!;
      expect(stored).toEqual(recorded);
      expect((await harness.store.journal.audits.getByIdempotencyKey(recorded.idempotencyKey))?.revision).toBe(revision);
      expect(await harness.store.journal.audits.getByIdempotencyKey("unknown")).toBeNull();
      expect(await harness.store.journal.audits.get("audit-missing")).toBeNull();

      await harness.store.journal.audits.patch(recorded.id, {
        status: "in-progress",
        lifecycleStage: "action-started",
        actionClaimId: "claim-1",
        actionStartedAt: 5,
        actionRecoveryCount: 0,
      });
      await harness.store.journal.audits.patch(recorded.id, {
        status: "completed",
        lifecycleStage: "action-completed",
        outcome: "completed",
        completedAt: 6,
        aliasOutcomes: [{ alias: "preview", status: "applied", observedTarget: "g2" }],
      });
      expect(await harness.store.journal.audits.get(recorded.id)).toMatchObject({ status: "completed", completedAt: 6, outcome: "completed" });

      await harness.store.journal.audits.delete(recorded.id);
      expect(await harness.store.journal.audits.get(recorded.id)).toBeNull();
    });

    it("refuses to change an audit's identity fields", async () => {
      const recorded = audit();
      await harness.store.journal.audits.create(recorded);

      await expect(harness.store.journal.audits.patch(recorded.id, { idempotencyKey: "other" } as never)).rejects.toThrow(
        /cannot change idempotencyKey/,
      );
    });
  });

  describe("recovery receipts", () => {
    it("creates, reads, lists by uid, patches under a revision fence, and deletes", async () => {
      const first = receipt({ recoveryReceipt: { phase: "start" }, origin: "automatic", firstStartedAt: 3 });
      const byInput = receipt({ inputUid: "uid-9", input: { uid: "uid-1" } });
      const unrelated = receipt({ inputUid: "uid-2", input: { uid: "uid-2" } });
      for (const created of [first, byInput, unrelated]) await harness.store.journal.recoveryReceipts.create(created);

      const { revision, ...stored } = (await harness.store.journal.recoveryReceipts.get(first.id))!;
      expect(stored).toEqual(first);
      expect(ids(await harness.store.journal.recoveryReceipts.listReferencingUid("uid-1")).sort()).toEqual([first.id, byInput.id].sort());

      await harness.store.journal.recoveryReceipts.patch(first.id, { status: "running", startedAt: 4 }, { revision });
      await expect(
        harness.store.journal.recoveryReceipts.patch(first.id, { status: "failed" }, { revision }),
      ).rejects.toMatchObject({ name: "FenceMismatchError", fence: "revision", expected: revision });
      expect(await harness.store.journal.recoveryReceipts.get(first.id)).toMatchObject({ status: "running", startedAt: 4 });

      await harness.store.journal.recoveryReceipts.delete(first.id);
      expect(await harness.store.journal.recoveryReceipts.get(first.id)).toBeNull();
    });
  });

  describe("journal-wide reads", () => {
    it("gets an operation or an audit by record id", async () => {
      const created = operation();
      const recorded = claimedAudit();
      await harness.store.journal.operations.create(created);
      await harness.store.journal.audits.create(recorded);

      expect((await harness.store.journal.getRecord(created.id))?.id).toBe(created.id);
      expect(await harness.store.journal.getRecord(recorded.id)).toMatchObject({ id: recorded.id, recordType: "audit" });
      expect(await harness.store.journal.getRecord("audit-missing")).toBeNull();
      expect(await harness.store.journal.getRecord("missing")).toBeNull();
    });

    it("pages operations and audits together, newest first, with ties broken by id", async () => {
      await harness.store.journal.operations.create(operation({ id: "op-1", createdAt: 10 }));
      await harness.store.journal.operations.create(operation({ id: "op-2", createdAt: 30 }));
      await harness.store.journal.operations.create(operation({ id: "op-3", createdAt: 20 }));
      const tiedAudit = audit({ createdAt: 20 });
      const newestAudit = audit({ createdAt: 40 });
      await harness.store.journal.audits.create(tiedAudit);
      await harness.store.journal.audits.create(newestAudit);
      const expected = [newestAudit.id, "op-2", ...["op-3", tiedAudit.id].sort().reverse(), "op-1"];

      const first = await harness.store.journal.listRecent({ limit: 2 });
      const second = await harness.store.journal.listRecent({ limit: 2, after: first.next! });
      const third = await harness.store.journal.listRecent({ limit: 2, after: second.next! });

      expect([...ids(first.items), ...ids(second.items), ...ids(third.items)]).toEqual(expected);
      expect(first.next).toBe(expected[1]);
      expect(second.next).toBe(expected[3]);
      expect(third.next).toBeNull();
      expect(first.items[0]).toMatchObject({ recordType: "audit" });
    });

    it("returns an empty page for an empty journal and rejects an unknown cursor", async () => {
      expect(await harness.store.journal.listRecent({ limit: 5 })).toEqual({ items: [], next: null });
      await expect(harness.store.journal.listRecent({ limit: 5, after: "missing" })).rejects.toBeInstanceOf(MissingRecordError);
    });
  });
});
