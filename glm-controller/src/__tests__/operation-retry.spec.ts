import type { Operation } from "@octogee/shared/types/glm";
import { describe, expect, it } from "vitest";
import {
  MAX_OPERATION_ATTEMPTS,
  MAX_PREEMPTED_OPERATION_ATTEMPTS,
  MAX_REQUESTED_RETRY_DELAY_MS,
  MAX_OPERATION_ATTEMPT_HISTORY,
  MAX_OPERATOR_ISOLATED_GATEWAY_WAIT_ATTEMPTS,
  OPERATOR_ISOLATED_GATEWAY_WAIT_MS,
  OPERATION_JOURNAL_RETENTION_MS,
  buildOperationCompletionUpdate,
  classifyOperationFailure,
  retryBackoffMs,
  shouldPersistClaimedOperationCompletion,
  supersededRollMigrationAction,
  operationNeedsDurableRestartResume,
  verifiedDeletionCompletion,
} from "../operation-retry";

const UNCONVERGED_SOURCE_ERROR =
  '/push-rsync-state/shared-45b73f50e990: 409 {"error":"source mount refused","message":"[migration-activation:livefixture] source has no converged configuration for livefixture: its configuration was permanently refused (config.patch would remove entries from array path(s): agents.entries.octogee-unmatched-route.tools.deny); nothing converged to carry; park and release the user so placement mounts it fresh, or erase it"}';

describe("PostgreSQL source recovery health retries", () => {
  const error = "source management health unconfirmed; outcome remains fenced";
  it("retains the owned source recovery beyond the attempt cap only for its exact unavailable health result", () => {
    const op = { kind: "restart-gateway" as const, startedAt: 1_000, attempts: MAX_OPERATION_ATTEMPTS,
      input: { gatewayId: "shared-source", sourceRecovery: { postgresAgentStores: [{ agentId: "octogee-alice-coach" }] } } };
    expect(buildOperationCompletionUpdate({ op, result: { success: false, steps: [], error }, steps: [], now: 2_000 }))
      .toMatchObject({ status: "pending", attempts: MAX_OPERATION_ATTEMPTS + 1 });
    for (const unrelated of ["source management health receipt invalid", "source repair is not ready; outcome remains fenced"]) {
      expect(buildOperationCompletionUpdate({ op, result: { success: false, steps: [], error: unrelated }, steps: [], now: 2_000 }).status).toBe("failed");
    }
    expect(buildOperationCompletionUpdate({ op: { ...op, input: { gatewayId: "shared-source", sourceRecovery: {} } },
      result: { success: false, steps: [], error }, steps: [], now: 2_000 }).status).toBe("failed");
  });
});

describe("Gateway credential retirement drain", () => {
  const error = "agent-store credential retirement failed (records preserved for retry): " +
    "Agent-store Gateway shared-0 still has database sessions";

  it("retries the stopped Gateway's remaining sessions with its claim and failed-attempt evidence intact", () => {
    const steps = [
      { name: "helm-uninstall", status: "done" as const },
      { name: "revoke-agent-store-credentials", status: "failed" as const, error: "Agent-store Gateway shared-0 still has database sessions" },
    ];
    expect(classifyOperationFailure(error)).toBe("transient");
    const update = buildOperationCompletionUpdate({
      op: { kind: "retire-gateway", startedAt: 1_000,
        input: { gatewayId: "shared-0", retirementClaimVersion: 1 } },
      result: { success: false, error, steps }, steps, now: 2_000,
    });
    expect(update).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: 32_000,
      attemptHistory: [{ attempt: 1, classification: "transient", error, steps }] });
    expect(update).not.toHaveProperty("input");
  });

  it.each([
    "agent-store credential retirement failed (records preserved for retry): permission denied",
    "agent-store credential retirement failed (records preserved for retry): Agent-store Gateway shared-0 ownership changed",
    "Agent-store Gateway shared-0 still has database sessions",
    `${error}; permission denied`,
    error.replace("shared-0", "SHARED-0"),
    error.replace("shared-0", "shared/foreign"),
  ])("keeps unrelated or malformed credential failures terminal: %s", (failure) => {
    expect(classifyOperationFailure(failure)).toBe("terminal");
  });
});

describe("migration retry queue position", () => {
  it("keeps an untouched compatibility wait pending past the normal retry cap", () => {
    const update = buildOperationCompletionUpdate({
      op: { kind: "migrate-user", attempts: MAX_OPERATION_ATTEMPTS },
      result: { success: false, steps: [], error: "gateway compatibility pending: status 503: old target", output: { gatewayCompatibilityPending: true } },
      steps: [], now: 10_000,
    });
    expect(update).toMatchObject({
      status: "pending", attempts: MAX_OPERATION_ATTEMPTS + 1,
      nextAttemptAt: 490_000, output: { gatewayCompatibilityPending: true },
    });
  });

  it("requeues a fully rolled-back migration at the time of each failed attempt", () => {
    const update = buildOperationCompletionUpdate({
      op: { kind: "migrate-user", attempts: 1 },
      result: { success: false, rolledBack: true, error: "runtime-update timed out", steps: [] },
      steps: [], now: 10_000,
    });
    expect(update).toMatchObject({ status: "pending", queuedAt: 10_000, nextAttemptAt: 130_000 });
  });

  it.each([
    { rolledBack: false },
    {},
    { rolledBack: true, output: { configCleanup: { migrationId: "held" } } },
  ])("does not release a migration with unconfirmed cleanup: %j", (result) => {
    const update = buildOperationCompletionUpdate({
      op: { kind: "migrate-user" },
      result: { success: false, error: "runtime-update timed out", steps: [], ...result },
      steps: [], now: 10_000,
    });
    expect(update.queuedAt).toEqual({ clear: true });
  });

  it.each(["initialized", "promotionIntent", "aborting"])("keeps durable migration authority during %s", (phase) => {
    const update = buildOperationCompletionUpdate({
      op: { kind: "migrate-user", userMigrationV2: { phase } as never },
      result: { success: false, rolledBack: true, error: "runtime-update timed out", steps: [] },
      steps: [], now: 10_000,
    });
    expect(update.queuedAt).toEqual({ clear: true });
  });

  it("moves an aborted durable migration to the queue tail after cleanup", () => {
    const update = buildOperationCompletionUpdate({
      op: { kind: "migrate-user", userMigrationV2: { phase: "aborted" } as never },
      result: { success: false, rolledBack: true, error: "runtime-update timed out", steps: [] },
      steps: [], now: 10_000,
    });
    expect(update).toMatchObject({ status: "pending", queuedAt: 10_000,
      userMigrationV2: { clear: true } });
  });

});

describe("verifiedDeletionCompletion", () => {
  it("keeps continuous placement pending while another migration owns the rsync listener", () => {
    const error = "rsync import port 30873 is already serving migrationId=mig-other slug=bob";
    expect(classifyOperationFailure(error)).toBe("transient");
    expect(buildOperationCompletionUpdate({
      op: { id: `placement-${"a".repeat(32)}`, kind: "migrate-user", origin: "automatic",
        input: { source: "continuous-placement-policy" }, startedAt: 1_000, attempts: 3 },
      result: { success: false, steps: [], error }, steps: [], now: 2_000,
    })).toMatchObject({ status: "pending", attempts: 4 });
    expect(classifyOperationFailure("rsync import credentials rejected")).toBe("terminal");
  });
  it.each([
    "/quiesce/user: 500 Agent alice-coach has not completed startup inspection and preparation. Inspection and writable admission continue after the Gateway listener binds.",
    "/quiesce/user: 500 agent alice-coach startup preparation was superseded",
    "/resume/shared: 500 gateway starting; retry shortly",
  ])("retries native startup availability without classifying database corruption as transient: %s", (error) => {
    expect(classifyOperationFailure(error)).toBe("transient");
    expect(classifyOperationFailure("agent alice-coach database corrupt; run Doctor")).toBe("terminal");
  });
  it("returns the durable deletion mapping only for a successful verified erasure", () => {
    expect(verifiedDeletionCompletion({
      steps: [],
      success: true,
      output: {
        archiveId: "archive-1",
        verifiedDeletion: { deletionId: "delete-1", archiveId: "archive-1" },
      },
    })).toEqual({ deletionId: "delete-1", archiveId: "archive-1" });
    expect(verifiedDeletionCompletion({
      steps: [],
      success: false,
      output: { verifiedDeletion: { deletionId: "delete-1", archiveId: "archive-1" } },
    })).toBeNull();
  });
});

describe("supersededRollMigrationAction", () => {
  it("cancels unstarted work but waits for running or cleanup-pending workers to finish", () => {
    expect(supersededRollMigrationAction({ status: "pending" })).toBe("cancel");
    expect(supersededRollMigrationAction({ status: "running" })).toBe("wait");
    expect(supersededRollMigrationAction({
      status: "pending",
      output: { configCleanup: { migrationId: "mig-1" } },
    })).toBe("wait");
    expect(supersededRollMigrationAction({ status: "failed" })).toBe("done");
    expect(supersededRollMigrationAction({ status: "rolled-back" })).toBe("done");
  });
});

describe("shouldPersistClaimedOperationCompletion", () => {
  it("does not let an in-memory worker overwrite a durably cancelled operation", () => {
    expect(shouldPersistClaimedOperationCompletion({ status: "running", startedAt: 100, claimedStartedAt: 100 })).toBe(true);
    expect(shouldPersistClaimedOperationCompletion({ status: "rolled-back", startedAt: 100, claimedStartedAt: 100 })).toBe(false);
    expect(shouldPersistClaimedOperationCompletion({ status: "failed", startedAt: 100, claimedStartedAt: 100 })).toBe(false);
  });

  it("does not let a stale executor overwrite an operation that was re-armed and claimed again", () => {
    expect(shouldPersistClaimedOperationCompletion({ status: "running", startedAt: 200, claimedStartedAt: 100 })).toBe(false);
    expect(shouldPersistClaimedOperationCompletion({ status: "running", startedAt: null, claimedStartedAt: 100 })).toBe(false);
  });
});

describe("operationNeedsDurableRestartResume", () => {
  it('re-drives only the journaled Shared restore restart variant after controller loss', () => {
    expect(operationNeedsDurableRestartResume({ kind: 'restart-gateway', input: { restoreRecovery: {} } })).toBe(true);
    expect(operationNeedsDurableRestartResume({ kind: 'restart-gateway', input: { gatewayId: 'shared-1' } })).toBe(false);
  });
  it("resumes an interrupted automatic user return rather than reaping its coordinated handoff", () => {
    const op = { id: "builder-return-native-g1", kind: "migrate-user", origin: "automatic", input: {
      source: "builder-activation-lease", fromGatewayId: "native", toGatewayId: "shared-0",
    } };
    expect(operationNeedsDurableRestartResume(op)).toBe(true);
    expect(operationNeedsDurableRestartResume({ ...op, id: "manual-move" })).toBe(false);
  });
  it.each(["suspend-user", "erase-user"])(
    "keeps an interrupted %s operation available for restart re-drive",
    (kind) => {
      expect(operationNeedsDurableRestartResume({ kind })).toBe(true);
    },
  );
});

describe("classifyOperationFailure", () => {
  it("retries a kubectl call rejected because this pod's service-account token was invalidated", () => {
    expect(
      classifyOperationFailure(
        "kubectl get pods transport=shared-7b9a93aaa306 failed: error: You must be logged in to the server (Unauthorized)",
      ),
    ).toBe("transient");
  });

  it("keeps an RBAC denial terminal", () => {
    expect(
      classifyOperationFailure(
        'kubectl get pods failed: Error from server (Forbidden): pods is forbidden: User "system:serviceaccount:octogee:glm-controller" cannot list resource "pods"',
      ),
    ).toBe("terminal");
  });

  it("classifies timeouts, K8s API hiccups, and preemption as transient", () => {
    expect(classifyOperationFailure("helm did not render walter-green@sha within 60000ms")).toBe(
      "transient",
    );
    expect(
      classifyOperationFailure("gateway walter-green never published a heartbeat with version=sha within 300000ms"),
    ).toBe("transient");
    expect(classifyOperationFailure("connect ECONNREFUSED 10.0.0.1:443")).toBe("transient");
    expect(classifyOperationFailure("request failed with status 503")).toBe("transient");
    expect(classifyOperationFailure("PostHog rate limited the erasure request (HTTP 429)")).toBe("transient");
    expect(classifyOperationFailure("context deadline exceeded")).toBe("transient");
    expect(classifyOperationFailure("instance preempted mid-warm")).toBe("transient");
    expect(
      classifyOperationFailure(
        "status 503: gateway default cannot activate release 3 while release 2 is not live",
      ),
    ).toBe("transient");
    expect(classifyOperationFailure("TypeError: fetch failed")).toBe("transient");
    expect(
      classifyOperationFailure(
        "/push-rsync-state/shared-0: 500 agent store /home/node/.openclaw/agents/octogee-ceckert-coach/agent/openclaw-agent.sqlite could not be checkpointed for carry: database is locked",
      ),
    ).toBe("transient");
    expect(classifyOperationFailure("response body terminated before completion")).toBe("transient");
    expect(classifyOperationFailure("premature close while reading response body")).toBe("transient");
    expect(classifyOperationFailure("Unexpected end of JSON input")).toBe("transient");
    expect(classifyOperationFailure("14 UNAVAILABLE: Firestore request failed")).toBe("transient");
    expect(
      classifyOperationFailure("gateway walter durable desired revision did not materialize within 120000ms"),
    ).toBe("transient");
    expect(classifyOperationFailure("config unfreeze cleanup pending: source RPC unavailable")).toBe(
      "transient",
    );
    expect(classifyOperationFailure("source unmount cleanup pending: source RPC unavailable")).toBe(
      "transient",
    );
    expect(
      classifyOperationFailure(
        "gateway walter retirement config freeze failed: openclaw config is dirty",
      ),
    ).toBe("transient");
    expect(
      classifyOperationFailure(
        '/restore/default: 500 {"error":"restore failed","message":"system config writer lock is busy"}',
      ),
    ).toBe("transient");
    expect(
      classifyOperationFailure(
        '/restore/default: 500 {"message":"channel did not connect; fleet will retry"}',
      ),
    ).toBe("transient");
    expect(
      classifyOperationFailure(
        "target gateway shared-b is not migration-ready " +
          "(desiredStatus=draining, desiredRelease=12, liveRelease=12); " +
          "requires running with a converged release",
      ),
    ).toBe("transient");
    expect(
      classifyOperationFailure(
        "[migration-http] local SSH public key is missing for alice",
      ),
    ).toBe("transient");
    expect(
      classifyOperationFailure(
        "[migration-activation:alice] source has no applied fingerprint; converge it before migration",
      ),
    ).toBe("transient");
  });

  it("classifies a source with no converged configuration for the user as terminal", () => {
    expect(classifyOperationFailure(UNCONVERGED_SOURCE_ERROR)).toBe("terminal");
  });

  it("classifies validation and the #2137 fail-fast target-state guard as terminal", () => {
    expect(classifyOperationFailure("missing gatewayId in op.input")).toBe("terminal");
    expect(classifyOperationFailure("glmGateways/walter-green not found — cannot roll out")).toBe(
      "terminal",
    );
    expect(
      classifyOperationFailure(
        "target walter-green already holds users at sha-1 — re-drive the roll at that tag first",
      ),
    ).toBe("terminal");
    expect(
      classifyOperationFailure(
        'blue/green sibling id "walter-blue-blue" is invalid (source "walter-blue" leaves no room for a colour suffix under the gateway-id limit)',
      ),
    ).toBe("terminal");
  });

  it.each([
    ["source quiesce load timeout", "/quiesce/shared-0 timed out after 60000ms (http://octogee-gateway-shared-0.octogee-test.svc.cluster.local:3003/quiesce/shared-0)"],
    ["scheduler hold load timeout", "/scheduler/shared-0 timed out after 60000ms (http://octogee-gateway-shared-0.octogee-test.svc.cluster.local:3003/scheduler/shared-0)"],
    ["gateway RPC socket dropped before the connect response", '/scheduler/shared-0: 500 {"error":"scheduler migration failed","message":"socket closed before connect response"}'],
    ["unmount socket dropped before the connect response", '/unmount/shared-0: 500 {"error":"unmount failed","message":"socket closed before connect response","code":"connect-failed"}'],
    ["scheduler fence still held by a handoff that has not settled", '/scheduler/shared-0: 500 {"error":"scheduler migration failed","message":"Cron agent octogee-sep17-coach is held for migration mig-placement-190929cbf8f86906bee813bffa1a4157:scheduler:1"}'],
    ["bounded quiesce that could not settle after the stop", "quiesce did not drain: 1 still running on shared-0 for slug=alice"],
    ["older provisioner's quiesce whose own hold did not drain", '/quiesce/shared-0: 500 {"error":"quiesce failed","message":"Scheduler runs are still draining for alice"}'],
    ["source gateway with no ready pod while OpenClaw restarts", "expected exactly one ready pod for transport=shared-50fedc9f5f74; found 0"],
    ["gateway with no running pod", "expected exactly one running pod for transport=shared-0; found 0"],
    ["gateway mid-roll with two ready pods", "expected exactly one ready pod for transport=shared-0; found 2"],
    ["Gateway VM whose OpenClaw has not initialized this boot's workspace identities", 'target gateway ceckert-s-7b9a4acb scheduler did not become ready within 120000ms: /scheduler/ceckert-s-7b9a4acb: 500 {"error":"scheduler migration failed","message":"OpenClaw workspace identities are not initialized for this boot"}'],
  ])("classifies a pre-cutover %s as transient so placement re-arms it", (_name, error) => {
    expect(classifyOperationFailure(error)).toBe("transient");
  });

  it.each([
    ["cutover already committed but the customer moved on", "migration cutover already committed to shared-1; customer now owned by shared-2 — source cleanup left to the eviction sweep"],
    ["declared source mismatch", "declared source shared-0 does not match resolved source shared-1"],
    ["user already on target", "user already on shared-1"],
    ["scheduler proof failure", "scheduler hold did not prove a drained matching operation"],
    ["a socket message that is not the connect drop", "socket hang up while writing"],
  ])("keeps %s terminal", (_name, error) => {
    expect(classifyOperationFailure(error)).toBe("terminal");
  });

  it("classifies the gateway mutation writer-lock-busy response as transient", () => {
    expect(
      classifyOperationFailure(
        "finish-rsync-import failed: system config mutation unavailable: writer-lock-busy",
      ),
    ).toBe("transient");
  });

  it("defaults to terminal for an unrecognized cause — fail fast rather than retry blind", () => {
    expect(classifyOperationFailure("some never-seen-before error string")).toBe("terminal");
  });

  it("treats a missing error message as terminal", () => {
    expect(classifyOperationFailure(undefined)).toBe("terminal");
  });
});

describe("drain migration whose source has no converged configuration for the user", () => {
  const now = 2_000_000;

  it("fails terminally instead of re-queuing the level-triggered placement move", () => {
    const steps = [
      { name: "keys-sync-state", status: "done" as const },
      { name: "pre-sync-state", status: "failed" as const, error: UNCONVERGED_SOURCE_ERROR },
      { name: "rollback:unmount-target", status: "done" as const },
    ];
    const update = buildOperationCompletionUpdate({
      op: {
        id: `placement-${"c".repeat(32)}`,
        kind: "migrate-user",
        origin: "automatic",
        input: { fromGatewayId: "shared-45b73f50e990", toGatewayId: "shared-dd0b28702186", source: "continuous-placement-policy" },
        attempts: 0,
        attemptHistory: [],
      },
      result: { steps, success: false, rolledBack: true, error: UNCONVERGED_SOURCE_ERROR },
      steps,
      now,
    });
    expect(update).toMatchObject({ status: "failed", rolledBack: true, error: UNCONVERGED_SOURCE_ERROR, attempts: 1 });
    expect(update.nextAttemptAt).toEqual({ clear: true });
  });
});

describe("retryBackoffMs", () => {
  it("grows exponentially and is capped", () => {
    expect(retryBackoffMs(1)).toBe(30_000);
    expect(retryBackoffMs(2)).toBe(120_000);
    expect(retryBackoffMs(3)).toBe(480_000);
    expect(retryBackoffMs(4)).toBe(480_000);
  });
});

describe("MAX_OPERATION_ATTEMPTS", () => {
  it("caps at 3", () => {
    expect(MAX_OPERATION_ATTEMPTS).toBe(3);
  });
});

describe("buildOperationCompletionUpdate", () => {
  const now = 2_000_000;

  it.each(["target verification refused", "pre-sync request timed out"].flatMap((forwardError) =>
    ["unmount-target", "resume-ingress"].map((rollback) => ({ forwardError, rollback })),
  ))("holds incomplete Shared rollback for source-only recovery: $forwardError/$rollback", ({ forwardError, rollback }) => {
    const steps = [
      { name: "verify-target", status: "failed" as const, error: forwardError },
      { name: `rollback:${rollback}`, status: "failed" as const, error: "request timed out" },
    ];
    const update = buildOperationCompletionUpdate({
      op: { kind: "migrate-user", origin: "automatic", input: { fromGatewayId: "shared-a", source: "continuous-placement-policy" }, attempts: 0 },
      result: { steps, success: false, rolledBack: false, error: `${forwardError}; rollback: request timed out` }, steps, now,
    });
    expect(update).toMatchObject({ status: "failed", rolledBack: false, steps });
    expect(update.attemptHistory).toEqual([expect.objectContaining({ steps })]);
  });

  it("leaves a transient source-only recovery failure to the fenced recovery scanner", () => {
    const update = buildOperationCompletionUpdate({
      op: { kind: "migrate-user", input: { fromGatewayId: "shared-a", recoverSourceOnly: true }, attempts: 1 },
      result: { success: false, error: "request timed out", steps: [] }, steps: [], now,
    });
    expect(update).toMatchObject({ status: "failed", attempts: 2, rolledBack: false });
  });

  it.each([
    { fromGatewayId: "alice-s-12345678", rolledBack: false },
    { fromGatewayId: "shared-a", rolledBack: true },
  ])("preserves ordinary retry outside incomplete Shared rollback: %j", ({ fromGatewayId, rolledBack }) => {
    const steps = [{ name: "rollback:unmount-target", status: "failed" as const, error: "request timed out" }];
    expect(buildOperationCompletionUpdate({
      op: { kind: "migrate-user", input: { fromGatewayId }, attempts: 0 },
      result: { success: false, error: "request timed out", rolledBack, steps }, steps, now,
    })).toMatchObject({ status: "pending", nextAttemptAt: now + 30_000 });
  });

  it.each([
    "restore recovery Kubernetes outcome is unresolved",
    "restore recovery images are not ready; outcome remains fenced",
  ])("requeues a temporary restore recovery observation without relaxing authority: %s", (error) => {
    const op = { kind: "restart-gateway", input: { restoreRecovery: {} }, attempts: 0 };
    const complete = (failure: string) => buildOperationCompletionUpdate({
      op, result: { steps: [], success: false, error: failure, retryAfterMs: 60_000 }, steps: [], now,
    });
    expect(complete(error)).toMatchObject({ status: "pending", nextAttemptAt: now + 60_000 });
    expect(complete("restore reauthorization requires an unchanged intent and a pending native return").status).toBe("failed");
    expect(complete("restore recovery pod was replaced; outcome remains fenced").status).toBe("failed");
  });

  it.each([
    { attempts: 0, status: "pending", delay: 30_000 },
    { attempts: 1, status: "pending", delay: 120_000 },
    { attempts: 2, status: "failed", delay: null },
  ])("handles Compute stop timeout after $attempts prior retirement attempts as $status", ({ attempts, status, delay }) => {
    const error = "helm uninstall failed: stop octogee-pool-44847785: operation operation-1789782653823-65bcc3f4e6af7-3edab86e-7a35a62e did not finish within 300000ms";
    const steps = [{ name: "helm-uninstall", status: "failed" as const, error }];
    const update = buildOperationCompletionUpdate({
      op: { kind: "retire-gateway", origin: "automatic", attempts, attemptHistory: [] },
      result: { steps, success: false, error },
      steps,
      now,
    });

    expect(update.status).toBe(status);
    expect(update.attempts).toBe(attempts + 1);
    expect(update.attemptHistory).toEqual([
      expect.objectContaining({ classification: "transient", error, steps }),
    ]);
    if (delay !== null) {
      expect(update.nextAttemptAt).toBe(now + delay);
      expect(update.expireAt).toEqual({ clear: true });
    }
  });

  it("builds a succeeded update, clearing queue/retry bookkeeping", () => {
    const update = buildOperationCompletionUpdate({
      op: { attempts: 0, attemptHistory: [] },
      result: { steps: [], success: true },
      steps: [{ name: "spawn-green", status: "done" }],
      now,
    });
    expect(update).toEqual({
      status: "succeeded",
      completedAt: now,
      expireAt: now + OPERATION_JOURNAL_RETENTION_MS,
      attempts: 1,
      steps: [{ name: "spawn-green", status: "done" }],
      error: { clear: true },
      rolledBack: false,
      nextAttemptAt: { clear: true },
      waitingOn: { clear: true },
      output: { clear: true },
    });
  });

  it("stamps a 30-day TTL twin on every terminal journal row", () => {
    const succeeded = buildOperationCompletionUpdate({
      op: { attempts: 0, attemptHistory: [] },
      result: { steps: [], success: true },
      steps: [],
      now,
    });
    const failed = buildOperationCompletionUpdate({
      op: { attempts: MAX_OPERATION_ATTEMPTS, attemptHistory: [] },
      result: { steps: [], success: false, error: "missing gatewayId in op.input" },
      steps: [],
      now,
    });

    expect(failed.status).toBe("failed");
    expect(OPERATION_JOURNAL_RETENTION_MS).toBe(30 * 24 * 60 * 60_000);
    for (const update of [succeeded, failed]) {
      expect(update.expireAt).toBe(now + OPERATION_JOURNAL_RETENTION_MS);
    }
  });

  it("clears a stale TTL twin when a transient failure requeues the operation", () => {
    const update = buildOperationCompletionUpdate({
      op: { attempts: 1, attemptHistory: [] },
      result: { steps: [], success: false, error: "context deadline exceeded" },
      steps: [],
      now,
    });

    expect(update.status).toBe("pending");
    expect(update.expireAt).toEqual({ clear: true });
  });

  it("atomically scrubs identifying operation input only on verified success", () => {
    const update = buildOperationCompletionUpdate({
      op: {
        attempts: 1,
        attemptHistory: [{
          attempt: 1,
          startedAt: 1,
          completedAt: 2,
          error: "failed to delete alice@example.com",
          classification: "transient",
          steps: [],
        }],
      },
      result: {
        steps: [],
        success: true,
        scrubInputOnSuccess: true,
        output: { archiveId: "archive-random" },
      },
      steps: [{ name: "delete-stripe-customer:cus_identifying", status: "done" }],
      now,
    });
    expect(update).toMatchObject({ status: "succeeded", output: { archiveId: "archive-random" } });
    expect(update.input).toEqual({ clear: true });
    expect(update.inputUid).toEqual({ clear: true });
    expect(update.createdBy).toEqual({ clear: true });
    expect(update.attemptHistory).toEqual({ clear: true });
    expect(update.steps).toEqual([]);
  });

  it("keeps a durable config cleanup obligation level-triggered after the normal retry cap", () => {
    const configCleanup = {
      migrationId: "mig-1",
      slug: "alice",
      sourceGatewayId: "default",
      sourceTransportId: "default-r1",
      resume: { success: true, rolledBack: false },
    };
    const update = buildOperationCompletionUpdate({
      op: { attempts: MAX_OPERATION_ATTEMPTS, attemptHistory: [] },
      result: {
        steps: [],
        success: false,
        error: "config unfreeze cleanup pending: source RPC unavailable",
        output: { configCleanup },
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("pending");
    expect(update.output).toEqual({ configCleanup });
    expect(update.nextAttemptAt).toBe(now + retryBackoffMs(MAX_OPERATION_ATTEMPTS + 1));
  });

  it("keeps a durable retirement freeze obligation level-triggered after the normal retry cap", () => {
    const retirementFencePending = {
      gatewayId: "walter",
      operationId: "retire-1",
    };
    const update = buildOperationCompletionUpdate({
      op: { attempts: MAX_OPERATION_ATTEMPTS, attemptHistory: [] },
      result: {
        steps: [],
        success: false,
        error: "gateway walter retirement config checkpoint changed before teardown",
        output: { retirementFencePending },
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("pending");
    expect(update.output).toEqual({ retirementFencePending });
    expect(update.nextAttemptAt).toBe(now + retryBackoffMs(MAX_OPERATION_ATTEMPTS + 1));
  });

  it("keeps a user deletion context fence level-triggered after the normal retry cap", () => {
    const deletionFencePending = { deletionId: "delete-1" };
    const update = buildOperationCompletionUpdate({
      op: { attempts: MAX_OPERATION_ATTEMPTS, attemptHistory: [] },
      result: {
        steps: [],
        success: false,
        error: "user suspension cleanup context pending",
        output: { deletionFencePending },
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("pending");
    expect(update.output).toEqual({ deletionFencePending });
  });

  it("keeps an ordinary user cleanup failure level-triggered after the normal retry cap", () => {
    const deletionCleanupRetry = { deletionId: "delete-1" };
    const update = buildOperationCompletionUpdate({
      op: { attempts: MAX_OPERATION_ATTEMPTS, attemptHistory: [] },
      result: {
        steps: [],
        success: false,
        error: "mattermost: service unavailable",
        output: { deletionCleanupRetry },
      },
      steps: [],
      now,
    });
    expect(update.status).toBe("pending");
    expect(update.output).toEqual({ deletionCleanupRetry });
  });

  it("fails a blocked user deletion terminally instead of level-triggered retry", () => {
    const deletionBlocked = { deletionId: "delete-1", step: "delete-posthog-person-data" };
    const update = buildOperationCompletionUpdate({
      op: { kind: "erase-user", attempts: 0, attemptHistory: [] },
      result: {
        steps: [],
        success: false,
        error: "PostHog person deletion refused: merged with another user (uid-2)",
        output: { deletionBlocked },
      },
      steps: [],
      now,
    });
    expect(update.status).toBe("failed");
    expect(update.output).toEqual({ deletionBlocked });
    expect(update.attemptHistory).toEqual([
      expect.objectContaining({ attempt: 1, classification: "terminal" }),
    ]);
  });

  it("terminalizes a definitive unsupported or wrong-owner cleanup even when the obligation is retained for audit", () => {
    for (const error of [
      "config cleanup terminal: /config-unfreeze/default: 501 not configured",
      "config cleanup terminal: freeze is owned by mig-other-op",
    ]) {
      const configCleanup = {
        migrationId: "mig-1",
        slug: "alice",
        sourceGatewayId: "default",
        sourceTransportId: "default-r1",
        resume: { success: true, rolledBack: false },
      };
      const update = buildOperationCompletionUpdate({
        op: { attempts: MAX_OPERATION_ATTEMPTS, attemptHistory: [] },
        result: { steps: [], success: false, error, output: { configCleanup } },
        steps: [],
        now,
      });

      expect(update.status).toBe("failed");
      expect(update.output).toEqual({ configCleanup });
    }
  });

  it("deletes a stale cleanup obligation after cleanup finishes", () => {
    const update = buildOperationCompletionUpdate({
      op: { attempts: 1 },
      result: { steps: [], success: true },
      steps: [],
      now,
    });

    expect(update.output).toEqual({ clear: true });
  });

  it("persists migration checkpoint and proof output with the terminal operation", () => {
    const output = {
      configCheckpoint: { checkpointCommit: "a".repeat(40), configHash: "b".repeat(64) },
      configProof: { restoredCommit: "a".repeat(40), acceptedCommit: "c".repeat(40) },
    };
    const update = buildOperationCompletionUpdate({
      op: { attempts: 0 },
      result: { steps: [], success: true, output },
      steps: [],
      now,
    });

    expect(update.output).toEqual(output);
  });

  it("requeues a transient failure with backoff, bumps attempts, and appends attempt history", () => {
    const claimedAt = now - 45_000;
    const update = buildOperationCompletionUpdate({
      op: { attempts: 0, attemptHistory: [], startedAt: claimedAt },
      result: { steps: [], success: false, error: "connect ECONNREFUSED 10.0.0.1:443" },
      steps: [{ name: "spawn-green", status: "failed", error: "connect ECONNREFUSED 10.0.0.1:443" }],
      now,
    });
    expect(update.status).toBe("pending");
    expect(update.attempts).toBe(1);
    expect(update.startedAt).toBeNull();
    expect(update.steps).toEqual([]);
    expect(update.nextAttemptAt).toBe(now + 30_000);
    expect(update.waitingOn).toEqual({ clear: true });
    expect(update.error).toMatch(/attempt 1.*transient.*retrying in 30s/i);
    expect(update.attemptHistory).toEqual([
      {
        attempt: 1,
        startedAt: claimedAt,
        completedAt: now,
        error: "connect ECONNREFUSED 10.0.0.1:443",
        classification: "transient",
        steps: [{ name: "spawn-green", status: "failed", error: "connect ECONNREFUSED 10.0.0.1:443" }],
      },
    ]);
  });

  it.each([
    { retryAfterMs: 300_000, delay: 300_000 },
    { retryAfterMs: 5_000, delay: 30_000 },
    { retryAfterMs: 24 * 60 * 60_000, delay: MAX_REQUESTED_RETRY_DELAY_MS },
    { retryAfterMs: Number.NaN, delay: 30_000 },
  ])("waits for a handler-requested retry delay of $retryAfterMs ms without shortening backoff", ({ retryAfterMs, delay }) => {
    const update = buildOperationCompletionUpdate({
      op: { kind: "erase-user", attempts: 0, attemptHistory: [] },
      result: {
        steps: [],
        success: false,
        error: "PostHog rate limited the erasure request (HTTP 429)",
        output: { deletionCleanupRetry: { deletionId: "delete-1" } },
        retryAfterMs,
      },
      steps: [],
      now,
    });
    expect(update.status).toBe("pending");
    expect(update.nextAttemptAt).toBe(now + delay);
    expect(update.error).toMatch(new RegExp(`retrying in ${delay / 1000}s`));
    expect(update).not.toHaveProperty("retryAfterMs");
  });

  it("falls back to completion time for the attempt start when the op carries no startedAt", () => {
    const update = buildOperationCompletionUpdate({
      op: { attempts: 0, attemptHistory: [] },
      result: { steps: [], success: false, error: "connect ECONNREFUSED 10.0.0.1:443" },
      steps: [],
      now,
    });
    expect((update.attemptHistory as Array<{ startedAt: number }>)[0].startedAt).toBe(now);
  });

  it("fails terminally (no retry) for a validation-style error on the first attempt", () => {
    const update = buildOperationCompletionUpdate({
      op: { attempts: 0, attemptHistory: [] },
      result: { steps: [], success: false, error: "missing gatewayId in op.input" },
      steps: [],
      now,
    });
    expect(update.status).toBe("failed");
    expect(update.completedAt).toBe(now);
    expect(update.attempts).toBe(1);
    expect(update.error).toBe("missing gatewayId in op.input");
    expect(update.nextAttemptAt).toEqual({ clear: true });
    expect(update.waitingOn).toEqual({ clear: true });
  });

  it("fails terminally once the attempt cap is reached even for a transient cause", () => {
    const update = buildOperationCompletionUpdate({
      op: {
        attempts: 2,
        attemptHistory: [
          { attempt: 1, startedAt: 1, completedAt: 2, error: "e1", classification: "transient", steps: [] },
          { attempt: 2, startedAt: 3, completedAt: 4, error: "e2", classification: "transient", steps: [] },
        ],
      },
      result: { steps: [], success: false, error: "connect ECONNREFUSED 10.0.0.1:443" },
      steps: [],
      now,
    });
    expect(update.status).toBe("failed");
    expect(update.attempts).toBe(3);
    expect(update.error).toBe("connect ECONNREFUSED 10.0.0.1:443");
    expect((update.attemptHistory as unknown[]).length).toBe(3);
  });

  it("keeps an active durable user migration V2 retryable beyond the normal cap", () => {
    const update = buildOperationCompletionUpdate({
      op: {
        attempts: MAX_OPERATION_ATTEMPTS,
        attemptHistory: [],
        userMigrationV2: { phase: "promotionIntent" } as never,
      },
      result: {
        steps: [],
        success: false,
        error: "user migration V2 retry pending: status 503: response lost",
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("pending");
    expect(update.nextAttemptAt).toBe(now + retryBackoffMs(MAX_OPERATION_ATTEMPTS + 1));
  });

  it("keeps an automatic user return retryable beyond the cap for a transient cause", () => {
    const update = buildOperationCompletionUpdate({
      op: {
        id: "builder-return-run-alice-g1",
        kind: "migrate-user",
        origin: "automatic",
        input: {
          source: "builder-activation-lease",
          fromGatewayId: "run-alice",
        },
        attempts: MAX_OPERATION_ATTEMPTS,
        attemptHistory: [],
      },
      result: {
        steps: [],
        success: false,
        error: "/restore/default transport failed: fetch failed",
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("pending");
    expect(update.attempts).toBe(MAX_OPERATION_ATTEMPTS + 1);
    expect(update.nextAttemptAt).toBe(now + retryBackoffMs(MAX_OPERATION_ATTEMPTS + 1));
  });

  it("fails a user return after the migration-ready precondition exhausts its retry budget", () => {
    const update = buildOperationCompletionUpdate({
      op: {
        id: "builder-return-run-alice-g1",
        kind: "migrate-user",
        origin: "automatic",
        input: {
          source: "builder-activation-lease",
          fromGatewayId: "run-alice",
        },
        attempts: MAX_OPERATION_ATTEMPTS - 1,
        attemptHistory: [],
      },
      result: {
        steps: [],
        success: false,
        error:
          "source gateway run-alice is not migration-ready " +
          "(desiredStatus=running, desiredRelease=4, liveRelease=3); " +
          "requires running or draining with a converged release",
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("failed");
    expect(update.attempts).toBe(MAX_OPERATION_ATTEMPTS);
  });

  it("keeps deterministic continuous placement demand retryable without creating new operations", () => {
    const update = buildOperationCompletionUpdate({
      op: {
        id: `placement-${"a".repeat(32)}`,
        kind: "migrate-user",
        origin: "automatic",
        input: { source: "continuous-placement-policy" },
        attempts: MAX_OPERATION_ATTEMPTS,
        attemptHistory: [],
      },
      result: {
        steps: [],
        success: false,
        error:
          "target gateway shared-b is not migration-ready " +
          "(desiredStatus=draining, desiredRelease=12, liveRelease=12); " +
          "requires running with a converged release",
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("pending");
    expect(update.attempts).toBe(MAX_OPERATION_ATTEMPTS + 1);
    expect(update.nextAttemptAt).toBe(now + retryBackoffMs(MAX_OPERATION_ATTEMPTS + 1));
  });

  it("requeues a drain migration whose kubectl call lost its service-account token mid-deploy", () => {
    const update = buildOperationCompletionUpdate({
      op: {
        id: `placement-${"b".repeat(32)}`,
        kind: "migrate-user",
        origin: "automatic",
        input: { source: "continuous-placement-policy" },
        attempts: 0,
        attemptHistory: [],
      },
      result: {
        steps: [],
        success: false,
        error:
          "kubectl get pods transport=shared-7b9a93aaa306 failed: " +
          "error: You must be logged in to the server (Unauthorized)",
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("pending");
    expect(update.nextAttemptAt).toBe(now + retryBackoffMs(1));
  });

  it("bounds level-triggered attempt history", () => {
    const history = Array.from({ length: MAX_OPERATION_ATTEMPT_HISTORY }, (_, index) => ({
      attempt: index + 1,
      startedAt: index,
      completedAt: index + 1,
      error: "fetch failed",
      classification: "transient" as const,
      steps: [],
    }));
    const update = buildOperationCompletionUpdate({
      op: {
        id: "builder-return-run-alice-g1",
        kind: "migrate-user",
        origin: "automatic",
        input: { source: "builder-activation-lease", fromGatewayId: "run-alice" },
        attempts: MAX_OPERATION_ATTEMPT_HISTORY,
        attemptHistory: history,
      },
      result: { steps: [], success: false, error: "fetch failed" },
      steps: [],
      now,
    });

    expect(update.attemptHistory).toHaveLength(MAX_OPERATION_ATTEMPT_HISTORY);
    expect((update.attemptHistory as Array<{ attempt: number }>)[0]?.attempt).toBe(2);
  });

  it("still terminalizes a validation failure for an automatic user return", () => {
    const update = buildOperationCompletionUpdate({
      op: {
        id: "builder-return-run-alice-g1",
        kind: "migrate-user",
        origin: "automatic",
        input: {
          source: "builder-activation-lease",
          fromGatewayId: "run-alice",
        },
        attempts: MAX_OPERATION_ATTEMPTS,
      },
      result: {
        steps: [],
        success: false,
        error: "target assignment belongs to another user",
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("failed");
  });

  it("preserves rolledBack from the handler result on terminal failure", () => {
    const update = buildOperationCompletionUpdate({
      op: { attempts: 0, attemptHistory: [] },
      result: { steps: [], success: false, error: "missing gatewayId in op.input", rolledBack: true },
      steps: [],
      now,
    });
    expect(update.rolledBack).toBe(true);
  });

  describe("a migration whose VM was preempted", () => {
    const rsyncReset = "push-rsync-state: 500 rsync code=12 errno=104 Connection reset";
    const preempted = `target computer octogee-pool-44847785 was preempted: ${rsyncReset}`;
    const activation = (attempts: number, userMigrationV2?: unknown) => ({
      id: "builder-activate-b-ceckert-s-b1ffafcf-g1",
      kind: "migrate-user",
      origin: "automatic",
      input: { source: "builder-activation-lease", fromGatewayId: "shared-0", toGatewayId: "b-ceckert-s-b1ffafcf" },
      attempts,
      attemptHistory: [],
      ...(userMigrationV2 ? { userMigrationV2: userMigrationV2 as never } : {}),
    });

    it("retries a rolled-back activation past the normal attempt cap and restarts its aborted migration from scratch", () => {
      const update = buildOperationCompletionUpdate({
        op: activation(MAX_OPERATION_ATTEMPTS - 1, { phase: "aborted", abortReason: rsyncReset }),
        result: { steps: [], success: false, error: preempted, rolledBack: true },
        steps: [],
        now,
      });

      expect(update.status).toBe("pending");
      expect(update.error).toMatch(/^attempt 3 failed \(transient\): target computer octogee-pool-44847785 was preempted: /);
      expect(update.userMigrationV2).toEqual({ clear: true });
    });

    it("gives up once the preemption retry budget is spent", () => {
      const update = buildOperationCompletionUpdate({
        op: activation(MAX_PREEMPTED_OPERATION_ATTEMPTS - 1),
        result: { steps: [], success: false, error: preempted, rolledBack: true },
        steps: [],
        now,
      });

      expect(MAX_PREEMPTED_OPERATION_ATTEMPTS).toBeGreaterThan(MAX_OPERATION_ATTEMPTS);
      expect(update.status).toBe("failed");
      expect(update.error).toBe(preempted);
    });

    it("keeps an unfinished migration's durable state across the retry so it resumes rather than restarts", () => {
      const update = buildOperationCompletionUpdate({
        op: activation(1, { phase: "abortIntent", abortReason: rsyncReset }),
        result: { steps: [], success: false, error: `source computer octogee-computer-prod-uida was preempted: user migration V2 retry pending: status 503: abort cleanup blocked: fetch failed`, rolledBack: false },
        steps: [],
        now,
      });

      expect(update.status).toBe("pending");
      expect(update).not.toHaveProperty("userMigrationV2");
    });

    it("restarts any retried migration whose durable state already aborted, since resuming it would only replay the abort", () => {
      const update = buildOperationCompletionUpdate({
        op: activation(0, { phase: "aborted", abortReason: "target verify failed: timed out" }),
        result: { steps: [], success: false, error: "target verify failed: timed out", rolledBack: true },
        steps: [],
        now,
      });

      expect(update.status).toBe("pending");
      expect(update.userMigrationV2).toEqual({ clear: true });
    });

    it("still fails a rolled-back activation without a preemption at the normal cap", () => {
      const update = buildOperationCompletionUpdate({
        op: activation(MAX_OPERATION_ATTEMPTS - 1, { phase: "aborted", abortReason: "target verify failed: timed out" }),
        result: { steps: [], success: false, error: "target verify failed: timed out", rolledBack: true },
        steps: [],
        now,
      });

      expect(update.status).toBe("failed");
    });
  });
});


describe("retained source execution completion", () => {
  const execution = {status:"reserved"} as NonNullable<Operation["sourceTransferExecution"]>;
  it.each([true,false])("keeps unobserved helper pending when handler success=%s", success => {
    const update = buildOperationCompletionUpdate({op:{sourceTransferExecution:execution,attempts:100},result:{success,steps:[],error:"terminal failure"},steps:[],now:1000});
    expect(update).toMatchObject({status:"pending",completedAt:null,nextAttemptAt:31000});
    expect(update).not.toHaveProperty("rolledBack");
  });
  it("protects unresolved execution from reaper and superseded pending cancellation",()=>{
    expect(operationNeedsDurableRestartResume({sourceTransferExecution:execution})).toBe(true);
    expect(supersededRollMigrationAction({status:"pending",sourceTransferExecution:execution})).toBe("wait");
  });
});

it("waits for active user work without consuming attempts or recording a failure", () => {
  const update = buildOperationCompletionUpdate({
    op: { kind: "migrate-user", attempts: 17, startedAt: 500 },
    result: { success: false, steps: [], waitingForUserIdle: true }, steps: [], now: 1_000,
  });
  expect(update).toMatchObject({ status: "pending", startedAt: null, nextAttemptAt: 16_000, waitingOn: "builder-idle", rolledBack: false });
  expect(update).not.toHaveProperty("attempts");
  expect(update).not.toHaveProperty("attemptHistory");
  expect(update.error).toEqual({ clear: true });
});

it("retains durable resume ownership for a pending source Doctor and its retained Pod", () => {
  expect(operationNeedsDurableRestartResume({ kind: "restart-gateway", input: { sourceRecovery: {} } })).toBe(true);
});

describe('fenced source management health availability', () => {
  const error = 'source management health unconfirmed; outcome remains fenced';
  it('classifies the actual failed management probe as availability', () => {
    expect(classifyOperationFailure(error)).toBe('transient');
  });
  it('keeps the captured source management operation pending beyond retry exhaustion', () => {
    expect(buildOperationCompletionUpdate({
      op: { kind: 'restart-gateway', attempts: MAX_OPERATION_ATTEMPTS, input: { sourceRecovery: { postgresAgentStores: [{}] } } },
      result: { success: false, steps: [], error, retryAfterMs: 60_000 }, steps: [], now: 10_000,
    })).toMatchObject({ status: 'pending', attempts: MAX_OPERATION_ATTEMPTS + 1, nextAttemptAt: 490_000 });
  });
  it.each([{ kind: 'restart-gateway', input: { sourceRecovery: {} } }, { kind: 'rollout', input: { sourceRecovery: { postgresAgentStores: [{}] } } }])('retains the normal cap outside management source recovery %j', op => {
    expect(buildOperationCompletionUpdate({ op: { ...op, attempts: MAX_OPERATION_ATTEMPTS },
      result: { success: false, steps: [], error, retryAfterMs: 60_000 }, steps: [], now: 10_000,
    })).toMatchObject({ status: 'failed' });
  });
});

 it("keeps a fenced final transfer pending past retry exhaustion", () => {
   const update = buildOperationCompletionUpdate({
     op: { kind: "migrate-user", attempts: MAX_OPERATION_ATTEMPTS,
       schedulerHandoff: { migrationId: "stable", uid: "alice", slug: "alice", fromGatewayId: "old", toGatewayId: "new",
         forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 4 } } },
     result: { steps: [], success: false, rolledBack: false, error: "migration forward recovery pending: status 503: response lost" },
     steps: [], now: 1000,
   });
   expect(update).toMatchObject({ status: "pending", attempts: MAX_OPERATION_ATTEMPTS + 1 });
 });


it.each([false, true])("keeps recovery on an assigned target pending beyond the activation attempt limit (recorded=%s)", recorded => {
  const update = buildOperationCompletionUpdate({
    op: { kind: "migrate-user", attempts: 20, ...(recorded ? { cutoverCommittedAt: 1 } : {}) },
    result: { steps: [], success: false, rolledBack: false, error: recorded ? "status 503: owner lookup unavailable" : "migration cutover committed; destination recovery pending: status 503: runtime not ready" },
    steps: [], now: 1000,
  });
  expect(update).toMatchObject({ status: "pending", attempts: 21 });
});

describe("a migration that failed after its cutover", () => {
  const handoff = { migrationId: "mig-op-activate:scheduler:1:claim:4000", uid: "alice", slug: "alice", fromGatewayId: "shared-blue",
    toGatewayId: "alice-vm", stageAfterCutover: true as const, scheduleTransfer: true as const };
  const output = { scheduleRestoreFailures: [{ gatewayId: "alice-vm", agentId: "octogee-alice-coach", sourceJobId: "job-1", job: "Proactive check", error: "invalid cron" }] };
  const error = "schedules were not restored after the cutover onto alice-vm: 1 schedule not restored, 0 scheduler fences kept";

  it("fails terminally on its first attempt, keeps the cutover, records its output and releases its scheduler handoff", () => {
    const update = buildOperationCompletionUpdate({
      op: { id: "op-activate", kind: "migrate-user", attempts: 0, startedAt: 4_000, cutoverCommittedAt: 4_500, schedulerHandoff: handoff, schedulerHandoffReleased: false },
      result: { steps: [], success: false, rolledBack: false, failedAfterCutover: true, error, output },
      steps: [], now: 5_000,
    });

    expect(update).toMatchObject({
      status: "failed", completedAt: 5_000, attempts: 1, error, rolledBack: false, output,
      schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 5_000,
    });
    expect(update.attemptHistory).toEqual([expect.objectContaining({ attempt: 1, error, classification: "terminal" })]);
  });

  it("fails terminally even when the cause reads as one to retry", () => {
    const held = "1 schedule not restored: Cron agent octogee-alice-coach is held for migration mig-x:scheduler:1:claim:1";
    expect(classifyOperationFailure(held)).toBe("transient");

    expect(buildOperationCompletionUpdate({
      op: { kind: "migrate-user", attempts: 0, cutoverCommittedAt: 4_500, schedulerHandoff: handoff },
      result: { steps: [], success: false, rolledBack: false, failedAfterCutover: true, error: held },
      steps: [], now: 5_000,
    })).toMatchObject({ status: "failed", rolledBack: false, schedulerHandoffReleased: true });
  });

  it("is refused for an operation that holds no scheduler handoff", () => {
    expect(() => buildOperationCompletionUpdate({
      op: { kind: "migrate-user", attempts: 0, cutoverCommittedAt: 4_500 },
      result: { steps: [], success: false, rolledBack: false, failedAfterCutover: true, error },
      steps: [], now: 5_000,
    })).toThrow("only a user migration with a scheduler handoff can fail after its cutover");
  });
});

it("resumes a durable handoff after a lost cutover acknowledgment without a recorded commit", () => {
  const op = { kind: "migrate-user", attempts: 20,
    schedulerHandoff: { migrationId: "stable", uid: "alice", slug: "alice", fromGatewayId: "shared-blue",
      toGatewayId: "alice-user", stageAfterCutover: true as const } };
  expect(operationNeedsDurableRestartResume(op)).toBe(true);
  expect(buildOperationCompletionUpdate({ op,
    result: { steps: [], success: false, error: "migration ownership lookup pending: status 503: unavailable" },
    steps: [], now: 1000,
  })).toMatchObject({ status: "pending", attempts: 21 });
});

describe("the move an operator's give starts", () => {
  const GATEWAY = "lin-s-0a1b2c3d";
  const notReady = `target gateway ${GATEWAY} is not migration-ready ` +
    "(desiredStatus=running, desiredRelease=1, liveRelease=null); requires running with a converged release";
  const noLiveRelease = `placement rejected for ${GATEWAY}: no-live-revision`;
  const blocked = `placement rejected for ${GATEWAY}: no-live-revision ` +
    "(the isolated gateway image is linux/amd64 only, and this cluster has no amd64 node)";
  const move = (state: { checks?: number; attempts?: number; source?: string | null } = {}) => ({
    id: "op-give", kind: "migrate-user", attempts: state.attempts ?? 0, startedAt: 1_000,
    input: { uid: "uid-lin", fromGatewayId: "shared-a", toGatewayId: GATEWAY, ...(state.source === null ? {} : { source: state.source ?? "operator-isolated-gateway" }) },
    ...(state.checks ? { output: { isolatedGatewayReadinessChecks: state.checks } } : {}),
  });
  const failed = (error: string) => ({ steps: [], success: false, error, rolledBack: false });
  const complete = (op: ReturnType<typeof move>, error = notReady) =>
    buildOperationCompletionUpdate({ op, result: failed(error), steps: [], now: 10_000 });

  it.each([notReady, noLiveRelease, `placement rejected for ${GATEWAY}: revision-not-ready`, blocked])(
    "checks once a minute while the gateway answers: %s", (error) => {
      const update = complete(move({ checks: 6 }), error);

      expect(update).toMatchObject({
        status: "pending", nextAttemptAt: 10_000 + OPERATOR_ISOLATED_GATEWAY_WAIT_MS,
        output: { isolatedGatewayReadinessChecks: 7 },
        error: `waiting for isolated gateway ${GATEWAY} to become ready (check 7 of ${MAX_OPERATOR_ISOLATED_GATEWAY_WAIT_ATTEMPTS}): ${error}`,
      });
    },
  );

  it("counts the first check as one", () => {
    expect(complete(move())).toMatchObject({ status: "pending", output: { isolatedGatewayReadinessChecks: 1 } });
  });

  it("does not spend the move's attempts on readiness checks", () => {
    const waited = complete(move({ checks: 12 }));

    expect(waited).not.toHaveProperty("attempts");
    expect(waited).not.toHaveProperty("attemptHistory");
  });

  it("still retries a transient failure after a long wait for the gateway", () => {
    const update = complete(move({ checks: 12 }), "connect ETIMEDOUT 10.0.0.9:8080");

    expect(update).toMatchObject({ status: "pending", attempts: 1 });
    expect(update.error).toContain("attempt 1 failed (transient)");
  });

  it("gives the move its usual three attempts, no more", () => {
    expect(complete(move({ checks: 12, attempts: MAX_OPERATION_ATTEMPTS - 1 }), "connect ETIMEDOUT 10.0.0.9:8080")).toMatchObject({ status: "failed" });
  });

  it("says the gateway did not become ready when the checks run out, with the last cause attached", () => {
    expect(complete(move({ checks: MAX_OPERATOR_ISOLATED_GATEWAY_WAIT_ATTEMPTS - 1 }), noLiveRelease)).toMatchObject({
      status: "failed",
      error: `isolated gateway ${GATEWAY} did not become ready within ${MAX_OPERATOR_ISOLATED_GATEWAY_WAIT_ATTEMPTS} checks; last cause: ${noLiveRelease}`,
    });
  });

  it("names what blocks the gateway when the checks run out", () => {
    expect(complete(move({ checks: MAX_OPERATOR_ISOLATED_GATEWAY_WAIT_ATTEMPTS - 1 }), blocked)).toMatchObject({
      status: "failed",
      error: `isolated gateway ${GATEWAY} did not become ready within ${MAX_OPERATOR_ISOLATED_GATEWAY_WAIT_ATTEMPTS} checks; last cause: ${blocked}`,
    });
  });

  it("does not wait for a move started any other way", () => {
    expect(complete(move({ source: null, attempts: MAX_OPERATION_ATTEMPTS - 1 }))).toMatchObject({ status: "failed", error: notReady });
    expect(complete(move({ source: null }), noLiveRelease)).toMatchObject({ status: "failed", error: noLiveRelease });
  });
});
