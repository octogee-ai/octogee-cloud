import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import { parseAgentId } from "@octogee/shared/types/identity";
import { logger as defaultLogger } from "../../../gateway-edge/src/middleware/logging.js";
import type { UserNotification, UserNotifier } from "../lib/user-notifications.js";
import { findAssignedUserByAgentId } from "../routes/fleet-broker.js";
import { normalizeTenantPolicyPath } from "../lib/tenant-route-policy.js";

export type TenantDenialTenant =
  | { kind: "gateway"; gatewayId: string; ownerUid?: string }
  | { kind: "platform"; actor: string }
  | { kind: "unbound" };

export type TenantDenialCause = "placement" | "policy";

export interface TenantDenial {
  method: string;
  path: string;
  reason: string;
  cause: TenantDenialCause;
  tenant: TenantDenialTenant;
  agentId: string | null;
}

export type TenantDenialReporter = (denial: TenantDenial) => Promise<void>;


type DenialLogger = Pick<typeof defaultLogger, "warn" | "error">;

export interface TenantDenialReporterOptions {
  store: PlatformStateRepositories;
  logger?: DenialLogger;
  notifyUsers?: UserNotifier;
  now?: () => number;
}

export const TENANT_DENIAL_NOTIFICATION_BUCKET_MS = 60 * 60 * 1000;

export function tenantDenialEventId(
  denial: TenantDenial & { tenant: { kind: "gateway"; gatewayId: string } },
  now: number,
): string {
  const bucket = Math.floor(now / TENANT_DENIAL_NOTIFICATION_BUCKET_MS);
  return `tenant-denied:${denial.tenant.gatewayId}:${normalizeTenantPolicyPath(denial.path)}:${bucket}`;
}

function agentLabel(agentId: string | null): string {
  const parsed = agentId ? parseAgentId(agentId) : null;
  if (parsed?.kind === "project") return `Your ${parsed.project} project agent`;
  if (parsed?.kind === "coach") return "Your workspace agent";
  return "Your gateway";
}

export function tenantDenialNotification(
  denial: TenantDenial & { tenant: { kind: "gateway"; gatewayId: string } },
  now: number,
): UserNotification {
  return {
    eventId: tenantDenialEventId(denial, now),
    category: "system.security",
    title: "Your agent hit a platform permission error",
    body:
      `${agentLabel(denial.agentId)} asked the platform for ${denial.path} and was refused: ${denial.reason}. ` +
      "Octogee has logged it for follow-up.",
    action: { type: "navigate", path: "/@me" },
  };
}

async function resolveAffectedUid(
  store: PlatformStateRepositories,
  tenant: Extract<TenantDenialTenant, { kind: "gateway" }>,
  agentId: string | null,
): Promise<string | null> {
  if (agentId && parseAgentId(agentId).kind !== "unknown") {
    const assigned = await findAssignedUserByAgentId(store, tenant.gatewayId, agentId);
    if (assigned) return assigned.uid;
  }
  return tenant.ownerUid ?? null;
}

export function createTenantDenialReporter(opts: TenantDenialReporterOptions): TenantDenialReporter {
  const logger = opts.logger ?? defaultLogger;
  const now = opts.now ?? Date.now;

  return async (denial) => {
    const fields = {
      method: denial.method,
      path: denial.path,
      reason: denial.reason,
      cause: denial.cause,
      tenant: denial.tenant,
      agentId: denial.agentId,
    };
    logger.warn("[tenant-enforcement] denied", fields);
    if (denial.tenant.kind !== "gateway" || denial.cause === "placement") return;
    const gatewayDenial = denial as TenantDenial & { tenant: { kind: "gateway"; gatewayId: string } };

    try {
      const uid = await resolveAffectedUid(opts.store, gatewayDenial.tenant, denial.agentId);
      if (!uid) {
        logger.warn("[tenant-enforcement] denial names no assigned user; inbox notification skipped", fields);
        return;
      }
      if (!opts.notifyUsers) return;
      const event = tenantDenialNotification(gatewayDenial, now());
      const result = await opts.notifyUsers(event, [uid]);
      if (result.failed.length > 0) {
        logger.error("[tenant-enforcement] denial notification failed", { ...fields, uid, eventId: event.eventId, failed: result.failed });
      }
    } catch (error) {
      logger.error("[tenant-enforcement] denial notification failed", { ...fields, error });
    }
  };
}
