import { isDeepStrictEqual } from "node:util";
import { parseScheduleCheckpoint } from "@octogee/core/fleet-state";
import { defaultAgentAutomationDefinition } from "@octogee/core/gateway-rpc";
import {
  OWNER_AUTOMATION_KEY,
  ownerAutomationDefinition,
  ownerAutomationKeyPrefix,
  type OwnerAutomationTenant,
} from "@octogee/shared/types/automations";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { NativeScheduleCheckpoint, ScheduleRecord, ScheduleRestoreFailureRecord } from "@octogee/shared/types/fleet-controller";

type CheckpointJob = NativeScheduleCheckpoint["jobs"][number];
type ScheduleOwner = Pick<FleetBrokerUserSnapshot, "slug" | "channels" | "mattermostUserId">;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function matchesDeclaration(value: unknown, expected: unknown): boolean {
  const pattern = record(expected);
  if (!pattern) return isDeepStrictEqual(value, expected);
  const actual = record(value);
  return !!actual && Object.entries(pattern).every(([key, item]) => matchesDeclaration(actual[key], item));
}

function ownerDeclaration(job: CheckpointJob, tenant: OwnerAutomationTenant): Record<string, unknown> | undefined {
  const prefix = ownerAutomationKeyPrefix(tenant);
  if (typeof job.declarationKey !== "string" || !job.declarationKey.startsWith(prefix)) return;
  const key = job.declarationKey.slice(prefix.length);
  const { expr, tz } = record(job.schedule) ?? {};
  const { message } = record(job.payload) ?? {};
  const name = job.displayName ?? job.name;
  if (!OWNER_AUTOMATION_KEY.test(key) || typeof expr !== "string" || typeof tz !== "string" ||
      typeof message !== "string" || !message.trim() || message.length > 4_000 ||
      typeof name !== "string" || !name.trim() || name.length > 100) return;
  const definition = ownerAutomationDefinition(tenant, { key, name, prompt: message, schedule: { expr, tz } });
  const scope = ["agentId", "owner", "sessionTarget", "schedule", "payload", "delivery", "scheduledToolPolicy", "toolsAllowProvenance"];
  if (!scope.every(field => matchesDeclaration(job[field], definition[field]))) return;
  return definition;
}

function recoveryDeclaration(job: CheckpointJob, user: ScheduleOwner): Record<string, unknown> | undefined {
  const agentId = `octogee-${user.slug}-coach`;
  if (job.agentId !== agentId || typeof job.enabled !== "boolean") return;
  const channels = user.channels.filter(channel => channel.scope === "workspace" && channel.kind === "coach-dm");
  const coachChannelId = channels.length === 1 ? channels[0].channelId : "";
  if (!/^[a-z0-9]{26}$/u.test(coachChannelId)) return;
  if (job.declarationKey === `octogee:coach-monitor:${agentId}`) {
    return { ...defaultAgentAutomationDefinition({ slug: user.slug, coachChannelId }), enabled: job.enabled };
  }
  if (!user.mattermostUserId) return;
  const definition = ownerDeclaration(job, { slug: user.slug, agentId, coachChannelId, ownerMattermostUserId: user.mattermostUserId });
  return definition && { ...definition, enabled: job.enabled };
}

export function planDisklessScheduleRecovery(input: {
  snapshot: unknown;
  migrationId: string;
  requesterProfileId: string | null;
  owner: ScheduleOwner;
}) {
  const snapshot = parseScheduleCheckpoint(input.snapshot);
  if (!snapshot || snapshot.operationId !== input.migrationId) throw new Error("Invalid saved diskless scheduler checkpoint");
  const jobs: CheckpointJob[] = [];
  const declarations: ScheduleRecord[] = [];
  const retained: ScheduleRestoreFailureRecord[] = [];
  const scratch = new Map(snapshot.scratch.map(entry => [entry.jobId, entry.content]));
  for (const job of snapshot.jobs) {
    const source = record(record(job.operatorSource)?.source);
    if (source?.kind !== "gateway" || (input.requesterProfileId !== null && record(source.snapshot)?.profileId === input.requesterProfileId)) {
      jobs.push(job);
      continue;
    }
    const declaration = recoveryDeclaration(job, input.owner);
    if (declaration) {
      declarations.push({ sourceJobId: job.id, agentId: job.agentId, job: declaration, scratch: scratch.get(job.id) ?? null });
    } else {
      retained.push({ name: typeof job.name === "string" ? job.name : job.id, agentId: job.agentId, sourceJobId: job.id,
        error: "Saved in the source checkpoint. Restore requires the original scheduler requester." });
    }
  }
  const nativeIds = new Set(jobs.map(job => job.id));
  return { native: { ...snapshot, jobs, scratch: snapshot.scratch.filter(entry => nativeIds.has(entry.jobId)) }, declarations, retained };
}
