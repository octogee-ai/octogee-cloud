import { describe, expect, it, vi } from "vitest";
import { GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";

import { MigrationRpcError, MigrationTransportError } from "./fleet-migration-client.js";
import { setWorkspaceMigrationPhase } from "./fleet-state.js";
import { PlacementPreconditionFailed } from "./placement-refusal.js";
import {
  StrandedSourceResumeFailed,
  readStrandedSource,
  restoreStrandedSourceServing,
} from "./stranded-source-restore.js";

type Row = Record<string, unknown>;
type Records = Map<string, Row>;
type Step = [name: string, status: string];

const UID = "uid-ada", SLUG = "ada", SOURCE = "shared-a", TARGET = "shared-b", OP = "op-move-1";
const ASSIGNMENT = `gateways/${SOURCE}/assignments/${UID}`;
const USER = `users/${UID}`;
const OPERATION = `${GLM_OPERATIONS_COLLECTION}/${OP}`;
const QUIESCED: Step[] = [["keys-sync-state", "done"], ["pre-sync-state", "done"], ["wait-for-active-work", "done"], ["quiesce-source", "done"]];
const ROLLBACK_LEFT_SOURCE_CLOSED: Step[] = [["rollback:unmount-target", "done"], ["rollback:resume-ingress", "failed"]];
const INCIDENT: Step[] = [...QUIESCED, ["flush-source", "failed"], ...ROLLBACK_LEFT_SOURCE_CLOSED];

function steps(shape: readonly Step[]): Row[] {
  return shape.map(([name, status]) => ({ name, status, ...(status === "failed" ? { error: `${name} answered 500` } : {}) }));
}

function move(id: string, fields: Row = {}): Row {
  return {
    kind: "migrate-user", status: "failed", createdBy: "operator", createdAt: 1, startedAt: 1_000, completedAt: 2_000,
    error: "flush-source answered 500 — source ingress on shared-a not resumed: resume failed",
    input: { uid: UID, userSlug: SLUG, fromGatewayId: SOURCE, toGatewayId: TARGET },
    steps: steps(INCIDENT), gatewayId: TARGET, inputUid: UID, rolledBack: false, id, ...fields,
  };
}

function stranded(): Records {
  return new Map<string, Row>(Object.entries({
    "config/orchestrator": { defaultGatewayId: SOURCE, sharedGatewayIds: [SOURCE, TARGET] },
    [ASSIGNMENT]: {
      uid: UID, slug: SLUG, gatewayId: SOURCE, source: "onboarding", state: "quiescing", epoch: 3,
      createdAt: 1, updatedAt: 1_500, updatedByOperationId: OP,
    },
    [USER]: {
      username: SLUG,
      provisioning: { status: "complete", openclaw: {
        slug: SLUG, status: "complete", gatewayId: SOURCE,
        migration: { state: "moving", phase: "transferring", operationId: OP, startedAt: 1_000 },
      } },
    },
    [OPERATION]: move(OP),
  }));
}

function patch(records: Records, path: string, fields: Row): void {
  records.set(path, { ...records.get(path)!, ...fields });
}

function patchOpenclaw(records: Records, fields: Row): void {
  const user = records.get(USER)!;
  const provisioning = user.provisioning as { openclaw: Row };
  records.set(USER, { ...user, provisioning: { ...provisioning, openclaw: { ...provisioning.openclaw, ...fields } } });
}

function openclaw(records: Records): Row {
  return (records.get(USER)!.provisioning as { openclaw: Row }).openclaw;
}

function harness(records: Records, resume: () => Promise<void> = async () => undefined) {
  const resumeSourceIngress = vi.fn(resume);
  const log = vi.fn();
  const store = createDocumentFixtureStore(records, { serializeTransactions: true });
  const deps = { store, resumeSourceIngress, log, now: () => new Date(5_000) };
  return { deps, store, resumeSourceIngress, log, restore: () => restoreStrandedSourceServing(deps, { uid: UID }) };
}

function snapshot(records: Records): string {
  return JSON.stringify([...records.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

async function refusal(run: Promise<unknown>): Promise<PlacementPreconditionFailed> {
  const error = await run.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(PlacementPreconditionFailed);
  return error as PlacementPreconditionFailed;
}

describe("a source left closed by a move whose rollback could not resume its ingress", () => {
  it("resumes the ingress once, then serves the user again and clears the move's fence", async () => {
    const records = stranded();
    const h = harness(records);

    const restored = await h.restore();

    expect(h.resumeSourceIngress.mock.calls).toEqual([[{ operationId: OP, gatewayId: SOURCE, slug: SLUG }]]);
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving", epoch: 3, updatedByOperationId: OP, updatedAt: 5_000 });
    expect(openclaw(records).migration).toBeUndefined();
    expect(openclaw(records).gatewayId).toBe(SOURCE);
    expect(records.get(OPERATION)).toEqual(stranded().get(OPERATION));
    expect(restored).toEqual({ uid: UID, slug: SLUG, gatewayId: SOURCE, operationId: OP, targetGatewayId: TARGET, state: "serving" });
  });

  it("writes the serving state only after the ingress resumed", async () => {
    const records = stranded();
    const seen: unknown[] = [];
    const h = harness(records, async () => {
      seen.push(records.get(ASSIGNMENT)!.state, openclaw(records).migration !== undefined);
    });

    await h.restore();

    expect(seen).toEqual(["quiescing", true]);
  });

  it.each<[string, Step[]]>([
    ["the quiesce itself failed", [...QUIESCED.slice(0, 3), ["quiesce-source", "failed"], ...ROLLBACK_LEFT_SOURCE_CLOSED]],
    ["the final copy failed", [...QUIESCED, ["flush-source", "done"], ["final-sync-state", "failed"], ...ROLLBACK_LEFT_SOURCE_CLOSED]],
    ["the target check failed", [...QUIESCED, ["flush-source", "done"], ["final-sync-state", "done"], ["verify-target", "failed"], ...ROLLBACK_LEFT_SOURCE_CLOSED]],
    ["the ingress resumed but the serving write was lost", [...QUIESCED, ["flush-source", "failed"], ["rollback:unmount-target", "done"], ["rollback:resume-ingress", "done"]]],
  ])("also restores the source when %s", async (_name, shape) => {
    const records = stranded();
    patch(records, OPERATION, { steps: steps(shape) });
    const h = harness(records);

    await h.restore();

    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(1);
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving" });
  });

  it("restores the source when the move's fence is already gone", async () => {
    const records = stranded();
    patchOpenclaw(records, { migration: undefined });
    const h = harness(records);

    await h.restore();

    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving" });
    expect(openclaw(records).migration).toBeUndefined();
  });

  it("refuses a repeat after the source serves again: nothing is left to restore", async () => {
    const records = stranded();
    const h = harness(records);
    await h.restore();
    const after = snapshot(records);

    const refused = await refusal(h.restore());

    expect(refused.reasonCode).toBe("source-not-stranded");
    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(1);
    expect(snapshot(records)).toBe(after);
  });
});

describe("a precondition that does not hold", () => {
  const another = "op-move-2";
  const cases: Array<[string, (records: Records) => void, string, string]> = [
    ["the user does not exist", (r) => { r.delete(USER); }, "user-missing", `user ${UID} does not exist`],
    ["the user serves", (r) => patch(r, ASSIGNMENT, { state: "serving" }), "source-not-stranded", "no quiescing assignment"],
    ["the assignment names no operation", (r) => patch(r, ASSIGNMENT, { updatedByOperationId: null }), "source-not-stranded", "names no operation"],
    ["the assignment is owned by an operation that is not a user move", (r) => patch(r, OPERATION, { kind: "rollout", input: { gatewayId: SOURCE } }),
      "source-not-stranded", "is not a user move"],
    ["the assignment is owned by another user's move", (r) => patch(r, OPERATION, { input: { uid: "uid-bo", userSlug: "bo", fromGatewayId: SOURCE, toGatewayId: TARGET } }),
      "source-not-stranded", "is not a user move"],
    ["the owning move left another gateway", (r) => patch(r, OPERATION, { input: { uid: UID, userSlug: SLUG, fromGatewayId: "shared-c", toGatewayId: TARGET } }),
      "source-not-stranded", "is not a user move"],
    ["the owning move names another slug", (r) => patch(r, OPERATION, { input: { uid: UID, userSlug: "bo", fromGatewayId: SOURCE, toGatewayId: TARGET } }),
      "source-not-stranded", "is not a user move"],
    ["the owning move names no target", (r) => patch(r, OPERATION, { input: { uid: UID, userSlug: SLUG, fromGatewayId: SOURCE } }),
      "source-not-stranded", "is not a user move"],
    ["the owning move is running", (r) => patch(r, OPERATION, { status: "running", completedAt: null }), "migration-in-flight", `${OP} is running`],
    ["the owning move is pending again", (r) => patch(r, OPERATION, { status: "pending", startedAt: null, completedAt: null }), "migration-in-flight", `${OP} is pending`],
    ["another operation for the user is pending", (r) => r.set(`${GLM_OPERATIONS_COLLECTION}/${another}`, move(another, { status: "pending", startedAt: null, completedAt: null, steps: [] })),
      "migration-in-flight", `${another} is pending`],
    ["an operation on the source gateway is running", (r) => r.set(`${GLM_OPERATIONS_COLLECTION}/restart-1`, {
      kind: "restart-gateway", status: "running", createdBy: "operator", createdAt: 1, startedAt: 2, completedAt: null,
      input: { gatewayId: SOURCE }, steps: [], gatewayId: SOURCE, id: "restart-1",
    }), "migration-in-flight", "restart-1 is running"],
    ["the owning move is no longer in the journal", (r) => { r.delete(OPERATION); }, "rollback-not-proven", "is not in the journal"],
    ["the owning move did not fail", (r) => patch(r, OPERATION, { status: "succeeded" }), "rollback-not-proven", "is succeeded"],
    ["the cutover committed", (r) => patch(r, OPERATION, { cutoverCommittedAt: 1_900 }), "rollback-not-proven", "committed its cutover"],
    ["the move holds forward migration state", (r) => patch(r, OPERATION, { userMigrationV2: { phase: "sourceQuiesced" } }), "rollback-not-proven", "forward"],
    ["the move holds a forward recovery checkpoint", (r) => patch(r, OPERATION, {
      schedulerHandoff: { migrationId: `mig-${OP}:scheduler:1:claim:1000`, uid: UID, slug: SLUG, fromGatewayId: SOURCE, toGatewayId: TARGET,
        forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 3 } },
    }), "rollback-not-proven", "forward"],
    ["a cancellation is pending", (r) => patch(r, OPERATION, { cancellationRequestedAt: 1_800 }), "rollback-not-proven", "cancellation"],
    ["the move is a source-only recovery", (r) => patch(r, OPERATION, { input: { uid: UID, userSlug: SLUG, fromGatewayId: SOURCE, toGatewayId: TARGET, recoverSourceOnly: true } }),
      "rollback-not-proven", "source-only recovery"],
    ["the assignment carries a forward recovery marker", (r) => patch(r, ASSIGNMENT, { sharedSurgeForwardRecovery: { operationId: OP, targetPodUid: "pod-1", receivingPodUid: "pod-1" } }),
      "rollback-not-proven", "forward recovery marker"],
    ["the target was not confirmed unmounted", (r) => patch(r, OPERATION, { steps: steps([...QUIESCED, ["flush-source", "failed"], ["rollback:unmount-target", "failed"]]) }),
      "rollback-not-proven", "recorded steps"],
    ["the rollback never reached the ingress", (r) => patch(r, OPERATION, { steps: steps([...QUIESCED, ["flush-source", "failed"], ["rollback:unmount-target", "done"]]) }),
      "rollback-not-proven", "recorded steps"],
    ["the ingress resume was still running", (r) => patch(r, OPERATION, { steps: steps([...QUIESCED, ["flush-source", "failed"], ["rollback:unmount-target", "done"], ["rollback:resume-ingress", "running"]]) }),
      "rollback-not-proven", "recorded steps"],
    ["the rollback reversed a cutover", (r) => patch(r, OPERATION, { steps: steps([...QUIESCED, ["flush-source", "done"], ["final-sync-state", "done"], ["verify-target", "done"],
      ["cutover-firestore", "done"], ["unmount-source", "failed"], ["rollback:cutover-firestore", "done"], ...ROLLBACK_LEFT_SOURCE_CLOSED]) }),
      "rollback-not-proven", "recorded steps"],
    ["the cutover write itself failed", (r) => patch(r, OPERATION, { steps: steps([...QUIESCED, ["flush-source", "done"], ["final-sync-state", "done"], ["verify-target", "done"],
      ["cutover-firestore", "failed"], ...ROLLBACK_LEFT_SOURCE_CLOSED]) }), "rollback-not-proven", "recorded steps"],
    ["the source was never quiesced", (r) => patch(r, OPERATION, { steps: steps([["keys-sync-state", "done"], ["pre-sync-state", "failed"], ...ROLLBACK_LEFT_SOURCE_CLOSED]) }),
      "rollback-not-proven", "recorded steps"],
    ["a step repeats", (r) => patch(r, OPERATION, { steps: steps([...INCIDENT, ["rollback:resume-ingress", "failed"]]) }), "rollback-not-proven", "recorded steps"],
    ["the steps are not recorded", (r) => patch(r, OPERATION, { steps: [] }), "rollback-not-proven", "recorded steps"],
    ["the user moved to the target", (r) => patchOpenclaw(r, { gatewayId: TARGET }), "fleet-state-changed", `is assigned to ${TARGET}`],
    ["the user holds an assignment on the target", (r) => r.set(`gateways/${TARGET}/assignments/${UID}`, {
      uid: UID, slug: SLUG, gatewayId: TARGET, source: "migrate-user", state: "serving", epoch: 4, createdAt: 1_900, updatedAt: 1_900, updatedByOperationId: OP,
    }), "fleet-state-changed", `also holds an assignment on ${TARGET}`],
    ["the assignment is for another slug", (r) => patch(r, ASSIGNMENT, { slug: "bo" }), "source-not-stranded", "is not a user move"],
    ["the user's slug differs from the assignment and the move", (r) => {
      patch(r, ASSIGNMENT, { slug: "bo" });
      patch(r, OPERATION, { input: { uid: UID, userSlug: "bo", fromGatewayId: SOURCE, toGatewayId: TARGET } });
    }, "fleet-state-changed", "but its assignment"],
    ["a restore is unresolved", (r) => patchOpenclaw(r, { restoreFence: { operationId: "restore-1" } }), "fleet-state-changed", "restore outcome is unresolved"],
    ["a source transfer is unresolved", (r) => patchOpenclaw(r, { sourceTransferFence: { operationId: OP, sourceGatewayId: SOURCE, targetGatewayId: TARGET } }),
      "fleet-state-changed", "source transfer outcome is unresolved"],
    ["the user's migration fence names another operation", (r) => patchOpenclaw(r, { migration: { state: "moving", phase: "transferring", operationId: another, startedAt: 1_000 } }),
      "fleet-state-changed", `migration fence names ${another}`],
  ];

  it.each(cases)("refuses and changes nothing when %s", async (_name, violate, reasonCode, message) => {
    const records = stranded();
    violate(records);
    const before = snapshot(records);
    const h = harness(records);

    const refused = await refusal(h.restore());

    expect(refused).toMatchObject({ reasonCode });
    expect(refused.message).toContain(message);
    expect(h.resumeSourceIngress).not.toHaveBeenCalled();
    expect(snapshot(records)).toBe(before);
  });

  it.each(cases)("answers the read-only check the same way when %s", async (_name, violate, reasonCode) => {
    const records = stranded();
    violate(records);

    const refused = await refusal(readStrandedSource(createDocumentFixtureStore(records), UID));

    expect(refused.reasonCode).toBe(reasonCode);
  });

  it("names the stranded source in the read-only check without resuming or writing", async () => {
    const records = stranded();
    const before = snapshot(records);

    await expect(readStrandedSource(createDocumentFixtureStore(records), UID)).resolves.toEqual({
      uid: UID, slug: SLUG, gatewayId: SOURCE, epoch: 3, assignmentUpdatedAt: 1_500, operationId: OP, targetGatewayId: TARGET,
    });
    expect(snapshot(records)).toBe(before);
  });
});

describe("a resume the source gateway does not complete", () => {
  it.each<[string, Error, boolean]>([
    ["answers with an error", new MigrationRpcError("/resume/shared-a failed: 500 resume failed", { status: 500 }), true],
    ["cannot be reached", new MigrationTransportError("/resume/shared-a transport failed: connect ECONNREFUSED"), false],
  ])("changes nothing and reports the failure when the gateway %s", async (_name, cause, gatewayAnswered) => {
    const records = stranded();
    const before = snapshot(records);
    const h = harness(records, async () => { throw cause; });

    const error = await h.restore().then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(StrandedSourceResumeFailed);
    expect(error).toMatchObject({ gatewayId: SOURCE, operationId: OP, gatewayAnswered, cause });
    expect((error as Error).message).toContain(cause.message);
    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(1);
    expect(snapshot(records)).toBe(before);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining(`source ingress on ${SOURCE} not resumed`));
  });
});

describe("a change between the check and the write", () => {
  it("refuses when the owning move was re-armed while the ingress resumed", async () => {
    const records = stranded();
    const h = harness(records, async () => patch(records, OPERATION, { status: "pending", startedAt: null, completedAt: null }));

    const refused = await refusal(h.restore());

    expect(refused.reasonCode).toBe("migration-in-flight");
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "quiescing", updatedAt: 1_500 });
    expect(openclaw(records).migration).toMatchObject({ operationId: OP });
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("resumed but the assignment was not restored"));
  });

  it("refuses when the assignment was rewritten while the ingress resumed", async () => {
    const records = stranded();
    const h = harness(records, async () => patch(records, ASSIGNMENT, { updatedAt: 1_600 }));

    const refused = await refusal(h.restore());

    expect(refused.reasonCode).toBe("fleet-state-changed");
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "quiescing", updatedAt: 1_600 });
    expect(openclaw(records).migration).toMatchObject({ operationId: OP });
  });
});

describe("the next move of a user whose source was stranded", () => {
  const next = "op-move-2";
  const startNextMove = (records: Records) => {
    records.set(`${GLM_OPERATIONS_COLLECTION}/${next}`, move(next, { status: "running", startedAt: 6_000, completedAt: null, steps: [] }));
    return setWorkspaceMigrationPhase({ store: createDocumentFixtureStore(records), now: () => new Date(6_100) }, {
      uid: UID, sourceGatewayId: SOURCE, operationId: next, phase: "preparing",
    });
  };

  it("is refused while the failed move still holds the fence", async () => {
    await expect(startNextMove(stranded())).rejects.toThrow("workspace migration phase authority changed");
  });

  it("takes the fence after the source is restored", async () => {
    const records = stranded();
    await harness(records).restore();

    await expect(startNextMove(records)).resolves.toBeUndefined();
    expect(openclaw(records).migration).toMatchObject({ state: "preparing", phase: "preparing", operationId: next });
  });
});
