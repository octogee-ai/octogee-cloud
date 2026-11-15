import type { Operation, OperationStep, StepStatus } from "@octogee/shared/types/glm";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";

const UNKNOWN_ERROR = "unknown error";

export interface RetireGatewayDeps {
  // Retirement claim verification (claim held by THIS op at THIS version, root
  // still marked retired) — the transactional guard before destructive steps.
  verifyRetirementClaim: (input: {
    gatewayId: string;
    operationId: string;
    version: number;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;


  // Mounted-user telemetry from the gateway's runtime doc — retirement
  // refuses while any user is still mounted.
  readMountedUsers: (gatewayId: string) => Promise<string[]>;

  isPausedIsolatedSourceFencedOff?: (input: {
    gatewayId: string;
    operationId: string;
    version: number;
  }) => Promise<boolean>;

  // Stable-name Helm uninstall (octogee-gw-{gatewayId}) — must tolerate an
  // already-absent release so a crashed retire re-drives cleanly.
  helmUninstallGateway: (gatewayId: string) => Promise<void>;

  revokeAgentStoreCredentials: (gatewayId: string, assertCurrent: () => Promise<void>) => Promise<void>;

  deleteGlmGateway: (gatewayId: string) => Promise<void>;



  // Teardown of the per-gateway runtime resources is structurally required.
  deleteGatewayPersistentVolumeClaim: (gatewayId: string) => Promise<void>;
  deleteGatewayKubeSecret: (gatewayId: string) => Promise<void>;
  deleteAuthTokenSecret: (gatewayId: string) => Promise<void>;
  deleteGatewayServiceAccount: (gatewayId: string) => Promise<void>;
  deleteGatewayModelKeyKubeSecret: (gatewayId: string) => Promise<void>;
  deleteGatewayModelKeySource: (gatewayId: string) => Promise<void>;

  // Optional, operator-only, best-effort: delete the per-gateway GSA (deleting
  // the service account also removes its Workload-Identity binding). No-op when
  // no GSA exists for the gateway (cattle gateways never have one).
  teardownGatewayServiceAccount?: (gatewayId: string) => Promise<void>;

  // Assignment docs for the gateway (gateways/{id}/assignments/*). Retirement
  // refuses while any exists — users must be migrated off first.
  readAssignmentsForGateway: (
    gatewayId: string,
  ) => Promise<Array<{ uid: string; slug: string }>>;

  syncFleetIngress: () => Promise<void>;
  pollIntervalMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

interface RetireGatewayInput {
  gatewayId?: unknown;
  retirementClaimVersion?: unknown;
  retainData?: unknown;
  retainServiceAccount?: unknown;
}

type RetireGatewayRequest =
  | { error: string }
  | {
      gatewayId: string;
      retirementClaimVersion: number;
      retainData: boolean;
      retainServiceAccount: boolean;
    };

interface StepResult {
  ok: boolean;
  error?: string;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function shouldRetainData(input: RetireGatewayInput): boolean {
  return input.retainData === true;
}

function shouldRetainServiceAccount(input: RetireGatewayInput): boolean {
  return input.retainServiceAccount === true;
}

function failure(error: string): OperationResult {
  return { steps: [], success: false, error };
}

function resolveRetireGatewayRequest(input: RetireGatewayInput): RetireGatewayRequest {
  const gatewayId = typeof input.gatewayId === "string" ? input.gatewayId : undefined;
  if (!gatewayId) return { error: "missing gatewayId in op.input" };
  if (!isValidGatewayId(gatewayId)) {
    return { error: `invalid gatewayId in op.input: "${gatewayId}"` };
  }
  if (
    !Number.isInteger(input.retirementClaimVersion) ||
    (input.retirementClaimVersion as number) <= 0
  ) {
    return { error: "invalid retirementClaimVersion in op.input" };
  }
  return {
    gatewayId,
    retirementClaimVersion: input.retirementClaimVersion as number,
    retainData: shouldRetainData(input),
    retainServiceAccount: shouldRetainServiceAccount(input),
  };
}

export function createRetireGatewayHandler(deps: RetireGatewayDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const request = resolveRetireGatewayRequest(op.input as RetireGatewayInput);
    if ("error" in request) return failure(request.error);
    const { gatewayId, retirementClaimVersion, retainData, retainServiceAccount } = request;

    // Refuse while any user is still assigned — the operator must migrate
    // them off first. Naming the slugs makes the next action obvious.
    const assignmentFailure = await assertNoAssignments(deps, gatewayId);
    if (assignmentFailure) return assignmentFailure;

    const claimFailure = await verifyRetirementClaim(
      deps,
      gatewayId,
      op.id,
      retirementClaimVersion,
    );
    if (claimFailure) return claimFailure;

    const mountedFailure = await assertNoMountedUsers(deps, gatewayId, op.id, retirementClaimVersion);
    if (mountedFailure) return mountedFailure;

    const uninstall = await runReportedStep(ctx, deps, "helm-uninstall", () =>
      deps.helmUninstallGateway(gatewayId),
    );
    if (!uninstall.ok) {
      return failure(`helm uninstall failed: ${uninstall.error ?? UNKNOWN_ERROR}`);
    }

    const credentials = await runReportedStep(ctx, deps, "revoke-agent-store-credentials", () =>
      deps.revokeAgentStoreCredentials(gatewayId, async () => {
        await ctx.assertActiveClaim?.();
        const current = await verifyRetirementClaim(deps, gatewayId, op.id, retirementClaimVersion);
        if (current) throw new Error(current.error);
      }),
    );
    if (!credentials.ok) return failure(`agent-store credential retirement failed (records preserved for retry): ${credentials.error ?? UNKNOWN_ERROR}`);

    // Tear down the per-gateway resources. Steps are independent and
    // best-effort: every one is attempted even if a prior one failed, so a
    // single stuck resource cannot strand the rest. Records are NOT removed
    // until all gating teardown succeeds, so a partial failure leaves the
    // operation re-drivable.
    const teardownErrors = await teardownResources({
      ctx,
      deps,
      gatewayId,
      retainData,
      retainServiceAccount,
    });
    if (teardownErrors.length > 0) {
      return failure(
        `teardown incomplete (records preserved for retry): ${teardownErrors.join("; ")}`,
      );
    }

    const cleanupFailure = await cleanupGatewayRecords(ctx, deps, gatewayId);
    if (cleanupFailure) return cleanupFailure;

    await syncFleetIngress(ctx, deps);

    return { steps: [], success: true };
  };
}

async function verifyRetirementClaim(
  deps: RetireGatewayDeps,
  gatewayId: string,
  operationId: string,
  version: number,
): Promise<OperationResult | null> {
  try {
    const verification = await deps.verifyRetirementClaim({
      gatewayId,
      operationId,
      version,
    });
    return verification.ok ? null : failure(verification.error);
  } catch (error) {
    return failure(
      `gateway ${gatewayId} retirement claim unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function assertNoMountedUsers(
  deps: RetireGatewayDeps,
  gatewayId: string,
  operationId: string,
  version: number,
): Promise<OperationResult | null> {
  const mounted = [...(await deps.readMountedUsers(gatewayId))].sort(compareStrings);
  if (mounted.length === 0) return null;
  try {
    if (await deps.isPausedIsolatedSourceFencedOff?.({ gatewayId, operationId, version })) {
      const claimFailure = await verifyRetirementClaim(deps, gatewayId, operationId, version);
      if (claimFailure) return claimFailure;
      deps.log(`[retire-gateway] ${gatewayId}: paused isolated source is fenced off; ignoring its final mounted telemetry`);
      return null;
    }
  } catch (error) {
    return failure(`gateway ${gatewayId} isolated retirement fence unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return failure(
    `gateway ${gatewayId} still has ${mounted.length} mounted user(s): ` +
      `${mounted.join(", ")} — migrate them off before retiring`,
  );
}

interface TeardownResourcesInput {
  ctx: OperationContext;
  deps: RetireGatewayDeps;
  gatewayId: string;
  retainData: boolean;
  retainServiceAccount: boolean;
}

async function teardownResources(input: TeardownResourcesInput): Promise<string[]> {
  const {
    ctx,
    deps,
    gatewayId,
    retainData,
    retainServiceAccount,
  } = input;
  const errors: string[] = [];

  if (retainData) {
    deps.log(`[retire-gateway] retainData set — preserving PVC for ${gatewayId}`);
  } else {
    await collectTeardownError(ctx, deps, errors, "delete-pvc", () =>
      deps.deleteGatewayPersistentVolumeClaim(gatewayId),
    );
  }

  await collectTeardownError(ctx, deps, errors, "delete-kube-secret", () =>
    deps.deleteGatewayKubeSecret(gatewayId),
  );
  await collectTeardownError(ctx, deps, errors, "delete-sm-secret", () =>
    deps.deleteAuthTokenSecret(gatewayId),
  );
  await collectTeardownError(ctx, deps, errors, "delete-ksa", () =>
    deps.deleteGatewayServiceAccount(gatewayId),
  );
  await collectTeardownError(
    ctx,
    deps,
    errors,
    "delete-model-key-kube-secret",
    () => deps.deleteGatewayModelKeyKubeSecret(gatewayId),
  );
  await collectTeardownError(ctx, deps, errors, "delete-model-key-source", () =>
    deps.deleteGatewayModelKeySource(gatewayId),
  );

  // GSA teardown: a non-404 failure means a per-gateway GSA (a standing IAM
  // principal — the exact thing decommission must remove) is still live, so it
  // is aggregate-gated like the other resources (the op fails and is
  // re-drivable). A 404 "no GSA" is a clean no-op in gateway-gsa.ts, so cattle
  // gateways still pass. retainServiceAccount skips it entirely — for a
  // terraform-managed GSA, decommissioned via terraform, not here.
  const teardownGsa = deps.teardownGatewayServiceAccount;
  if (retainServiceAccount) {
    deps.log(
      `[retire-gateway] retainServiceAccount set — leaving the per-gateway GSA in place for ${gatewayId}`,
    );
  } else if (teardownGsa) {
    await collectTeardownError(ctx, deps, errors, "teardown-gsa", () =>
      teardownGsa(gatewayId),
    );
  }

  return errors;
}

async function collectTeardownError(
  ctx: OperationContext,
  deps: RetireGatewayDeps,
  errors: string[],
  stepName: string,
  action: () => Promise<void>,
): Promise<void> {
  const result = await runReportedStep(ctx, deps, stepName, action);
  if (!result.ok) errors.push(`${stepName}: ${result.error ?? UNKNOWN_ERROR}`);
}

async function assertNoAssignments(
  deps: RetireGatewayDeps,
  gatewayId: string,
): Promise<OperationResult | null> {
  const assignments = await deps.readAssignmentsForGateway(gatewayId);
  if (assignments.length === 0) return null;
  const slugs = assignments.map((a) => a.slug).sort(compareStrings);
  return failure(
    `gateway ${gatewayId} still has ${assignments.length} assigned user(s): ` +
      `${slugs.join(", ")} — migrate them off before retiring`,
  );
}

async function cleanupGatewayRecords(
  ctx: OperationContext,
  deps: RetireGatewayDeps,
  gatewayId: string,
): Promise<OperationResult | null> {
  const result = await runReportedStep(ctx, deps, "cleanup", async () => {
    await deps.deleteGlmGateway(gatewayId);
  });
  return result.ok
    ? null
    : failure(`cleanup failed after teardown: ${result.error ?? UNKNOWN_ERROR}`);
}

async function syncFleetIngress(
  ctx: OperationContext,
  deps: RetireGatewayDeps,
): Promise<void> {
  const result = await runReportedStep(ctx, deps, "fleet-ingress", () => deps.syncFleetIngress());
  if (result.ok) return;
  deps.log(
    `[retire-gateway] cleanup committed but fleet-ingress sync failed; reconciler will heal within 30s — ${result.error ?? UNKNOWN_ERROR}`,
  );
}

async function runReportedStep(
  ctx: OperationContext,
  deps: RetireGatewayDeps,
  name: string,
  run: () => Promise<void>,
): Promise<StepResult> {
  const startedAt = deps.now();
  await reportStep(ctx, { name, status: "running", startedAt });
  try {
    await run();
    await reportStep(ctx, {
      name,
      status: "done",
      startedAt,
      completedAt: deps.now(),
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reportStep(ctx, {
      name,
      status: "failed",
      startedAt,
      completedAt: deps.now(),
      error: msg,
    });
    return { ok: false, error: msg };
  }
}

async function reportStep(
  ctx: OperationContext,
  step: OperationStep & { status: StepStatus },
): Promise<void> {
  await ctx.reportStep(step);
}
