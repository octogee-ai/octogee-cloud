import { describe, expect, it } from "vitest";
import {
  decideOperationClaim,
  findRunningRolloutParentOperationId,
  findSerialConflict,
  isSeriallyExclusiveKind,
} from "../operation-queue";

describe("findRunningRolloutParentOperationId", () => {
  it("finds the rollout document that owns a gateway's release roll", () => {
    expect(findRunningRolloutParentOperationId("default", [
      { id: "other", kind: "migrate-user", input: { toGatewayId: "default" } },
      { id: "rollout-document", kind: "rollout", input: { gatewayId: "default" } },
    ])).toBe("rollout-document");
  });

  it("rejects an impossible ambiguous parent instead of guessing", () => {
    expect(() => findRunningRolloutParentOperationId("default", [
      { id: "rollout-a", kind: "rollout", input: { gatewayId: "default" } },
      { id: "rollout-b", kind: "rollout", input: { fromGatewayId: "default" } },
    ])).toThrow("multiple running rollout operations target gateway default");
  });
});

describe("isSeriallyExclusiveKind", () => {
  it("treats rollout as subject to scheduling locks", () => {
    expect(isSeriallyExclusiveKind("rollout")).toBe(true);
  });

  it("treats migrate-customer as serial per migration target", () => {
    expect(isSeriallyExclusiveKind("migrate-user")).toBe(true);
    expect(isSeriallyExclusiveKind("suspend-user")).toBe(true);
  });

  it("does not restrict kinds with no known hard-fail-on-busy path", () => {
    expect(isSeriallyExclusiveKind("retire-gateway")).toBe(false);
    expect(isSeriallyExclusiveKind("recycle-gateway")).toBe(false);
    expect(isSeriallyExclusiveKind("add-gateway")).toBe(false);
    expect(isSeriallyExclusiveKind("restart-gateway")).toBe(false);
    expect(isSeriallyExclusiveKind("deprovision-user")).toBe(false);
  });
});

describe("findSerialConflict — rollout", () => {
  it("returns null when the candidate's kind isn't serially exclusive", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "retire-gateway" },
      [{ id: "op-1", kind: "retire-gateway", input: { gatewayId: "walter-blue" } }],
    );
    expect(conflict).toBeNull();
  });

  it("returns null when no other op of the same kind is running", () => {
    const conflict = findSerialConflict({ id: "op-2", kind: "rollout" }, []);
    expect(conflict).toBeNull();
  });

  it("flags a conflict against another running rollout and names the rolling gateway", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "rollout" },
      [{ id: "op-1", kind: "rollout", input: { gatewayId: "walter-blue" } }],
    );
    expect(conflict).toEqual({
      conflictingOpId: "op-1",
      waitingOn: "roll walter-blue",
    });
  });

  it("never conflicts with itself (a doc can't be its own running blocker)", () => {
    const conflict = findSerialConflict(
      { id: "op-1", kind: "rollout" },
      [{ id: "op-1", kind: "rollout", input: { gatewayId: "walter-blue" } }],
    );
    expect(conflict).toBeNull();
  });

  it("falls back to a generic description when the running op has no gatewayId", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "rollout" },
      [{ id: "op-1", kind: "rollout", input: {} }],
    );
    expect(conflict).toEqual({
      conflictingOpId: "op-1",
      waitingOn: "another rollout operation",
    });
  });

  it("unclassified rollout ops for different gateways stay globally exclusive", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "rollout", input: { gatewayId: "default-green" } },
      [{ id: "op-1", kind: "rollout", input: { gatewayId: "walter-blue" } }],
    );
    expect(conflict?.conflictingOpId).toBe("op-1");
  });
});

describe("findSerialConflict — migrate-customer (per-target scope)", () => {
  it("conflicts with another running migration to the SAME target", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "migrate-user", input: { toGatewayId: "walter-green" } },
      [
        {
          id: "op-1",
          kind: "migrate-user",
          input: { fromGatewayId: "walter-blue", toGatewayId: "walter-green" },
        },
      ],
    );
    expect(conflict).toEqual({
      conflictingOpId: "op-1",
      waitingOn: "migration walter-blue → walter-green",
    });
  });

  it("does NOT conflict with a running migration to a DIFFERENT target", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "migrate-user", input: { toGatewayId: "gw-purple" } },
      [{ id: "op-1", kind: "migrate-user", input: { toGatewayId: "gw-green" } }],
    );
    expect(conflict).toBeNull();
  });

  it("conflicts with another migration sharing the source even when targets differ", () => {
    const conflict = findSerialConflict(
      {
        id: "op-2",
        kind: "migrate-user",
        input: { fromGatewayId: "source", toGatewayId: "target-b" },
      },
      [{
        id: "op-1",
        kind: "migrate-user",
        input: { fromGatewayId: "source", toGatewayId: "target-a" },
      }],
    );
    expect(conflict?.conflictingOpId).toBe("op-1");
  });

  it("never conflicts when the candidate has no toGatewayId — its own validation failure stops it, not the queue", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "migrate-user", input: {} },
      [{ id: "op-1", kind: "migrate-user", input: { toGatewayId: "gw-green" } }],
    );
    expect(conflict).toBeNull();
  });

  it("describes a target-only migration without a fromGatewayId", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "migrate-user", input: { toGatewayId: "gw-green" } },
      [{ id: "op-1", kind: "migrate-user", input: { toGatewayId: "gw-green" } }],
    );
    expect(conflict).toEqual({
      conflictingOpId: "op-1",
      waitingOn: "migration → gw-green",
    });
  });
});

describe("findSerialConflict — shared migration/release-roll scope", () => {
  it("queues a migration that shares a gateway with a running rollout — no lineage exemption", () => {
    const decision = decideOperationClaim({
      op: {
        id: "migration",
        kind: "migrate-user",
        status: "pending",
        createdAt: 2,
        input: {
          fromGatewayId: "default",
          toGatewayId: "other",
          parentOperationId: "rollout-document",
        },
      },
      now: 1_000,
      runningOpsSameKind: [{
        id: "rollout-document",
        kind: "rollout",
        input: { gatewayId: "default" },
      }],
      pendingOpsSameKind: [],
    });

    expect(decision).toEqual({ outcome: "queue", waitingOn: "roll default" });
  });

  it.each(["source", "target"])(
    "queues a release roll that begins on the migration %s gateway",
    (gatewayId) => {
      const conflict = findSerialConflict(
        { id: "roll", kind: "rollout", input: { gatewayId } },
        [{
          id: "migration",
          kind: "migrate-user",
          input: { fromGatewayId: "source", toGatewayId: "target" },
        }],
      );
      expect(conflict?.conflictingOpId).toBe("migration");
    },
  );

  it.each(["source", "target"])(
    "queues a migration that begins while its %s gateway is rolling",
    (gatewayId) => {
      const conflict = findSerialConflict(
        {
          id: "migration",
          kind: "migrate-user",
          input: { fromGatewayId: "source", toGatewayId: "target" },
        },
        [{ id: "roll", kind: "rollout", input: { gatewayId } }],
      );
      expect(conflict?.conflictingOpId).toBe("roll");
    },
  );

  it("uses durable revision bindings while a migration is retrying", () => {
    const conflict = findSerialConflict(
      { id: "roll", kind: "rollout", input: { gatewayId: "source" } },
      [{
        id: "migration",
        kind: "migrate-user",
        input: { toGatewayId: "target" },
        userMigrationV2: {
          sourceGatewayId: "source",
          sourceRevisionId: "source-r2",
          targetGatewayId: "target",
          targetRevisionId: "target-r4",
        } as never,
      }],
    );
    expect(conflict?.conflictingOpId).toBe("migration");
  });
});

describe("decideOperationClaim", () => {
  it("finishes a user activation retry before rolling its held target", () => {
    const activation = {
      id: "builder-activate-builder-a-g1", kind: "migrate-user", status: "pending",
      createdAt: 1, queuedAt: 3, nextAttemptAt: 15_000,
      input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "builder-a", source: "builder-activation-lease" },
    };
    const rollout = {
      id: "roll", kind: "rollout", status: "pending", createdAt: 2,
      input: { gatewayId: "builder-a" },
    };
    expect(decideOperationClaim({
      op: rollout, now: 10_000, runningOpsSameKind: [], pendingOpsSameKind: [activation],
    })).toEqual({ outcome: "queue", waitingOn: "migration shared-a → builder-a" });
    expect(decideOperationClaim({
      op: activation, now: 15_000, runningOpsSameKind: [], pendingOpsSameKind: [rollout],
    })).toEqual({ outcome: "claim" });
    expect(decideOperationClaim({
      op: rollout, now: 16_000, runningOpsSameKind: [], pendingOpsSameKind: [],
    })).toEqual({ outcome: "claim" });
  });

  it.each([0, 2])('repairs an abandoned activation target before source-only recovery regardless of queue order: %s', createdAt => {
    const recovery = {
      id: 'builder-activate-builder-a-g1', kind: 'migrate-user', status: 'pending', createdAt: 1,
      input: { uid: 'alice', source: 'builder-activation-lease', fromGatewayId: 'shared-a', toGatewayId: 'builder-a', recoverSourceOnly: true },
    };
    const rollout = { id: 'repair', kind: 'rollout', rolloutLane: 'cluster' as const, status: 'pending', createdAt, input: { gatewayId: 'builder-a' } };
    expect(decideOperationClaim({ op: rollout, now: 10000, runningOpsSameKind: [], pendingOpsSameKind: [recovery] })).toEqual({ outcome: 'claim' });
    expect(decideOperationClaim({ op: recovery, now: 10000, runningOpsSameKind: [], pendingOpsSameKind: [rollout] })).toEqual({ outcome: 'queue', waitingOn: 'roll builder-a' });
    expect(decideOperationClaim({ op: rollout, now: 10000, runningOpsSameKind: [recovery], pendingOpsSameKind: [] })).toEqual({ outcome: 'queue', waitingOn: 'migration shared-a → builder-a' });
    expect(decideOperationClaim({ op: recovery, now: 10000, runningOpsSameKind: [rollout], pendingOpsSameKind: [] })).toEqual({ outcome: 'queue', waitingOn: 'roll builder-a' });
  });

  it.each([0, 2])('runs source recovery before a held VM target roll regardless of queue order: %s', createdAt => {
    const recovery = {
      id: 'builder-activate-builder-a-g1', kind: 'migrate-user', status: 'pending', createdAt: 1,
      input: { uid: 'alice', source: 'builder-activation-lease', fromGatewayId: 'shared-a', toGatewayId: 'builder-a', recoverSourceOnly: true },
    };
    const rollout = { id: 'vm-roll', kind: 'rollout', rolloutLane: 'builder-vm' as const, status: 'pending', createdAt, input: { gatewayId: 'builder-a' } };
    expect(decideOperationClaim({ op: rollout, now: 10000, runningOpsSameKind: [], pendingOpsSameKind: [recovery] }))
      .toEqual({ outcome: 'queue', waitingOn: 'migration shared-a → builder-a' });
    expect(decideOperationClaim({ op: recovery, now: 10000, runningOpsSameKind: [], pendingOpsSameKind: [rollout] }))
      .toEqual({ outcome: 'claim' });
    expect(decideOperationClaim({ op: recovery, now: 10000, runningOpsSameKind: [rollout], pendingOpsSameKind: [] }))
      .toEqual({ outcome: 'queue', waitingOn: 'roll builder-a' });
  });

  it('finishes exact source recovery after its rollout retained a proven cleaned predecessor', () => {
    const migrationId = 'mig-builder-activate-builder-a-g1:scheduler:1:claim:1000';
    const recovery = {
      id: 'builder-activate-builder-a-g1', kind: 'migrate-user', status: 'pending', createdAt: 1,
      input: { uid: 'alice', userSlug: 'alice', source: 'builder-activation-lease', fromGatewayId: 'shared-a', toGatewayId: 'builder-a', recoverSourceOnly: true },
      schedulerHandoff: { migrationId, fromGatewayId: 'shared-a', toGatewayId: 'builder-a', uid: 'alice', slug: 'alice', sourceRecovery: { migrationId, sourceEpoch: 7, steps: [],
        targetRollback: { operationId: 'builder-activate-builder-a-g1', migrationId, uid: 'alice', slug: 'alice', sourceGatewayId: 'shared-a', sourceEpoch: 7, targetGatewayId: 'builder-a', leaseId: 'lease-a', generation: 1, retainedPodUid: 'retained-r1', completedAt: 2000 } } },
    };
    const rollout = { id: 'new-roll', kind: 'rollout', status: 'pending', createdAt: 0, input: { gatewayId: 'builder-a' } };
    expect(decideOperationClaim({ op: rollout, now: 10000, runningOpsSameKind: [], pendingOpsSameKind: [recovery] })).toEqual({ outcome: 'queue', waitingOn: 'migration shared-a → builder-a' });
    expect(decideOperationClaim({ op: recovery, now: 10000, runningOpsSameKind: [], pendingOpsSameKind: [rollout] })).toEqual({ outcome: 'claim' });
  });

  it.each([
    { input: { source: 'continuous-placement-policy' } },
    { input: { recoverSourceOnly: false } },
    { input: { fromGatewayId: 'user-source' } },
    { userMigrationV2: { sourceGatewayId: 'shared-a' } },
    { id: 'different-migration' },
  ])('keeps ordinary queue exclusion for an unqualified target-repair request: %j', patch => {
    const recovery = {
      id: 'builder-activate-builder-a-g1', kind: 'migrate-user', createdAt: 1,
      ...patch,
      input: { source: 'builder-activation-lease', fromGatewayId: 'shared-a', toGatewayId: 'builder-a', recoverSourceOnly: true, ...patch.input },
    };
    expect(decideOperationClaim({
      op: { id: 'repair', kind: 'rollout', status: 'pending', createdAt: 2, input: { gatewayId: 'builder-a' } },
      now: 10000, runningOpsSameKind: [], pendingOpsSameKind: [recovery],
    }).outcome).toBe('queue');
  });

  it.each(["shared-a", "builder-b"])("does not reserve %s for another target's activation retry", (gatewayId) => {
    expect(decideOperationClaim({
      op: { id: "roll", kind: "rollout", status: "pending", createdAt: 2, input: { gatewayId } },
      now: 10_000, runningOpsSameKind: [],
      pendingOpsSameKind: [{
        id: "builder-activate-builder-a-g1", kind: "migrate-user", createdAt: 1,
        queuedAt: 3, nextAttemptAt: 15_000,
        input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "builder-a", source: "builder-activation-lease" },
      }],
    })).toEqual({ outcome: "claim" });
  });

  it("does not let activation bypass an already running rollout", () => {
    expect(decideOperationClaim({
      op: { id: "builder-activate-builder-a-g1", kind: "migrate-user", status: "pending", createdAt: 1,
        queuedAt: 3, input: { toGatewayId: "builder-a", source: "builder-activation-lease" } },
      now: 10_000, runningOpsSameKind: [{ id: "roll", kind: "rollout", input: { gatewayId: "builder-a" } }],
      pendingOpsSameKind: [],
    })).toEqual({ outcome: "queue", waitingOn: "roll builder-a" });
  });

  it("allows a roll once activation has committed ownership even with cleanup pending", () => {
    expect(decideOperationClaim({
      op: { id: "roll", kind: "rollout", status: "pending", createdAt: 2, input: { gatewayId: "builder-a" } },
      now: 10_000, runningOpsSameKind: [],
      pendingOpsSameKind: [{
        id: "builder-activate-builder-a-g1", kind: "migrate-user", createdAt: 1, cutoverCommittedAt: 9_000,
        input: { fromGatewayId: "shared-a", toGatewayId: "builder-a", source: "builder-activation-lease" },
      }],
    })).toEqual({ outcome: "claim" });
  });

  it.each([5_000, -1])("lets another user pass a rolled-back retry with delay %i", (delay) => {
    expect(decideOperationClaim({
      op: { id: "healthy", kind: "migrate-user", status: "pending", createdAt: 2,
        input: { uid: "bob", fromGatewayId: "shared-a", toGatewayId: "shared-b" } },
      now: 10_000,
      runningOpsSameKind: [],
      pendingOpsSameKind: [{ id: "retry", kind: "migrate-user", createdAt: 1,
        queuedAt: 3, nextAttemptAt: 10_000 + delay,
        input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" } }],
    })).toEqual({ outcome: "claim" });
  });

  it("admits newly queued work during a rolled-back migration's backoff", () => {
    expect(decideOperationClaim({
      op: { id: "healthy", kind: "migrate-user", status: "pending", createdAt: 4,
        input: { uid: "bob", toGatewayId: "shared-b" } },
      now: 10_000, runningOpsSameKind: [],
      pendingOpsSameKind: [{ id: "retry", kind: "migrate-user", createdAt: 1,
        queuedAt: 3, nextAttemptAt: 15_000, input: { uid: "alice", toGatewayId: "shared-b" } }],
    })).toEqual({ outcome: "claim" });
  });

  it("queues an eligible retry behind work already waiting when it failed", () => {
    expect(decideOperationClaim({
      op: { id: "retry", kind: "migrate-user", status: "pending", createdAt: 1,
        queuedAt: 3, nextAttemptAt: 9_000, input: { toGatewayId: "shared-b" } },
      now: 10_000, runningOpsSameKind: [],
      pendingOpsSameKind: [{ id: "healthy", kind: "migrate-user", createdAt: 2,
        input: { toGatewayId: "shared-b" } }],
    })).toEqual({ outcome: "queue", waitingOn: "migration → shared-b" });
  });

  it("keeps FIFO for work arriving after an eligible retry was requeued", () => {
    expect(decideOperationClaim({
      op: { id: "healthy", kind: "migrate-user", status: "pending", createdAt: 4,
        input: { toGatewayId: "shared-b" } },
      now: 10_000, runningOpsSameKind: [],
      pendingOpsSameKind: [{ id: "retry", kind: "migrate-user", createdAt: 1,
        queuedAt: 3, nextAttemptAt: 9_000, input: { toGatewayId: "shared-b" } }],
    })).toEqual({ outcome: "queue", waitingOn: "migration → shared-b" });
  });

  const now = 1_000_000;

  it("skips a doc that is no longer pending (already claimed by another process)", () => {
    const decision = decideOperationClaim({
      op: { id: "op-1", kind: "rollout", status: "running", createdAt: 1 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "skip" });
  });

  it("skips a pending op whose backoff window hasn't elapsed yet", () => {
    const decision = decideOperationClaim({
      op: { id: "op-1", kind: "rollout", status: "pending", createdAt: 1, nextAttemptAt: now + 5_000 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "skip" });
  });

  it("claims a pending op whose backoff window has elapsed", () => {
    const decision = decideOperationClaim({
      op: { id: "op-1", kind: "rollout", status: "pending", createdAt: 1, nextAttemptAt: now - 1 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });

  it("claims a pending op with no conflict and no backoff", () => {
    const decision = decideOperationClaim({
      op: { id: "op-2", kind: "rollout", status: "pending", createdAt: 1 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });

  it("claims the next migration on the same gateways once the running one has committed its cutover", () => {
    const decision = decideOperationClaim({
      op: {
        id: "next-migration",
        kind: "migrate-user",
        status: "pending",
        createdAt: 2,
        input: { fromGatewayId: "shared-0", toGatewayId: "shared-1" },
      },
      now,
      runningOpsSameKind: [{
        id: "cleaning-up",
        kind: "migrate-user",
        cutoverCommittedAt: now - 1_000,
        input: { fromGatewayId: "shared-0", toGatewayId: "shared-1" },
      }],
      pendingOpsSameKind: [{
        id: "retrying-cleanup",
        kind: "migrate-user",
        createdAt: 1,
        nextAttemptAt: now + 30_000,
        cutoverCommittedAt: now - 5_000,
        input: { fromGatewayId: "shared-0", toGatewayId: "shared-1" },
      }],
    });

    expect(decision).toEqual({ outcome: "claim" });
  });

  it("queues a Native source rollout while post-cutover return cleanup is running", () => {
    const rollout = { id: "roll", kind: "rollout", status: "pending", createdAt: 2, rolloutLane: "builder-vm" as const, input: { gatewayId: "builder-0" } };
    const returning = { id: "builder-return-builder-0-g1", kind: "migrate-user", cutoverCommittedAt: now - 1,
      input: { source: "builder-activation-lease", fromGatewayId: "builder-0", toGatewayId: "shared-0" } };
    expect(decideOperationClaim({ op: rollout, now, runningOpsSameKind: [returning], pendingOpsSameKind: [] })).toMatchObject({ outcome: "queue" });
    expect(decideOperationClaim({ op: rollout, now, runningOpsSameKind: [], pendingOpsSameKind: [{ ...returning, createdAt: 1, nextAttemptAt: now + 30_000 }] })).toMatchObject({ outcome: "queue" });
    expect(decideOperationClaim({ op: { ...rollout, input: { gatewayId: "builder-1" } }, now, runningOpsSameKind: [returning], pendingOpsSameKind: [] })).toEqual({ outcome: "claim" });
    expect(decideOperationClaim({ op: rollout, now, runningOpsSameKind: [], pendingOpsSameKind: [] })).toEqual({ outcome: "claim" });
  });

  it.each([undefined, now + 1_000])("keeps a pending post-cutover Native return ahead of an older source rollout (queuedAt=%s)", (queuedAt) => {
    const rollout = { id: "roll", kind: "rollout", origin: "operator", status: "pending", createdAt: 1, rolloutLane: "builder-vm" as const, input: { gatewayId: "builder-0" } };
    const returning = { id: "builder-return-builder-0-g1", kind: "migrate-user", createdAt: 2, queuedAt, nextAttemptAt: now + 30_000, cutoverCommittedAt: now - 1,
      input: { source: "builder-activation-lease", fromGatewayId: "builder-0", toGatewayId: "shared-0" } };
    expect(decideOperationClaim({ op: rollout, now, runningOpsSameKind: [], pendingOpsSameKind: [returning] })).toMatchObject({ outcome: "queue" });
    expect(decideOperationClaim({ op: { ...returning, status: "pending", nextAttemptAt: now }, now, runningOpsSameKind: [], pendingOpsSameKind: [rollout] })).toEqual({ outcome: "claim" });
  });

  it("keeps a sleeping durable migration's gateway lock", () => {
    const decision = decideOperationClaim({
      op: {
        id: "next-migration",
        kind: "migrate-user",
        status: "pending",
        createdAt: 2,
        input: { fromGatewayId: "other", toGatewayId: "default-b" },
      },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [{
        id: "durable-migration",
        kind: "migrate-user",
        createdAt: 1,
        nextAttemptAt: now + 30_000,
        input: { fromGatewayId: "default", toGatewayId: "default-b" },
      }],
    });

    expect(decision).toEqual({
      outcome: "queue",
      waitingOn: "migration default → default-b",
    });
  });

  it("queues instead of failing when a conflicting rollout is running", () => {
    const decision = decideOperationClaim({
      op: { id: "op-2", kind: "rollout", status: "pending", createdAt: 2 },
      now,
      runningOpsSameKind: [
        { id: "op-1", kind: "rollout", input: { gatewayId: "walter-blue" } },
      ],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({
      outcome: "queue",
      waitingOn: "roll walter-blue",
    });
  });

  it("claims kinds with no known hard-fail-on-busy path even when others of the same kind are running", () => {
    const decision = decideOperationClaim({
      op: { id: "op-2", kind: "retire-gateway", status: "pending", createdAt: 2 },
      now,
      runningOpsSameKind: [{ id: "op-1", kind: "retire-gateway", input: { gatewayId: "walter-green" } }],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });

  it("queues a migrate-customer op behind another one targeting the same gateway", () => {
    const decision = decideOperationClaim({
      op: {
        id: "op-2",
        kind: "migrate-user",
        status: "pending",
        createdAt: 2,
        input: { toGatewayId: "gw-green" },
      },
      now,
      runningOpsSameKind: [
        { id: "op-1", kind: "migrate-user", input: { toGatewayId: "gw-green" } },
      ],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "queue", waitingOn: "migration → gw-green" });
  });

  it("claims a migrate-customer op whose target differs from the running one", () => {
    const decision = decideOperationClaim({
      op: {
        id: "op-2",
        kind: "migrate-user",
        status: "pending",
        createdAt: 2,
        input: { toGatewayId: "gw-purple" },
      },
      now,
      runningOpsSameKind: [
        { id: "op-1", kind: "migrate-user", input: { toGatewayId: "gw-green" } },
      ],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });
});

describe("decideOperationClaim — FIFO per scope (an older pending op blocks a newer claimer)", () => {
  const now = 1_000_000;

  it("queues behind an OLDER same-scope pending rollout even when nothing is running — the fast path must not let a newcomer jump the queue", () => {
    const decision = decideOperationClaim({
      op: { id: "op-new", kind: "rollout", status: "pending", createdAt: 3 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [
        { id: "op-old", kind: "rollout", createdAt: 2, input: { gatewayId: "walter-blue" } },
      ],
    });
    expect(decision).toEqual({
      outcome: "queue",
      waitingOn: "roll walter-blue",
    });
  });

  it("claims when the other same-scope pending op is NEWER (this op is the head of the queue)", () => {
    const decision = decideOperationClaim({
      op: { id: "op-old", kind: "rollout", status: "pending", createdAt: 2 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [
        { id: "op-new", kind: "rollout", createdAt: 3, input: { gatewayId: "default-green" } },
      ],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });

  it("tiebreaks equal createdAt by op id so exactly one of the two claims", () => {
    const blocked = decideOperationClaim({
      op: { id: "op-b", kind: "rollout", status: "pending", createdAt: 2 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [
        { id: "op-a", kind: "rollout", createdAt: 2, input: { gatewayId: "walter-blue" } },
      ],
    });
    expect(blocked.outcome).toBe("queue");

    const admitted = decideOperationClaim({
      op: { id: "op-a", kind: "rollout", status: "pending", createdAt: 2 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [
        { id: "op-b", kind: "rollout", createdAt: 2, input: { gatewayId: "default-green" } },
      ],
    });
    expect(admitted).toEqual({ outcome: "claim" });
  });

  it("ignores older pending migrations to a DIFFERENT target — FIFO is per scope, not per kind", () => {
    const decision = decideOperationClaim({
      op: {
        id: "op-new",
        kind: "migrate-user",
        status: "pending",
        createdAt: 3,
        input: { toGatewayId: "gw-purple" },
      },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [
        { id: "op-old", kind: "migrate-user", createdAt: 2, input: { toGatewayId: "gw-green" } },
      ],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });

  it("queues behind an older pending migration to the SAME target", () => {
    const decision = decideOperationClaim({
      op: {
        id: "op-new",
        kind: "migrate-user",
        status: "pending",
        createdAt: 3,
        input: { toGatewayId: "gw-green" },
      },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [
        {
          id: "op-old",
          kind: "migrate-user",
          createdAt: 2,
          input: { fromGatewayId: "gw-blue", toGatewayId: "gw-green" },
        },
      ],
    });
    expect(decision).toEqual({
      outcome: "queue",
      waitingOn: "migration gw-blue → gw-green",
    });
  });

  it("never blocks itself when its own doc appears in the pending list", () => {
    const decision = decideOperationClaim({
      op: { id: "op-1", kind: "rollout", status: "pending", createdAt: 2 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [
        { id: "op-1", kind: "rollout", createdAt: 2, input: { gatewayId: "walter-blue" } },
      ],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });
});

describe("decideOperationClaim — account suspensions run one at a time", () => {
  const now = 1_000_000;
  const suspension = (id: string, createdAt: number, nextAttemptAt?: number) => ({
    id,
    kind: "suspend-user",
    status: "pending",
    createdAt,
    nextAttemptAt,
    input: { uid: `uid-${id}`, deletionId: `deletion-${id}` },
  });

  it("queues a suspension while another suspension is running", () => {
    const decision = decideOperationClaim({
      op: suspension("op-2", 2),
      now,
      runningOpsSameKind: [{ id: "op-1", kind: "suspend-user", input: { uid: "uid-op-1" } }],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "queue", waitingOn: "another account suspension" });
  });

  it("queues behind an older suspension that is waiting to run", () => {
    const decision = decideOperationClaim({
      op: suspension("op-2", 2),
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [suspension("op-1", 1)],
    });
    expect(decision).toEqual({ outcome: "queue", waitingOn: "another account suspension" });
  });

  it("does not wait behind an older suspension that failed and is backing off", () => {
    const decision = decideOperationClaim({
      op: suspension("op-2", 2),
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [suspension("op-1", 1, now + 30_000)],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });

  it("does not hold suspensions behind unrelated fleet work", () => {
    const decision = decideOperationClaim({
      op: suspension("op-2", 2),
      now,
      runningOpsSameKind: [
        { id: "roll", kind: "rollout", input: { gatewayId: "shared-a" } },
        { id: "move", kind: "migrate-user", input: { fromGatewayId: "shared-a", toGatewayId: "shared-b" } },
      ],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });
});
