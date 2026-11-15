export interface ProjectAgentMembershipInput {
  defaultAgentMmUserId: string | null;
  projects: ReadonlyArray<{
    projectId: string;
    projectAgentConfigured: boolean;
    projectAgentMmUserId: string | null;
    channelIds: readonly string[];
  }>;
}

type MattermostCall = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
) => Promise<unknown>;

function isNotFound(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 404;
}

async function ensureChannelMember(
  call: MattermostCall,
  channelId: string,
  mmUserId: string,
): Promise<void> {
  try {
    await call("GET", `/channels/${channelId}/members/${mmUserId}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await call("POST", `/channels/${channelId}/members`, { user_id: mmUserId });
  }
}

type ProjectMembership = ProjectAgentMembershipInput["projects"][number];

function assertExclusiveChannelOwnership(projects: readonly ProjectMembership[]): void {
  const channelOwners = new Map<string, string>();
  for (const project of projects) {
    for (const channelId of project.channelIds) {
      const owner = channelOwners.get(channelId);
      if (owner && owner !== project.projectId) {
        throw new Error(`Mattermost channel ${channelId} is bound to multiple projects`);
      }
      channelOwners.set(channelId, project.projectId);
    }
  }
}

async function projectAgentMembershipError(
  project: ProjectMembership,
  channelId: string,
  call: MattermostCall,
): Promise<unknown> {
  if (!project.projectAgentConfigured || !project.projectAgentMmUserId) return undefined;
  try {
    await ensureChannelMember(call, channelId, project.projectAgentMmUserId);
    return undefined;
  } catch (error) {
    return error;
  }
}

async function reconcileProjectChannel(
  project: ProjectMembership,
  channelId: string,
  defaultAgentMmUserId: string | null,
  call: MattermostCall,
): Promise<void> {
  const agentError = await projectAgentMembershipError(project, channelId, call);
  if (defaultAgentMmUserId) await ensureChannelMember(call, channelId, defaultAgentMmUserId);
  if (agentError) throw agentError;
}

async function reconcileProjectMembership(
  project: ProjectMembership,
  defaultAgentMmUserId: string | null,
  call: MattermostCall,
): Promise<boolean> {
  const channelIds = [...new Set(project.channelIds)].sort();
  for (const channelId of channelIds) {
    await reconcileProjectChannel(project, channelId, defaultAgentMmUserId, call);
  }
  return channelIds.length > 0 && project.projectAgentConfigured && !project.projectAgentMmUserId;
}

export interface ProjectAgentMembershipResult {
  pendingProjectIds: string[];
}

export async function reconcileDefaultAgentProjectMembership(
  input: ProjectAgentMembershipInput,
  call: MattermostCall = mattermostAdminCall,
): Promise<ProjectAgentMembershipResult> {
  const projects = [...input.projects].sort((left, right) =>
    left.projectId.localeCompare(right.projectId));
  assertExclusiveChannelOwnership(projects);

  const pendingProjectIds: string[] = [];
  for (const project of projects) {
    if (await reconcileProjectMembership(project, input.defaultAgentMmUserId, call)) {
      pendingProjectIds.push(project.projectId);
    }
  }
  return { pendingProjectIds };
}

async function mattermostAdminCall(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const token = process.env.MM_ADMIN_TOKEN;
  if (!token) throw new Error("MM_ADMIN_TOKEN not configured");
  const base =
    process.env.MM_URL
    || process.env.MM_INTERNAL_URL
    || `http://mattermost.${process.env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:8065`;
  const response = await fetch(`${base}/api/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 404) {
    throw Object.assign(new Error(`Mattermost ${method} ${path} returned 404`), { status: 404 });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw Object.assign(
      new Error(`Mattermost ${method} ${path} failed: ${response.status} ${detail.slice(0, 200)}`),
      { status: response.status },
    );
  }
  return null;
}
