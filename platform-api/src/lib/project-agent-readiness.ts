import { createHash } from "node:crypto";
import type { PlatformStateStore, Stored, WorkspaceChannel, WorkspaceProject } from "@octogee/core/platform-state";
import type { FleetBrokerProjectAgentReadiness } from "@octogee/shared/types/fleet-broker";
import { isValidProjectId } from "@octogee/shared/types/identity";
import { projectAgentSecretDocId } from "@octogee/core/mattermost/project-agent";

function validChannelIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 100 &&
    value.every((id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 128);
}

function parseReadinessReport(value: unknown): FleetBrokerProjectAgentReadiness | null {
  if (!value || typeof value !== "object") return null;
  const report = value as Partial<FleetBrokerProjectAgentReadiness>;
  if (!isValidProjectId(report.projectId) || typeof report.activationId !== "string" ||
    report.activationId.length === 0 || report.activationId.length > 128 ||
    typeof report.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(report.tokenHash) ||
    !validChannelIds(report.channelIds)) return null;
  return { projectId: report.projectId, activationId: report.activationId, tokenHash: report.tokenHash,
    channelIds: [...new Set(report.channelIds)].sort() };
}

export function parseProjectAgentReadinessReports(value: unknown): FleetBrokerProjectAgentReadiness[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
  const projects: FleetBrokerProjectAgentReadiness[] = [];
  for (const entry of value) {
    const report = parseReadinessReport(entry);
    if (!report) return null;
    projects.push(report);
  }
  return new Set(projects.map((project) => project.projectId)).size === projects.length ? projects : null;
}

function projectChannelIds(channels: readonly WorkspaceChannel[]): string[] {
  return [...new Set(channels.flatMap((channel) =>
    channel.kind !== "admin" && channel.mattermostChannelId !== null ? [channel.mattermostChannelId] : []))].sort();
}

interface ActivationRecord {
  report: FleetBrokerProjectAgentReadiness;
  project: Stored<WorkspaceProject> | null;
  personalToken: string | null;
  channels: readonly WorkspaceChannel[];
}

function activationMatches(uid: string, { report, project, personalToken, channels }: ActivationRecord): boolean {
  const agent = project?.agent;
  if (!project || project.ownerUid !== uid || !agent || project.commercialLifecycleStatus === "archived" ||
    agent.activationId !== report.activationId ||
    (agent.status !== "provisioning" && agent.status !== "ready")) return false;
  if (personalToken === null) return false;
  return createHash("sha256").update(personalToken).digest("hex") === report.tokenHash &&
    JSON.stringify(projectChannelIds(channels)) === JSON.stringify(report.channelIds);
}

export async function completeProjectAgentActivations(
  store: PlatformStateStore,
  input: { uid: string; gatewayId: string; slug: string; projects: FleetBrokerProjectAgentReadiness[] },
): Promise<boolean> {
  return store.transaction({ label: "project-agent-readiness" }, async (tx) => {
    const user = await tx.users.records.get(input.uid);
    if (user?.gateway?.gatewayId !== input.gatewayId) return false;
    const records = await Promise.all(input.projects.map(async (report): Promise<ActivationRecord> => {
      const [project, secret, channels] = await Promise.all([
        tx.workspaces.projects.get(input.slug, report.projectId),
        tx.secrets.get(input.uid, projectAgentSecretDocId(report.projectId)),
        tx.workspaces.channels.list({ workspaceSlug: input.slug, projectSlug: report.projectId }),
      ]);
      const personalToken = secret?.kind === "project-agent-mattermost" ? secret.personalToken : null;
      return { report, project, personalToken, channels };
    }));
    if (!records.every((record) => activationMatches(input.uid, record))) return false;
    for (const { report, project } of records) {
      if (!project?.agent || project.agent.status === "ready") continue;
      await tx.workspaces.projects.patch(input.slug, report.projectId, {
        agent: { ...project.agent, status: "ready", lastError: null, updatedAt: { serverNow: true } },
      });
    }
    return true;
  });
}
