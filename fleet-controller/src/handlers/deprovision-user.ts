

import type { Operation, OperationStep, StepStatus } from "@octogee/shared/types/glm";
import type {
  OperationContext,
  OperationHandler,
  OperationResult,
} from "../operation-router.js";
import type {
  NukeCloudCtx,
  NukeCloudDeps,
  NukeCloudStepResult,
} from "../lib/user-ops/nuke-cloud.js";
import { nukeUserCloudSide } from "../lib/user-ops/nuke-cloud.js";
import type { UnmountOutcome } from "../lib/user-ops/unmount-gateway.js";

export interface UserCleanupContext {
  uid: string;
  slug: string;
  email: string | null;
  giteaOrg: string;
  
  repoNames: string[];

projectSlugs: string[];
  workspaceTeamId: string | null;
  mmUserId: string | null;
  mmCoachUserId: string | null;
  adminChannelId: string | null;
  
  currentGatewayId: string | null;
  credentialSecretNames: string[];
  projectAgentMmUserIds: string[];
  projectAgentCredentialDocPaths: string[];
  chatArtifactIds: string[];
  agentImportIds: string[];
}

export interface DeprovisionUserDeps {

  loadCleanupContext: (uid: string) => Promise<UserCleanupContext | null>;

  unmountFromGateway: (gatewayId: string, slug: string) => Promise<UnmountOutcome>;

  cloudCleanup: NukeCloudDeps;
  
  now: () => number;
  log: (msg: string) => void;
}

interface DeprovisionInput {
  uid?: unknown;
  
  skipAuth?: unknown;
}

export function createDeprovisionUserHandler(
  deps: DeprovisionUserDeps,
): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as DeprovisionInput;
    const uid = typeof input.uid === "string" ? input.uid : undefined;
    if (!uid) {
      return { steps: [], success: false, error: "missing uid in op.input" };
    }
    const skipAuth = input.skipAuth === true;

    const cleanup = await deps.loadCleanupContext(uid);
    if (!cleanup) {
      return { steps: [], success: false, error: `user not found: ${uid}` };
    }
    if (!cleanup.slug) {
      return {
        steps: [],
        success: false,
        error: `user ${uid} has no slug — use the inline lite-delete path, not deprovision-customer`,
      };
    }

let unmountFailure: string | null = null;
if (cleanup.currentGatewayId) {
      const startedAt = deps.now();
      await reportStep(ctx, { name: "unmount-gateway", status: "running", startedAt });
      try {
        const outcome = await deps.unmountFromGateway(cleanup.currentGatewayId, cleanup.slug);
        await reportStep(ctx, {
          name: "unmount-gateway",
          status: outcome === "skipped-no-live-pod" ? "skipped" : "done",
          startedAt,
          completedAt: deps.now(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        unmountFailure = message;

deps.log(`[deprovision] unmount RPC failed for ${cleanup.slug} on ${cleanup.currentGatewayId}: ${message}`);
        await reportStep(ctx, {
          name: "unmount-gateway",
          status: "failed",
          startedAt,
          completedAt: deps.now(),
          error: message,
        });
      }
    } else {
      await reportStep(ctx, {
        name: "unmount-gateway",
        status: "skipped",
        startedAt: deps.now(),
        completedAt: deps.now(),
      });
    }

const nukeCtx: NukeCloudCtx = {
      uid: cleanup.uid,
      currentOperationId: op.id,
      slug: cleanup.slug,
      email: cleanup.email,
      repoNames: cleanup.repoNames,
      projectSlugs: cleanup.projectSlugs,
      workspaceTeamId: cleanup.workspaceTeamId,
      mmUserId: cleanup.mmUserId,
      mmCoachUserId: cleanup.mmCoachUserId,
      adminChannelId: cleanup.adminChannelId,
      credentialSecretNames: cleanup.credentialSecretNames,
      projectAgentMmUserIds: cleanup.projectAgentMmUserIds,
      projectAgentCredentialDocPaths: cleanup.projectAgentCredentialDocPaths,
      chatArtifactIds: cleanup.chatArtifactIds,
      agentImportIds: cleanup.agentImportIds,
      skipAuth,
    };
    const stepResults = await nukeUserCloudSide(nukeCtx, deps.cloudCleanup);
    for (const r of stepResults) {
      await reportStep(ctx, stepResultToOperationStep(r, deps.now()));
    }

    const failed = stepResults.filter((r) => !r.ok && !r.skipped);
    if (failed.length > 0 || unmountFailure) {
      const summary = [
        ...(unmountFailure ? [`unmount-gateway: ${unmountFailure}`] : []),
        ...failed.map((r) => `${r.key}: ${r.error}`),
      ].join("; ");
      return { steps: [], success: false, error: `cloud cleanup partial failure — ${summary}` };
    }
    return { steps: [], success: true };
  };
}

function deriveStepStatus(r: NukeCloudStepResult): StepStatus {
  if (r.skipped) return "skipped";
  if (r.ok) return "done";
  return "failed";
}

function stepResultToOperationStep(r: NukeCloudStepResult, completedAt: number): OperationStep {
  const step: OperationStep = { name: r.key, status: deriveStepStatus(r), completedAt };
  if (r.error) step.error = r.error;
  if (r.detail) step.detail = r.detail;
  return step;
}

async function reportStep(
  ctx: OperationContext,
  step: OperationStep & { status: StepStatus },
): Promise<void> {
  await ctx.reportStep(step);
}
