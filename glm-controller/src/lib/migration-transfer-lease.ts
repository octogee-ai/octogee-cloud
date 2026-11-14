import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isUserReturnOperationIdFor } from "@octogee/core/user-activation-lease";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import type { MigrationTransferTask, PlatformStateStore, PlatformStateTransaction, Stored } from "@octogee/core/platform-state";
import type { CommandRunner } from "./migration-rsync-transfer.js";

export interface ControllerPodIdentity { name: string; uid: string }
export interface TransferClaim {
  taskId: string;
  attempt: number;
  attemptId: string;
  workerId: string;
}

interface LeaseDeps {
  store: PlatformStateStore;
  now: () => number;
  workerId: string;
  leaseMs: number;
  namespace: string;
  runCommand: CommandRunner;
  controllerPod?: ControllerPodIdentity;
  log: (message: string) => void;
  beforeRecovery: () => Promise<void>;
}

export function controllerPodIdentity(env: NodeJS.ProcessEnv): ControllerPodIdentity | undefined {
  if (env.POD_NAME === undefined && env.POD_UID === undefined) return undefined;
  const value = { name: env.POD_NAME, uid: env.POD_UID };
  if (!isPodIdentity(value)) throw new Error("invalid controller pod identity");
  return value;
}

function isPodIdentity(value: unknown): value is ControllerPodIdentity {
  if (!value || typeof value !== "object") return false;
  const pod = value as ControllerPodIdentity;
  return typeof pod.name === "string" && /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(pod.name) &&
    typeof pod.uid === "string" && /^[A-Za-z0-9-]{1,128}$/.test(pod.uid);
}

async function observeControllerPod(deps: Pick<LeaseDeps, "runCommand" | "namespace">, pod: ControllerPodIdentity): Promise<{ gone: boolean; restartCount?: number }> {
  const result = await deps.runCommand("kubectl", ["-n", deps.namespace, "get", "pod", pod.name, "--ignore-not-found", "-o", "json"], { timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error(`controller pod observation failed: ${result.stderr || result.stdout}`);
  if (!result.stdout.trim()) return { gone: true };
  let observed: { metadata?: { name?: string; uid?: string }; status?: { containerStatuses?: Array<{ name?: string; restartCount?: number }> } };
  try { observed = JSON.parse(result.stdout); } catch { throw new Error("invalid controller pod observation"); }
  if (observed?.metadata?.name !== pod.name || typeof observed.metadata.uid !== "string" || !observed.metadata.uid) throw new Error("invalid controller pod observation");
  if (observed.metadata.uid !== pod.uid) return { gone: true };
  return { gone: false, restartCount: observed.status?.containerStatuses?.find(container => container.name === "glm-controller")?.restartCount };
}

async function claimRecovery(deps: LeaseDeps, taskId: string, observed: Stored<MigrationTransferTask> | null): Promise<boolean> {
  if (observed?.status !== "running") return false;
  if (!isPodIdentity(observed.leasePod)) throw new Error(`transfer task ${taskId} is already running; owner identity unavailable`);
  if (!await ownerPodGone(deps, observed.leasePod, observed.leaseRestartCount)) {
    throw new Error(`transfer task ${taskId} is already running (leaseOwner=${observed.leaseOwner ?? "unknown"}); owner remains present`);
  }
  await deps.beforeRecovery();
  return true;
}

function assertTaskIdentity(existing: MigrationTransferTask | null, taskId: string, input: Parameters<MigrationClient["transferState"]>[0]): void {
  if (existing && [[existing.migrationId, input.migrationId], [existing.slug, input.slug],
    [existing.sourceGatewayId, input.fromGatewayId], [existing.targetGatewayId, input.toGatewayId],
    [existing.mode, input.mode ?? "pre"]].some(([actual, expected]) => actual !== expected)) throw new Error(`transfer task ${taskId} identity changed`);
}

type TransferScope = { migrationId: string; slug: string; gatewayId: string; mode: MigrationTransferTask["mode"]; fromGatewayId?: string };
type TaskSelection = { taskId: string; migrationId: string; existing: Stored<MigrationTransferTask> | null };

function transferTaskKey(migrationId: string, mode: MigrationTransferTask["mode"]): string {
  return `${migrationId.replace(/[^A-Za-z0-9._-]/g, "_")}__${mode}`;
}

async function completedRetirementMatches(
  tx: PlatformStateTransaction, target: string, receipt: Record<string, unknown>, completedAt: number,
): Promise<boolean> {
  const operationId = `shared-pool-retire-${target}`;
  if (receipt.operationId !== operationId) return false;
  const [retirement, root, runtime] = await Promise.all([
    tx.journal.operations.get(operationId), tx.gateways.roots.get(target), tx.fleetRegistry.get(target),
  ]);
  if (!retirement || retirement.completedAt === null) return false;
  return [
    runtime === null,
    root === null || (root.gatewayClass === "shared" && root.ownerUid == null &&
      root.desiredStatus === "retired" && root.retirementClaim?.operationId === operationId &&
      root.retirementClaim.version === receipt.version && root.retirementClaim.phase === "claimed"),
    retirement.kind === "retire-gateway", retirement.status === "succeeded", retirement.gatewayId === target,
    retirement.input.gatewayId === target, retirement.input.source === "shared-pool-scaler",
    retirement.input.retainData !== true, retirement.input.retainServiceAccount !== true,
    retirement.input.retirementClaimVersion === receipt.version,
    retirement.createdAt === receipt.createdAt, retirement.createdAt >= completedAt,
    retirement.completedAt === receipt.completedAt, retirement.completedAt >= retirement.createdAt,
    ["helm-uninstall", "revoke-agent-store-credentials"].every(name =>
      retirement.steps.some(step => step.name === name && step.status === "done")),
  ].every(Boolean);
}

function isTerminalReturnTransfer(task: MigrationTransferTask, input: TransferScope): task is MigrationTransferTask & { completedAt: number } {
  return [
    task.kind === "gateway-rsync-transfer", task.migrationId === input.migrationId, task.slug === input.slug, task.mode === input.mode,
    task.status !== "running", task.completedAt !== null, task.leaseOwner === null,
    task.leasePod === null, task.leaseExpiresAt === null, task.leaseRestartCount === null,
    (input.fromGatewayId ?? task.sourceGatewayId) === task.sourceGatewayId,
  ].every(Boolean);
}

async function retiredReturnTransfer(tx: PlatformStateTransaction, input: TransferScope, task: MigrationTransferTask): Promise<boolean> {
  const { sourceGatewayId: source, targetGatewayId: retired } = task;
  const operationId = input.migrationId.slice(4);
  if (!input.migrationId.startsWith("mig-") || !isUserReturnOperationIdFor(operationId, source) ||
      ![retired, input.gatewayId].every(id => /^shared-[a-z0-9]+$/.test(id)) || !isTerminalReturnTransfer(task, input)) return false;
  const { completedAt } = task;
  const op = await tx.journal.operations.get(operationId);
  if (!op || !op.inputUid) return false;
  if (![op.kind === "migrate-user", op.status === "running", op.origin === "automatic",
    op.createdBy === "glm-controller-placement-policy", op.input.source === "builder-activation-lease",
    op.input.uid === op.inputUid, op.input.userSlug === input.slug, op.input.fromGatewayId === source,
    op.input.toGatewayId === input.gatewayId, op.gatewayId === input.gatewayId].every(Boolean)) return false;
  const receipt = op.nativeReturnSourceRecoveryReceipts?.find(candidate => [
    candidate.uid === op.inputUid, candidate.slug === input.slug, candidate.operationId === operationId,
    candidate.sourceGatewayId === source, candidate.targetGatewayId === retired,
    typeof candidate.completedAt === "number", Number(candidate.completedAt) >= completedAt,
  ].every(Boolean));
  const retirement = receipt?.targetRetirement;
  return retirement !== null && typeof retirement === "object" &&
    await completedRetirementMatches(tx, retired, retirement as Record<string, unknown>, completedAt);
}

async function selectTransferTask(tx: PlatformStateTransaction, taskId: string, input: TransferScope): Promise<TaskSelection> {
  const existing = await tx.migrationTasks.get(taskId);
  if (!existing || existing.targetGatewayId === input.gatewayId || !await retiredReturnTransfer(tx, input, existing)) {
    return { taskId, migrationId: input.migrationId, existing };
  }
  const migrationId = `${input.migrationId}:retarget:${input.gatewayId}`;
  const newTaskId = transferTaskKey(migrationId, input.mode);
  return { taskId: newTaskId, migrationId, existing: await tx.migrationTasks.get(newTaskId) };
}

async function ownerPodGone(deps: Pick<LeaseDeps, "runCommand" | "namespace">, pod: ControllerPodIdentity, restartCount: unknown): Promise<boolean> {
  const observed = await observeControllerPod(deps, pod);
  return observed.gone || Number.isSafeInteger(restartCount) && (restartCount as number) >= 0 && Number.isSafeInteger(observed.restartCount) && observed.restartCount! > (restartCount as number);
}

export async function readTransferAttemptForCleanup(
  deps: Pick<LeaseDeps, "store" | "now" | "runCommand" | "namespace">,
  input: Parameters<MigrationClient["abortImport"]>[0],
): Promise<string | undefined> {
  const taskId = transferTaskKey(input.migrationId, input.mode);
  const read = () => deps.store.transaction({ label: "migration-transfer-lease.cleanup", readOnly: true },
    tx => selectTransferTask(tx, taskId, input));
  const selection = await read();
  const observed = selection.existing;
  if (!observed) return undefined;
  if (observed.migrationId !== selection.migrationId || observed.slug !== input.slug || observed.mode !== input.mode || observed.targetGatewayId !== input.gatewayId) {
    throw new Error("transfer cleanup identity changed");
  }
  if (observed.status === "running" && (!isPodIdentity(observed.leasePod) || !await ownerPodGone(deps, observed.leasePod, observed.leaseRestartCount))) {
    throw new Error("transfer cleanup refused while its owner may still be running");
  }
  if (!isDeepStrictEqual(await read(), selection)) throw new Error("transfer cleanup claim changed");
  if (!observed.attemptId) throw new Error("invalid transfer cleanup attempt");
  return observed.attemptId;
}

function runningTask(deps: LeaseDeps, claim: {
  taskId: string;
  input: Parameters<MigrationClient["transferState"]>[0];
  existing: MigrationTransferTask | null;
  attemptId: string;
  now: number;
  restartCount: number | undefined;
}): MigrationTransferTask {
  const { taskId, input, existing, attemptId, now } = claim;
  return {
    id: taskId, kind: "gateway-rsync-transfer", migrationId: input.migrationId, slug: input.slug,
    mode: input.mode ?? "pre", sourceGatewayId: input.fromGatewayId, targetGatewayId: input.toGatewayId,
    status: "running", attempt: (existing?.attempt ?? 0) + 1, attemptId, leaseOwner: deps.workerId,
    leasePod: deps.controllerPod ?? null, leaseExpiresAt: now + deps.leaseMs,
    leaseRestartCount: claim.restartCount ?? null,
    createdAt: existing?.createdAt ?? now, updatedAt: now, startedAt: now,
    completedAt: null, error: null,
  };
}

export async function claimTransferTask(deps: LeaseDeps, taskId: string, input: Parameters<MigrationClient["transferState"]>[0]): Promise<TransferClaim> {
  const scope = { ...input, gatewayId: input.toGatewayId, mode: input.mode ?? "pre" as const };
  const select = (tx: PlatformStateTransaction) => selectTransferTask(tx, taskId, scope);
  const observed = await deps.store.transaction({ label: "migration-transfer-lease.read", readOnly: true }, select);
  const recover = await claimRecovery(deps, observed.taskId, observed.existing);
  const ownPod = deps.controllerPod ? await observeControllerPod(deps, deps.controllerPod) : undefined;
  if (ownPod && (ownPod.gone || !Number.isSafeInteger(ownPod.restartCount) || ownPod.restartCount! < 0)) throw new Error("controller container identity unavailable");
  const attemptId = randomUUID();
  const claim = await deps.store.transaction({ label: "migration-transfer-lease.claim" }, async tx => {
    const selected = await select(tx);
    const { taskId, existing, migrationId } = selected;
    const now = deps.now();
    if (taskId !== observed.taskId || (recover ? !isDeepStrictEqual(existing, observed.existing) : existing?.status === "running")) {
      throw new Error(`transfer task ${taskId} is already running (leaseOwner=${existing?.leaseOwner ?? "unknown"}); claim changed or owner remains present`);
    }
    const taskInput = { ...input, migrationId };
    assertTaskIdentity(existing, taskId, taskInput);
    const task = runningTask(deps, { taskId, input: taskInput, existing, attemptId, now, restartCount: ownPod?.restartCount });
    await tx.migrationTasks.claim(task, existing?.revision ?? "absent");
    return { taskId, attempt: task.attempt, attemptId, workerId: deps.workerId };
  });
  if (recover) deps.log(`[migration-rsync] reclaimed abandoned transfer task=${claim.taskId} attempt=${claim.attempt} previousOwner=${String(observed.existing?.leaseOwner)}`);
  if (claim.taskId !== taskId) deps.log(`[migration-rsync] used retargeted transfer task=${claim.taskId}; preserved retired destination task=${taskId}`);
  return claim;
}

function ownsClaim(task: MigrationTransferTask | null, claim: TransferClaim): boolean {
  return task?.status === "running" && task.attempt === claim.attempt && task.attemptId === claim.attemptId && task.leaseOwner === claim.workerId;
}

export async function assertTransferClaim(store: PlatformStateStore, claim: TransferClaim): Promise<void> {
  if (!ownsClaim(await store.migrationTasks.get(claim.taskId), claim)) throw new Error(`transfer task ${claim.taskId} attempt ownership changed`);
}

export async function finishTransferTask(store: PlatformStateStore, claim: TransferClaim, now: () => number, error?: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await store.transaction({ label: "migration-transfer-lease.finish" }, async tx => {
    if (!ownsClaim(await tx.migrationTasks.get(claim.taskId), claim)) throw new Error(`transfer task ${claim.taskId} attempt ownership changed`);
    await tx.migrationTasks.finish(claim.taskId, { attempt: claim.attempt, attemptId: claim.attemptId, leaseOwner: claim.workerId }, now(), error === undefined ? null : message);
  });
}
