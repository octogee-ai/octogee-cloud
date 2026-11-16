import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { commitRecoveredDisposableRuntimeResetAtomic, commitUnavailableGatewayRecoveryAtomic } from "./fleet-state.js";
import { placementOwnerRefusalBody } from "./placement-automation-owner.js";
import { supersedeRollingSharedGatewayRoll } from "./shared-gateway-roll-recovery.js";
import type { PlatformStateStore } from "./platform-state/store.js";

const NOW = 1_762_500_000_000;

type Data = Record<string, unknown>;

class RecordedDocuments extends Map<string, Data> {
  readonly events: string[] = [];

  override set(path: string, row: Data): this {
    this.events?.push(`set:${path}`);
    return super.set(path, row);
  }
}

function fixture(orchestrator: Data | null) {
  const documents = new RecordedDocuments(orchestrator === null ? [] : [["config/orchestrator", orchestrator]]);
  documents.events.length = 0;
  return { documents, store: createDocumentFixtureStore(documents, { serializeTransactions: true }) };
}

const YIELDED = { placementAutomationOwner: "client", placementAutomationYieldedAt: NOW - 1_000 };
const PENDING = { placementAutomationOwner: "client" };

const IN_PROCESS_WRITES: Array<[string, (store: PlatformStateStore) => Promise<unknown>]> = [
  ["recovery from an unavailable shared gateway", (store) => commitUnavailableGatewayRecoveryAtomic({ store, now: () => new Date(NOW) }, {
    operationId: "recover-shared-uid-alice-shared-a-3",
    kind: "recover-shared-customer",
    uid: "uid-alice",
    slug: "alice",
    fromGatewayId: "shared-a",
    toGatewayId: "shared-b",
    expectedSourceEpoch: 3,
    sharedGatewayIds: ["shared-a", "shared-b"],
    targetHeartbeatMaxAgeMs: 60_000,
  })],
  ["reset of a recovered isolated runtime", (store) => commitRecoveredDisposableRuntimeResetAtomic({ store, now: () => new Date(NOW) }, {
    operationId: "recover-disposable-reset-uid-alice-shared-b-4",
    previousRecoveryOperationId: "recover-disposable-uid-alice",
    uid: "uid-alice",
    slug: "alice",
    targetGatewayId: "shared-b",
    expectedAssignmentEpoch: 4,
    sharedGatewayIds: ["shared-b"],
    targetHeartbeatMaxAgeMs: 60_000,
  })],
  ["supersede of a rolling shared gateway", (store) => supersedeRollingSharedGatewayRoll({ store, now: () => NOW }, {
    sourceGatewayId: "shared-a",
    targetGatewayId: "shared-b",
    expectedLiveRelease: 1,
    expectedDesiredRelease: 2,
  })],
];

function outcome(run: Promise<unknown>): Promise<unknown> {
  return run.then(() => undefined, (error: unknown) => error);
}

describe("in-process placement writes check the owner inside their transaction", () => {
  it.each(IN_PROCESS_WRITES)("refuses the %s once the fleet controller has yielded, writing no placement state", async (_name, write) => {
    const { store, documents } = fixture(YIELDED);

    const error = await outcome(write(store));

    expect(placementOwnerRefusalBody(error)).toEqual({
      code: "placement-owner",
      error: "the fleet controller has yielded placement automation to the client",
    });
    expect(documents.events.filter((event) => !event.includes("glmOperations/audit-"))).toEqual([]);
  });

  it.each(IN_PROCESS_WRITES)("reaches its own fences for the %s by default and while the handoff awaits the yield", async (_name, write) => {
    for (const orchestrator of [null, PENDING]) {
      const error = await outcome(write(fixture(orchestrator).store));

      expect(placementOwnerRefusalBody(error)).toBeNull();
    }
  });
});
