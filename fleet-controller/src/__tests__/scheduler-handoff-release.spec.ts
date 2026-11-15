import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { releaseAbandonedSchedulerHandoffs } from "../scheduler-handoff-release.js";

describe("abandoned forward migration fences", () => {
  it.each(["legacy", "v2"])("never resumes the old writer or aborts the target for a failed %s upgrade", async kind => {
    const schedulerHandoff = {
      migrationId: "stable", fromGatewayId: "old-native", toGatewayId: "new-shared", uid: "alice", slug: "alice",
      ...(kind === "legacy" ? { forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 4 } } : {}),
    };
    const operation = {
      kind: "migrate-user", status: "failed", schedulerHandoff, schedulerHandoffReleased: false,
      input: { uid: "alice", fromGatewayId: "old-native", toGatewayId: "new-shared" },
      ...(kind === "v2" ? { userMigrationV2: { phase: "sourceQuiesced" } } : {}),
      steps: [{ name: "quiesce-source", status: "done" }, { name: "final-sync-state", status: "failed" }],
    };
    const records = { "glmOperations/upgrade": operation };
    const store = createDocumentFixtureStore(records);
    const scheduler = vi.fn();
    const transaction = vi.spyOn(store, "transaction");
    expect(await releaseAbandonedSchedulerHandoffs({
      store, gatewayExists: vi.fn(async () => true), scheduler, log: vi.fn(), now: () => 1000,
    })).toEqual({ released: 0 });
    expect(scheduler).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(records["glmOperations/upgrade"]).toBe(operation);
  });

  it("keeps releasing other handoffs when one operation's records are malformed", async () => {
    const handoff = (uid: string) => ({ migrationId: `mig-${uid}`, fromGatewayId: "shared-a", toGatewayId: "shared-b", uid, slug: uid });
    const records: Record<string, Record<string, unknown>> = {
      "glmOperations/committed": { kind: "migrate-user", status: "failed", schedulerHandoffReleased: false, cutoverCommittedAt: 900,
        schedulerHandoff: handoff("alice"), input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
        steps: [{ name: "quiesce-source", status: "done" }] },
      "users/alice": { provisioning: { openclaw: { gatewayId: 7 } } },
      "glmOperations/never-held": { kind: "migrate-user", status: "failed", schedulerHandoffReleased: false,
        schedulerHandoff: handoff("bob"), input: { uid: "bob", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
        steps: [{ name: "keys-sync-state", status: "failed" }] },
    };
    const log = vi.fn();
    expect(await releaseAbandonedSchedulerHandoffs({
      store: createDocumentFixtureStore(records), gatewayExists: async () => true, scheduler: vi.fn(), log, now: () => 1000,
    })).toEqual({ released: 1 });
    expect(records["glmOperations/never-held"]).toMatchObject({ schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 1000 });
    expect(records["glmOperations/committed"]).toMatchObject({ status: "failed", schedulerHandoffReleased: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("committed release failed"));
  });
});
