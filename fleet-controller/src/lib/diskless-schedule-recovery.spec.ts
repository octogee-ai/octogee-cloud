import { expect, it } from "vitest";
import { ownerAutomationDefinition } from "@octogee/shared/types/automations";
import { planDisklessScheduleRecovery } from "./diskless-schedule-recovery.js";

const agentId = "octogee-alice-coach";
const coachChannelId = "a".repeat(26);
const owner = { slug: "alice", mattermostUserId: "mm-alice",
  channels: [{ scope: "workspace" as const, kind: "coach-dm", channelId: coachChannelId }] };

function job(profileId: string, fields: Record<string, unknown> = {}) {
  return { id: profileId, agentId, enabled: true,
    operatorSource: { source: { kind: "gateway", snapshot: { profileId } } }, ...fields };
}

function plan(jobs: ReturnType<typeof job>[]) {
  return planDisklessScheduleRecovery({ migrationId: "move", requesterProfileId: "shared-service", owner,
    snapshot: { version: 1, operationId: "move", agentIds: [agentId], jobs,
      scratch: jobs.map(({ id }) => ({ jobId: id, content: `scratch for ${id}`, revision: 1, updatedAtMs: 42, sourceSha256: null })),
    },
  });
}

it("moves matching scheduler authorities natively and re-creates locked-down owner declarations", () => {
  const definition = ownerAutomationDefinition({ ...owner, agentId, coachChannelId, ownerMattermostUserId: "mm-alice" },
    { key: "briefing", name: "Briefing", prompt: "Summarize my calendar", schedule: { expr: "0 9 * * *", tz: "UTC" } });
  const managed = job("hobby-edge", definition);
  const native = job("shared-service");
  const manual = job("different-user", { name: "Manual job" });
  const recovery = plan([managed, native, manual]);
  expect(recovery.native.jobs).toEqual([native]);
  expect(recovery.native.scratch.map(entry => entry.jobId)).toEqual([native.id]);
  expect(recovery.declarations).toEqual([{ sourceJobId: managed.id, agentId, job: definition, scratch: "scratch for hobby-edge" }]);
  expect(recovery.retained).toEqual([expect.objectContaining({ sourceJobId: manual.id })]);
});

it("retains requester-bound jobs with another owner or expanded tool permissions", () => {
  const tenant = { ...owner, agentId, coachChannelId, ownerMattermostUserId: "mm-bob" };
  const declaration = ownerAutomationDefinition(tenant,
    { key: "briefing", name: "Briefing", prompt: "Summarize my calendar", schedule: { expr: "0 9 * * *", tz: "UTC" } });
  const broad = ownerAutomationDefinition({ ...tenant, ownerMattermostUserId: "mm-alice" },
    { key: "broad", name: "Expanded", prompt: "Use tools", schedule: { expr: "0 9 * * *", tz: "UTC" } });
  broad.payload = { kind: "agentTurn", message: "Use tools", toolsAllow: ["*"] };
  const recovery = plan([job("first", declaration), job("second", broad)]);
  expect(recovery.declarations).toEqual([]);
  expect(recovery.retained.map(entry => entry.sourceJobId)).toEqual(["first", "second"]);
});
