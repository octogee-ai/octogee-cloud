import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
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

  describe("a failed forward migration whose user left both gateways", () => {
    const failedForward = (extra: Record<string, unknown> = {}) => ({
      kind: "migrate-user", status: "failed", schedulerHandoffReleased: false,
      schedulerHandoff: { migrationId: "stuck", fromGatewayId: "shared-old", toGatewayId: "shared-new", uid: "alice", slug: "alice",
        forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 15 } },
      input: { uid: "alice", fromGatewayId: "shared-old", toGatewayId: "shared-new" },
      steps: [{ name: "quiesce-source", status: "done" }, { name: "final-sync-state", status: "failed" }],
      ...extra,
    });
    const run = async (records: Record<string, Record<string, unknown>>, liveGateways: readonly string[]) => {
      const scheduler = vi.fn();
      const log = vi.fn();
      const result = await releaseAbandonedSchedulerHandoffs({
        store: createDocumentFixtureStore(records), gatewayExists: async id => liveGateways.includes(id), scheduler, log, now: () => 2000,
      });
      return { result, scheduler, log };
    };

    it("closes the fence once the source is retired and the user holds no gateway", async () => {
      const records: Record<string, Record<string, unknown>> = { "glmOperations/stuck": failedForward(), "users/alice": {} };
      const { result, scheduler, log } = await run(records, ["shared-new"]);
      expect(result).toEqual({ released: 1 });
      expect(records["glmOperations/stuck"]).toMatchObject({ status: "failed", schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 2000 });
      expect(scheduler).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("closed stuck forward recovery"));
    });

    it.each([
      ["the source still runs", ["shared-old", "shared-new"], {}, {}],
      ["the user still holds a gateway", ["shared-new"], { provisioning: { openclaw: { gatewayId: "shared-new" } } }, {}],
      ["the cutover was committed", ["shared-new"], {}, { cutoverCommittedAt: 1500 }],
      ["the user is served on a shared gateway", ["shared-new"], {}, {}, {
        "gateways/shared-other/assignments/alice": { uid: "alice", slug: "alice", gatewayId: "shared-other", source: "onboarding", state: "serving", epoch: 3 },
      }],
    ])("keeps the fence while %s", async (_case, live, user, extra, assignments: Record<string, Record<string, unknown>> = {}) => {
      const records: Record<string, Record<string, unknown>> = { "glmOperations/stuck": failedForward(extra), "users/alice": user, ...assignments };
      const { result } = await run(records, live);
      expect(result).toEqual({ released: 0 });
      expect(records["glmOperations/stuck"]).toMatchObject({ schedulerHandoffReleased: false });
    });
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
