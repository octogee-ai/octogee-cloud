import { describe, expect, it } from "vitest";
import { releasePayloadHash } from "@octogee/shared/types/gateway-releases";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import {
  commitRecoveredDisposableRuntimeResetAtomic,
  commitRecoveredDisposableRuntimeResetInTransaction,
  commitUnavailableGatewayRecoveryAtomic,
  commitUnavailableGatewayRecoveryInTransaction,
} from "./fleet-state.js";
import {
  continuousPlacementMigrationOperationId,
  enqueuePlacementMigrationInTransaction,
  supersedePendingSharedDrainMoveInTransaction,
} from "./placement-migrations.js";
import {
  placementOwnerRefusalBody,
  requireClientPlacementOwner,
  requireFleetControllerPlacementOwner,
  type PlacementOwnerFence,
} from "./placement-automation-owner.js";
import { appendSharedRollRecoveryInTransaction, supersedeRollingSharedGatewayRoll } from "./shared-gateway-roll-recovery.js";
import type { PlatformStateStore, PlatformStateTransaction } from "./platform-state/store.js";

const NOW = 1_762_500_000_000;
const UID = "uid-alice";
const SLUG = "alice";
const SOURCE = "shared-a";
const TARGET = "shared-b";
const PAYLOAD = { imageRepository: "registry.example/gateway", imageTag: "abc1234" };
const PREVIOUS_RECOVERY = `recover-disposable-${UID}-alice-xs-1-0`;

type Data = Record<string, unknown>;

class RecordedDocuments extends Map<string, Data> {
  readonly events: string[] = [];

  override set(path: string, row: Data): this {
    this.events?.push(`set:${path}`);
    return super.set(path, row);
  }
}

const YIELDED = { placementAutomationOwner: "client", placementAutomationYieldedAt: NOW - 1_000 };
const PENDING = { placementAutomationOwner: "client" };

function sharedRoot(gatewayId: string, overrides: Data = {}): Data {
  return {
    gatewayId, createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running", configSchemaVersion: 1,
    profile: null, gatewayClass: "shared", imageProfile: "standard", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: null, builderSlug: null, modelBrokerLimits: null, preemption: null, addedBy: "automation",
    ...overrides,
  };
}

function runtime(gatewayId: string, overrides: Data = {}): Data {
  return {
    docKind: "runtime", gatewayId, release: 1, lifecycle: "serving",
    heartbeat: { status: "ready", lastHeartbeatAt: NOW - 1_000, mountedCustomers: [] },
    kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: NOW - 1_000 },
    ...overrides,
  };
}

function assignment(gatewayId: string, overrides: Data = {}): Data {
  return {
    uid: UID, gatewayId, slug: SLUG, source: "onboarding", state: "serving", epoch: 3,
    createdAt: 1, updatedAt: 1, updatedByOperationId: null, ...overrides,
  };
}

function user(gatewayId: string): Data {
  return { username: SLUG, slug: SLUG, provisioning: { openclaw: { gatewayId, slug: SLUG, status: "complete" } } };
}

function poolSeed(): Record<string, Data> {
  return {
    [`gateways/${SOURCE}`]: sharedRoot(SOURCE),
    [`gateways/${TARGET}`]: sharedRoot(TARGET),
    [`glmGateways/${TARGET}`]: runtime(TARGET),
    [`gateways/${SOURCE}/assignments/${UID}`]: assignment(SOURCE),
    [`users/${UID}`]: user(SOURCE),
  };
}

function recoveredSeed(): Record<string, Data> {
  return {
    [`gateways/${TARGET}`]: sharedRoot(TARGET),
    [`glmGateways/${TARGET}`]: runtime(TARGET),
    [`gateways/${TARGET}/assignments/${UID}`]: assignment(TARGET, { epoch: 4, source: "repair", updatedByOperationId: PREVIOUS_RECOVERY }),
    [`users/${UID}`]: user(TARGET),
    [`glmOperations/${PREVIOUS_RECOVERY}`]: {
      kind: "migrate-user", status: "succeeded", origin: "automatic", createdBy: "glm-controller-placement-policy",
      gatewayId: TARGET, inputUid: UID,
      input: {
        uid: UID, slug: SLUG, recoveryKind: "recover-disposable-customer", fromGatewayId: "alice-xs-1", toGatewayId: TARGET,
        sourceEpoch: 3, disposableLease: { leaseId: "lease-one", generation: 1 },
      },
      steps: [],
    },
  };
}

function rollingSeed(): Record<string, Data> {
  return {
    [`gateways/${SOURCE}`]: sharedRoot(SOURCE),
    [`glmGateways/${SOURCE}`]: runtime(SOURCE, { kubernetes: { status: "missing", totalPods: 0, readyPods: 0, observedAt: NOW - 1_000 } }),
    [`gateways/${TARGET}`]: sharedRoot(TARGET, { latestRelease: 2, desiredRelease: 2, liveRelease: 1 }),
    [`glmGateways/${TARGET}`]: runtime(TARGET),
    [`gateways/${TARGET}/releases/1`]: { gatewayId: TARGET, release: 1, payload: PAYLOAD, payloadHash: releasePayloadHash(PAYLOAD) },
  };
}

function fixture(orchestrator: Data | null, rows: Record<string, Data>) {
  const documents = new RecordedDocuments([
    ...Object.entries(rows),
    ...(orchestrator === null ? [] : [["config/orchestrator", orchestrator] as [string, Data]]),
  ]);
  documents.events.length = 0;
  return { documents, store: createDocumentFixtureStore(documents, { serializeTransactions: true }) };
}

function placementEvents(documents: RecordedDocuments): string[] {
  return documents.events.filter((event) => !event.includes("glmOperations/audit-"));
}

const RECOVERY = `recover-shared-${UID}-${SOURCE}-3`;
const RESET = `recover-disposable-reset-${UID}-${TARGET}-4`;
const ROLL = `recover-shared-roll-${SOURCE}-to-${TARGET}-r2-to-r1`;
const PLACEMENT = continuousPlacementMigrationOperationId({ uid: UID, builderSlug: SLUG, fromGatewayId: SOURCE, toGatewayId: TARGET, sourceAssignmentEpoch: 3 });

const recoveryParams = {
  operationId: RECOVERY, kind: "recover-shared-customer" as const, uid: UID, slug: SLUG, fromGatewayId: SOURCE, toGatewayId: TARGET,
  expectedSourceEpoch: 3, sharedGatewayIds: [SOURCE, TARGET], targetHeartbeatMaxAgeMs: 60_000,
  validateTarget: async () => undefined,
};
const resetParams = {
  operationId: RESET, previousRecoveryOperationId: PREVIOUS_RECOVERY, uid: UID, slug: SLUG, targetGatewayId: TARGET,
  expectedAssignmentEpoch: 4, sharedGatewayIds: [TARGET], targetHeartbeatMaxAgeMs: 60_000,
};
const rollInput = { sourceGatewayId: SOURCE, targetGatewayId: TARGET, expectedLiveRelease: 1, expectedDesiredRelease: 2 };

interface InProcessWrite {
  readonly name: string;
  readonly seed: () => Record<string, Data>;
  readonly write: (store: PlatformStateStore) => Promise<unknown>;
  readonly committed: string;
}

const IN_PROCESS_WRITES: InProcessWrite[] = [
  {
    name: "recovery from an unavailable shared gateway",
    seed: poolSeed,
    write: (store) => commitUnavailableGatewayRecoveryAtomic({ store, now: () => new Date(NOW) }, recoveryParams),
    committed: `glmOperations/${RECOVERY}`,
  },
  {
    name: "reset of a recovered isolated runtime",
    seed: recoveredSeed,
    write: (store) => commitRecoveredDisposableRuntimeResetAtomic({ store, now: () => new Date(NOW) }, resetParams),
    committed: `glmOperations/${RESET}`,
  },
  {
    name: "supersede of a rolling shared gateway",
    seed: rollingSeed,
    write: (store) => supersedeRollingSharedGatewayRoll({ store, now: () => NOW }, rollInput),
    committed: `glmOperations/${ROLL}`,
  },
];

function outcome(run: Promise<unknown>): Promise<unknown> {
  return run.then(() => undefined, (error: unknown) => error);
}

describe("in-process placement writes check the owner inside their transaction", () => {
  it.each(IN_PROCESS_WRITES)("refuses the $name once the fleet controller has yielded, writing no placement state", async ({ seed, write }) => {
    const { store, documents } = fixture(YIELDED, seed());

    const error = await outcome(write(store));

    expect(placementOwnerRefusalBody(error)).toEqual({
      code: "placement-owner",
      error: "the fleet controller has yielded placement automation to the client",
    });
    expect(placementEvents(documents)).toEqual([]);
  });

  it.each(IN_PROCESS_WRITES)("commits the $name by default and while the handoff awaits the yield", async ({ seed, write, committed }) => {
    for (const orchestrator of [null, PENDING]) {
      const { store, documents } = fixture(orchestrator, seed());

      await write(store);

      expect(documents.has(committed)).toBe(true);
    }
  });

  it("leaves no audit behind a refused supersede, so the same supersede runs after the hand-back", async () => {
    const { store, documents } = fixture(YIELDED, rollingSeed());
    const supersede = () => supersedeRollingSharedGatewayRoll({ store, now: () => NOW }, rollInput);
    expect(placementOwnerRefusalBody(await outcome(supersede()))?.code).toBe("placement-owner");
    expect([...documents.keys()].filter((path) => path.startsWith("glmOperations/audit-"))).toEqual([]);

    documents.set("config/orchestrator", { placementAutomationOwner: "fleet-controller" });

    expect(await supersede()).toEqual({ kind: "scheduled", release: 3, operationId: ROLL });
  });
});

const CONTEXT = {
  now: NOW, platformArtifact: null, operationJournalRetentionMs: 1_000,
  operationFailureIsTransient: () => false, gatewayStartupUnavailable: () => false, sourceRecoveryForwardRetryable: () => false,
};

interface GuardedWrite {
  readonly name: string;
  readonly seed: () => Record<string, Data>;
  readonly write: (transaction: PlatformStateTransaction, requireOwner: PlacementOwnerFence) => Promise<unknown>;
}

const GUARDED_WRITES: GuardedWrite[] = [
  {
    name: "commitUnavailableGatewayRecoveryInTransaction",
    seed: poolSeed,
    write: (transaction, requireOwner) => commitUnavailableGatewayRecoveryInTransaction(transaction, { ...recoveryParams, requireOwner }, NOW),
  },
  {
    name: "commitRecoveredDisposableRuntimeResetInTransaction",
    seed: recoveredSeed,
    write: (transaction, requireOwner) => commitRecoveredDisposableRuntimeResetInTransaction(transaction, { ...resetParams, requireOwner }, NOW),
  },
  {
    name: "appendSharedRollRecoveryInTransaction",
    seed: rollingSeed,
    write: (transaction, requireOwner) => appendSharedRollRecoveryInTransaction(transaction, rollInput, { now: NOW, requireOwner }),
  },
  {
    name: "enqueuePlacementMigrationInTransaction",
    seed: poolSeed,
    write: (transaction, requireOwner) => enqueuePlacementMigrationInTransaction(transaction, { ...CONTEXT, requireOwner }, {
      uid: UID, builderSlug: SLUG, fromGatewayId: SOURCE, toGatewayId: TARGET, source: "continuous-placement-policy", operationId: PLACEMENT,
    }),
  },
  {
    name: "supersedePendingSharedDrainMoveInTransaction",
    seed: poolSeed,
    write: (transaction, requireOwner) => supersedePendingSharedDrainMoveInTransaction(transaction, { ...CONTEXT, requireOwner }, {
      operationId: PLACEMENT, uid: UID, builderSlug: SLUG, fromGatewayId: SOURCE, toGatewayId: TARGET,
      leaseId: "lease-one", generation: 1, targetGatewayId: "alice-xs-1", activationOperationId: "builder-activate-alice-xs-1-g1",
    }),
  },
];

describe("every exported placement write takes the owner it asserts", () => {
  it.each(GUARDED_WRITES)("$name runs the owner check it is given before anything else", async ({ seed, write }) => {
    const { store, documents } = fixture(null, seed());
    const reads: string[] = [];
    const refusal = new Error("owner refused");

    const error = await outcome(store.transaction({ label: "test.guarded" }, (transaction) => write(transaction, async () => {
      reads.push("owner");
      throw refusal;
    })));

    expect(error).toBe(refusal);
    expect(reads).toEqual(["owner"]);
    expect(placementEvents(documents)).toEqual([]);
  });

  it.each(GUARDED_WRITES)("$name refuses the client while the fleet controller owns placement, and the fleet controller after the yield", async ({ seed, write }) => {
    const asClient = fixture(null, seed());
    const asFleetController = fixture(YIELDED, seed());

    const refusals = await Promise.all([
      outcome(asClient.store.transaction({ label: "test.client" }, (transaction) => write(transaction, requireClientPlacementOwner))),
      outcome(asFleetController.store.transaction({ label: "test.fleet-controller" }, (transaction) => write(transaction, requireFleetControllerPlacementOwner))),
    ]);

    expect(refusals.map((error) => placementOwnerRefusalBody(error)?.code)).toEqual(["placement-owner", "placement-owner"]);
    expect([...placementEvents(asClient.documents), ...placementEvents(asFleetController.documents)]).toEqual([]);
  });
});
