import {
  type GatewayClass,
  type Operation,
  type OperationStep,
  type StepStatus,
} from "@octogee/shared/types/glm";
import { gatewayHeartbeatMatchesImageTag } from "@octogee/shared/types/image-tag";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { HelmRunner } from "../helm-runner.js";
import type { KubeOps } from "../lib/kube-ops.js";

export interface GatewayHeartbeat {
  lastHeartbeatAt: number;
  version?: string | null;
}

export interface GatewayRevisionTarget {
  gatewayId: string;
  revisionId: string;
  imageTag: string;
  gatewayClass: GatewayClass;
}

export interface AddGatewayDeps {
  helm: Pick<HelmRunner, "readDeployedInstances">;

  kubeOps: Pick<KubeOps, "readAvailableReplicas">;

  resolveGatewayRevision: (gatewayId: string) => Promise<GatewayRevisionTarget | null>;

  readGatewayHeartbeat: (revisionId: string) => Promise<GatewayHeartbeat | null>;

  publishGatewayReady: (input: {
    gatewayId: string;
    revisionId: string;
    imageTag?: string;
  }) => Promise<void>;

  syncFleetIngress: () => Promise<void>;

  revisionMaterializationTimeoutMs: number;

  helmRenderTimeoutMs: number;

  deploymentReadyTimeoutMs: number;

  heartbeatTimeoutMs: number;

  pollIntervalMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

interface AddGatewayInput {
  gatewayId?: unknown;
  imageTag?: unknown;
}

type StepResult = { ok: true } | { ok: false; error: string };

interface AddGatewayPlan {
  gatewayId: string;
  imageTag?: string;
}

interface RevisionAddGatewayPlan extends AddGatewayPlan {
  revisionId: string;
  imageTag: string;
  gatewayClass: GatewayClass;
}

const NAMESPACE = process.env.K8S_NAMESPACE ?? "octogee";
function deploymentNameForGateway(gatewayId: string): string {
  return `octogee-gateway-${gatewayId}`;
}

export function heartbeatMatchesImageTag(version: string | null | undefined, imageTag: string | undefined): boolean {
  if (!imageTag) return true;
  return gatewayHeartbeatMatchesImageTag(version, imageTag);
}

export function createAddGatewayHandler(deps: AddGatewayDeps): OperationHandler {
  return (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    return handleAddGateway(op, ctx, deps);
  };
}

async function handleAddGateway(
  op: Operation,
  ctx: OperationContext,
  deps: AddGatewayDeps,
): Promise<OperationResult> {
  const plan = parseAddGatewayPlan(op.input as AddGatewayInput);
  if (!plan) return failure("missing gatewayId in op.input");

  const target = await waitForGatewayRevision(plan.gatewayId, deps);
  if (!target) {
    return failure(
      `gateway ${plan.gatewayId} durable desired revision did not materialize within ${deps.revisionMaterializationTimeoutMs}ms`,
    );
  }
  if (target.gatewayId !== plan.gatewayId) {
    return failure(`gateway ${plan.gatewayId} resolved a revision for ${target.gatewayId}`);
  }
  if (plan.imageTag && plan.imageTag !== target.imageTag) {
    return failure(
      `gateway ${plan.gatewayId} operation imageTag=${plan.imageTag} does not match durable revision ${target.revisionId} imageTag=${target.imageTag}`,
    );
  }
  const revisionPlan: RevisionAddGatewayPlan = {
    ...plan,
    revisionId: target.revisionId,
    imageTag: target.imageTag,
    gatewayClass: target.gatewayClass,
  };

  const renderResult = await waitForHelmRender(revisionPlan, ctx, deps);
  if (!renderResult.ok) return failure(renderResult.error);

  const deploymentResult = await waitForDeployment(revisionPlan.revisionId, ctx, deps);
  if (!deploymentResult.ok) return failure(deploymentResult.error);

  const readyResult = await waitForReadySignal(revisionPlan, ctx, deps);
  if (!readyResult.ok) return failure(readyResult.error);

  const ingressResult = await syncFleetIngress(ctx, deps);
  if (!ingressResult.ok) return failure(ingressResult.error);

  return { steps: [], success: true };
}

async function waitForGatewayRevision(
  gatewayId: string,
  deps: AddGatewayDeps,
): Promise<GatewayRevisionTarget | null> {
  const startedAt = deps.now();
  for (;;) {
    const target = await deps.resolveGatewayRevision(gatewayId);
    if (target) return target;
    if (deps.now() - startedAt >= deps.revisionMaterializationTimeoutMs) return null;
    await deps.wait(deps.pollIntervalMs);
  }
}

function parseAddGatewayPlan(input: AddGatewayInput): AddGatewayPlan | null {
  const gatewayId = typeof input.gatewayId === "string" ? input.gatewayId : undefined;
  const imageTag = typeof input.imageTag === "string" ? input.imageTag : undefined;

  if (!gatewayId) return null;

  return { gatewayId, imageTag };
}

async function waitForHelmRender(
  plan: RevisionAddGatewayPlan,
  ctx: OperationContext,
  deps: AddGatewayDeps,
): Promise<StepResult> {
  return pollUntil({
    stepName: "helm-render",
    timeoutMs: deps.helmRenderTimeoutMs,
    ctx,
    deps,
    check: async () => {
      const map = await deps.helm.readDeployedInstances({ namespace: NAMESPACE });
      const instance = map[plan.revisionId];
      return instance != null && instance.image.tag === plan.imageTag;
    },
    timeoutMessage: `helm did not render revision "${plan.revisionId}" with imageTag=${plan.imageTag} within ${deps.helmRenderTimeoutMs}ms`,
  });
}

async function waitForDeployment(
  revisionId: string,
  ctx: OperationContext,
  deps: AddGatewayDeps,
): Promise<StepResult> {
  const deploymentName = deploymentNameForGateway(revisionId);
  return pollUntil({
    stepName: "deployment-ready",
    timeoutMs: deps.deploymentReadyTimeoutMs,
    ctx,
    deps,
    check: async () => {
      const replicas = await deps.kubeOps.readAvailableReplicas({
        namespace: NAMESPACE,
        name: deploymentName,
      });
      return replicas != null && replicas > 0;
    },
    timeoutMessage: `deployment "${deploymentName}" did not become available within ${deps.deploymentReadyTimeoutMs}ms`,
  });
}

async function waitForReadySignal(
  plan: RevisionAddGatewayPlan,
  ctx: OperationContext,
  deps: AddGatewayDeps,
): Promise<StepResult> {
  if (plan.gatewayClass === "isolated") {
    return publishPlatformReadyRecord(plan, ctx, deps);
  }

  return waitForGatewayHeartbeat(plan, ctx, deps);
}

async function publishPlatformReadyRecord(
  plan: RevisionAddGatewayPlan,
  ctx: OperationContext,
  deps: AddGatewayDeps,
): Promise<StepResult> {
  return runReportedStep({
    stepName: "platform-ready-record",
    ctx,
    deps,
    action: () =>
      deps.publishGatewayReady({
        gatewayId: plan.gatewayId,
        revisionId: plan.revisionId,
        imageTag: plan.imageTag,
      }),
  });
}

async function waitForGatewayHeartbeat(
  plan: RevisionAddGatewayPlan,
  ctx: OperationContext,
  deps: AddGatewayDeps,
): Promise<StepResult> {
  return pollUntil({
    stepName: "gateway-heartbeat",
    timeoutMs: deps.heartbeatTimeoutMs,
    ctx,
    deps,
    check: async () => {
      const hb = await deps.readGatewayHeartbeat(plan.revisionId);
      return hb != null && heartbeatMatchesImageTag(hb.version, plan.imageTag);
    },
    timeoutMessage: `gateway revision "${plan.revisionId}" never published a heartbeat with version=${plan.imageTag} within ${deps.heartbeatTimeoutMs}ms`,
  });
}

async function syncFleetIngress(ctx: OperationContext, deps: AddGatewayDeps): Promise<StepResult> {
  return runReportedStep({
    stepName: "fleet-ingress",
    ctx,
    deps,
    action: deps.syncFleetIngress,
  });
}

async function runReportedStep(args: {
  stepName: string;
  ctx: OperationContext;
  deps: AddGatewayDeps;
  action: () => Promise<void>;
}): Promise<StepResult> {
  const { stepName, ctx, deps, action } = args;
  const startedAt = deps.now();
  await reportStep(ctx, { name: stepName, status: "running", startedAt });

  try {
    await action();
    await reportStep(ctx, {
      name: stepName,
      status: "done",
      startedAt,
      completedAt: deps.now(),
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reportStep(ctx, {
      name: stepName,
      status: "failed",
      startedAt,
      completedAt: deps.now(),
      error: msg,
    });
    return { ok: false, error: msg };
  }
}

function failure(error: string): OperationResult {
  return { steps: [], success: false, error };
}

async function pollUntil(args: {
  stepName: string;
  timeoutMs: number;
  ctx: OperationContext;
  deps: AddGatewayDeps;
  check: () => Promise<boolean>;
  timeoutMessage: string;
}): Promise<StepResult> {
  const { stepName, timeoutMs, ctx, deps, check, timeoutMessage } = args;
  const startedAt = deps.now();
  await reportStep(ctx, { name: stepName, status: "running", startedAt });

  const deadline = startedAt + timeoutMs;
  while (true) {
    if (await check()) {
      await reportStep(ctx, {
        name: stepName,
        status: "done",
        startedAt,
        completedAt: deps.now(),
      });
      return { ok: true };
    }
    if (deps.now() >= deadline) {
      await reportStep(ctx, {
        name: stepName,
        status: "failed",
        startedAt,
        completedAt: deps.now(),
        error: timeoutMessage,
      });
      return { ok: false, error: timeoutMessage };
    }
    await deps.wait(deps.pollIntervalMs);
  }
}

async function reportStep(
  ctx: OperationContext,
  step: OperationStep & { status: StepStatus },
): Promise<void> {
  await ctx.reportStep(step);
}
