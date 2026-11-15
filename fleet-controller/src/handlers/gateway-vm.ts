import {
  resolveGatewayRuntime,
  type UserParkedVm,
  type GatewayVmState,
  type GatewayVmStopReason,
  type Operation,
  type OperationStep,
} from "@octogee/shared/types/glm";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { GatewayVmClient, GatewayVmDescription } from "../lib/compute-vm.js";

export const GATEWAY_VM_ACTIONS = ["stop", "start", "delete", "replace"] as const;
export type GatewayVmAction = (typeof GATEWAY_VM_ACTIONS)[number];
const REPLACE_DISABLED = "State-preserving VM replacement is disabled until coverage, writer fencing, and recovery-anchor checks are implemented; VM and disks kept";

export interface GatewayVmRecord {
  runtime: unknown;
  vm: GatewayVmState | null;
}

export interface GatewayVmDeps {
  vm: GatewayVmClient;
  replaceStoppedVm?: (gatewayId: string, operationId: string, assertAuthority: () => Promise<void>, options?: { forceOwnerUid: string; expectedInstanceId: string }) => Promise<Record<string, unknown>>;
  readGateway: (gatewayId: string) => Promise<GatewayVmRecord | null>;
  writeVmState: (gatewayId: string, vm: GatewayVmState | null) => Promise<void>;
  requestHomeCheckpoint: (gatewayId: string, requestedAt: number) => Promise<void>;
  clearHomeCheckpointRequest: (gatewayId: string) => Promise<void>;
  readHomeCheckpointCompletedAt: (gatewayId: string) => Promise<number | null>;
  clearVmForReplacement: (gatewayId: string) => Promise<void>;
  readParkedVm: (ownerUid: string) => Promise<UserParkedVm | null>;
  clearParkedVm: (ownerUid: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  log: (msg: string) => void;
  replaceCheckpointTimeoutMs?: number;
  replaceCheckpointPollMs?: number;
}

interface GatewayVmInput {
  gatewayId?: unknown;
  ownerUid?: unknown;
  uid?: unknown;
  force?: unknown;
  expectedGatewayId?: unknown;
  expectedInstanceId?: unknown;
  action?: unknown;
}

function isAction(value: unknown): value is GatewayVmAction {
  return typeof value === "string" && (GATEWAY_VM_ACTIONS as readonly string[]).includes(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stateFrom(description: GatewayVmDescription, now: number, stopReason: GatewayVmStopReason | null): GatewayVmState {
  return {
    instanceName: description.name,
    zone: description.zone,
    instanceId: description.instanceId,
    internalIp: description.internalIp,
    status: description.status,
    startedAt: description.lastStartedAt,
    provisioningModel: description.provisioningModel,
    stopReason,
    updatedAt: now,
  };
}

function step(name: string, status: OperationStep["status"], startedAt: number, now: number, error?: string): OperationStep {
  return { name, status, startedAt, completedAt: now, ...(error ? { error } : {}) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function invalidForceRequest(input: GatewayVmInput, op: Operation, gatewayId: string | undefined, ownerUid: string | undefined): boolean {
  return input.force !== undefined && (input.force !== true || !!gatewayId || !ownerUid || input.uid !== ownerUid || op.origin !== "operator" || !nonEmptyString(op.createdBy));
}

async function replaceOwnerVm(deps: GatewayVmDeps, op: Operation, ctx: OperationContext, input: GatewayVmInput, ownerUid: string): Promise<OperationResult> {
  if (input.action !== "replace") return { steps: [], success: false, error: "gateway-vm ownerUid form supports only replace" };
  if (!deps.replaceStoppedVm) return { steps: [], success: false, error: REPLACE_DISABLED };
  const parked = await deps.readParkedVm(ownerUid);
  if (input.force !== true) {
    if (!parked) return { steps: [], success: false, error: `User ${ownerUid} has no parked VM` };
    return replaceStopped(deps, parked.gatewayId, op, ctx);
  }
  const expectedInstanceId = nonEmptyString(input.expectedInstanceId);
  const expectedGatewayId = nonEmptyString(input.expectedGatewayId);
  if (!expectedInstanceId || !expectedGatewayId || (parked && (expectedGatewayId !== parked.gatewayId || expectedInstanceId !== parked.instanceId))) {
    return { steps: [], success: false, error: "force replacement parked VM changed" };
  }
  return replaceStopped(deps, expectedGatewayId, op, ctx, { forceOwnerUid: ownerUid, expectedInstanceId });
}

export function createGatewayVmHandler(deps: GatewayVmDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as GatewayVmInput;
    const gatewayId = nonEmptyString(input.gatewayId);
    const ownerUid = nonEmptyString(input.ownerUid);
    if (invalidForceRequest(input, op, gatewayId, ownerUid)) {
      return { steps: [], success: false, error: "force replacement requires a journaled operator owner request" };
    }
    if (!gatewayId && ownerUid) {
      return replaceOwnerVm(deps, op, ctx, input, ownerUid);
    }
    if (!gatewayId) return { steps: [], success: false, error: "missing gatewayId in op.input" };
    if (!isAction(input.action)) {
      return { steps: [], success: false, error: `gateway-vm action must be one of ${GATEWAY_VM_ACTIONS.join(", ")}` };
    }
    const action = input.action;
    const record = await deps.readGateway(gatewayId);
    if (!record && action === "replace") return replaceStopped(deps, gatewayId, op, ctx);
    if (!record) return { steps: [], success: false, error: `gateway ${gatewayId} does not exist` };
    if (resolveGatewayRuntime(record.runtime) !== "gce-vm") {
      return { steps: [], success: false, error: `gateway ${gatewayId} runtime is ${resolveGatewayRuntime(record.runtime)}, not gce-vm` };
    }
    if (action === "replace") return replaceStopped(deps, gatewayId, op, ctx);

    const startedAt = deps.now();
    const stepName = `vm-${action}`;
    try {
      const output = await run(deps, gatewayId, action, record);
      const done = step(stepName, "done", startedAt, deps.now());
      await ctx.reportStep(done);
      return { steps: [done], success: true, output };
    } catch (err) {
      const message = errorMessage(err);
      const failed = step(stepName, "failed", startedAt, deps.now(), message);
      await ctx.reportStep(failed);
      return { steps: [failed], success: false, error: message };
    }
  };
}

async function replaceStopped(deps: GatewayVmDeps, gatewayId: string, op: Operation, ctx: OperationContext, force?: { forceOwnerUid: string; expectedInstanceId: string }): Promise<OperationResult> {
  if (!deps.replaceStoppedVm) return { steps: [], success: false, error: REPLACE_DISABLED };
  const startedAt = deps.now();
  try {
    const output = await deps.replaceStoppedVm(gatewayId, op.id, async () => {
      await ctx.assertActiveClaim?.();
      if (await ctx.cancellationRequested?.()) throw new Error("boot replacement cancelled; retained home and source VM kept");
    }, ...(force ? [force] as const : [] as const));
    const done = step("vm-replace-boot", "done", startedAt, deps.now());
    await ctx.reportStep(done);
    return { steps: [done], success: true, output };
  } catch (error) {
    const message = errorMessage(error);
    const failed = step("vm-replace-boot", "failed", startedAt, deps.now(), message);
    await ctx.reportStep(failed);
    return { steps: [failed], success: false, error: message };
  }
}

async function run(
  deps: GatewayVmDeps,
  gatewayId: string,
  action: Exclude<GatewayVmAction, "replace">,
  record: GatewayVmRecord,
): Promise<Record<string, unknown>> {
  const vm = record.vm;
  if (!vm) throw new Error(`gateway ${gatewayId} has no VM to ${action}`);
  if (action === "delete") {
    const deleted = await deps.vm.delete(vm.instanceName, vm.zone);
    await deps.writeVmState(gatewayId, null);
    deps.log(`[gateway-vm] ${gatewayId}: ${deleted ? "deleted" : "already absent"} ${vm.instanceName}`);
    return { instanceName: vm.instanceName, deleted };
  }
  let fellBackToStandard = false;
  if (action === "stop") await deps.vm.stop(vm.instanceName, vm.zone);
  else fellBackToStandard = (await deps.vm.start(vm.instanceName, vm.zone)).fellBackToStandard;
  const description = await deps.vm.describe(vm.instanceName, vm.zone);
  if (!description) throw new Error(`gateway ${gatewayId}: ${vm.instanceName} vanished during ${action}`);
  const state = stateFrom(description, deps.now(), action === "stop" ? "operator" : null);
  await deps.writeVmState(gatewayId, state);
  deps.log(`[gateway-vm] ${gatewayId}: ${action} ${vm.instanceName} -> ${state.status}${fellBackToStandard ? " (on-demand fallback)" : ""}`);
  return { instanceName: vm.instanceName, status: state.status, internalIp: state.internalIp, fellBackToStandard };
}
