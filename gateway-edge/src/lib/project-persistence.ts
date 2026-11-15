import { saveProjectAgentWorkspaces } from "@octogee/core/project-agent-workspaces";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { readProjectRestoreReady, readProjectRestoreState } from "@octogee/core/project-asset-state";
import { createBrokeredProjectBlobHydrator, prepareUserProjectAssets } from "@octogee/core/project-blob-materialization";
import { projectBlobHydrationClient } from "@octogee/core/workspace/project-blob-upload";
import { logger } from "@octogee/core/http/logging";
import { isValidProjectId, isValidUsername } from "@octogee/shared/types/identity";
import { commitAndPushWorkspace, isTrustedGithubUserCheckout, isTrustedGiteaUserCheckout, resolveUserDir, resolveProjectDir } from "@octogee/core/workspace/workspace-git";
import { divertWorktreeBinaries } from "@octogee/core/workspace/binary-diversion";
import { readOwnerRuntimeConnectorAccessToken } from "@octogee/core/connectors/connector-tokens";
import { gatewayCredentialHeaders, internalFetch } from "@octogee/core/internal-fetch";
import type { FleetBrokerAssignmentRosterEntry, FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import type { WorkspaceBlobTarget } from "@octogee/core/workspace/workspace-blob";
import { PROJECT_AGENT_WORKSPACE_PARTS, projectCheckoutEnabled } from "@octogee/shared/types/project";

type PersistenceUser = Pick<FleetBrokerUserSnapshot, "uid" | "slug" | "gatewayId" | "status" | "projects" | "projectAgents"> & { checkpointEpoch: number };

interface ProjectPersistenceDeps {
  readUser: (slug: string) => Promise<PersistenceUser>;
  resolveProject: typeof resolveProjectDir;
  commit: typeof commitAndPushWorkspace;
  divert: typeof divertWorktreeBinaries;
  githubToken: (dir: string) => Promise<string | undefined>;
  prepare: (input: { root: string; slug: string; project: string }) => Promise<void>;
}
const defaults: ProjectPersistenceDeps = {
  readUser: readPersistenceUser,
  resolveProject: resolveProjectDir,
  prepare: async input => {
    const base = process.env.FLEET_BROKER_URL || process.env.OCTOGEE_API_URL;
    if (!base) throw new Error("project preparation requires its configured fleet broker");
    await prepareUserProjectAssets({ projects: path.join(input.root, input.slug, "projects"), slug: input.slug, project: input.project,
      hydrate: createBrokeredProjectBlobHydrator(projectBlobHydrationClient(base), input.root), requireRestoredCheckout: true,
      log: message => logger.warn(message) });
  },
  commit: commitAndPushWorkspace,
  divert: (dir, target) => divertWorktreeBinaries(dir, target, undefined, { retainLocalFiles: true }),
  githubToken: async dir => {
    if (!isTrustedGithubUserCheckout(dir)) return undefined;
    const token = await readOwnerRuntimeConnectorAccessToken("github");
    if (!token) throw new Error("Reconnect GitHub before saving this project");
    return token;
  },
};

const persistenceTails = new Map<string, Promise<void>>();
const PERSISTENCE_QUEUE_WAIT_MS = 60_000;

async function waitForPreviousPersistence(previous: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("project persistence queue timeout; local work retained")), PERSISTENCE_QUEUE_WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function persistUserProjects(input: { root: string; slug: string }, deps: ProjectPersistenceDeps = defaults): Promise<{ projects: number }> {
  return serializePersistence(input, () => persistProjectsOnce(input, deps));
}

async function serializePersistence(input: { root: string; slug: string }, save: () => Promise<{ projects: number }>): Promise<{ projects: number }> {
  if (!isValidUsername(input.slug)) throw new Error("invalid project owner");
  const key = path.resolve(input.root, input.slug);
  const previous = persistenceTails.get(key);
  let release!: () => void;
  const completion = new Promise<void>(resolve => { release = resolve; });
  const tail = previous ? previous.then(() => completion) : completion;
  persistenceTails.set(key, tail);
  try {
    if (previous) await waitForPreviousPersistence(previous);
    return await save();
  } finally {
    release();
    void tail.then(() => { if (persistenceTails.get(key) === tail) persistenceTails.delete(key); });
  }
}

interface SharedPersistenceDeps {
  readUser: (slug: string) => Promise<PersistenceUser>;
  resolveUser: typeof resolveUserDir;
  resolveProject: typeof resolveProjectDir;
  commit: typeof commitAndPushWorkspace;
  divert: (dir: string, target: WorkspaceBlobTarget, options?: { excludePaths: string[] }) => ReturnType<typeof divertWorktreeBinaries>;
  trustedGitea: typeof isTrustedGiteaUserCheckout;
}

async function readPersistenceUser(slug: string): Promise<PersistenceUser> {
  const gatewayId = process.env.GATEWAY_ID;
  const base = (process.env.FLEET_BROKER_URL || process.env.OCTOGEE_API_URL)?.replace(/\/$/u, "");
  if (!isValidGatewayId(gatewayId) || !base) throw new Error("Project persistence requires its gateway and fleet broker");
  const post = async (route: string, body: object) => {
    const response = await internalFetch(`${base}/internal/fleet/${route}`, {
      method: "POST", headers: { "content-type": "application/json", ...await gatewayCredentialHeaders() },
      body: JSON.stringify({ gatewayId, ...body }),
    });
    if (!response.ok) throw new Error(`Project checkpoint admission failed: HTTP ${response.status}`);
    return response.json();
  };
  const { uid } = await post("uid-for-slug", { slug }) as { uid?: unknown };
  if (typeof uid !== "string" || !uid) throw new Error("Project checkpoint owner is unavailable");
  const { user } = await post("user-snapshot", { uid }) as { user?: FleetBrokerUserSnapshot };
  assertPersistenceUser(user, { uid, slug, gatewayId });
  const { assignments } = await post("assignment-roster", { revisionId: gatewayId }) as { assignments?: FleetBrokerAssignmentRosterEntry[] };
  return { ...user, checkpointEpoch: checkpointAssignmentEpoch(assignments, uid) };
}

function assertPersistenceUser(user: FleetBrokerUserSnapshot | undefined, expected: { uid: string; slug: string; gatewayId: string }): asserts user is FleetBrokerUserSnapshot {
  if (!user || user.uid !== expected.uid || user.slug !== expected.slug || user.gatewayId !== expected.gatewayId ||
      user.status !== "complete" || !Array.isArray(user.projects)) {
    throw new Error("Project checkpoint owner is no longer assigned and ready here");
  }
}

function checkpointAssignmentEpoch(assignments: FleetBrokerAssignmentRosterEntry[] | undefined, uid: string): number {
  const owned = assignments?.filter(row => row.uid === uid);
  if (!owned || owned.length !== 1 || !["serving", "quiescing"].includes(owned[0].state) ||
      !Number.isSafeInteger(owned[0].epoch) || owned[0].epoch < 0) {
    throw new Error("Project checkpoint canonical assignment is unavailable");
  }
  return owned[0].epoch;
}

const sharedDefaults: SharedPersistenceDeps = {
  readUser: readPersistenceUser, resolveUser: resolveUserDir, resolveProject: resolveProjectDir,
  commit: commitAndPushWorkspace, trustedGitea: isTrustedGiteaUserCheckout,
  divert: (dir, target, options) => divertWorktreeBinaries(dir, target, undefined, { retainLocalFiles: target.projectSlug !== null, ...options }),
};

function sharedGiteaProjects(user: PersistenceUser): Map<string, string> {
  const projects = new Map<string, string>();
  for (const project of user.projects) {
    if (project.checkoutEnabled === false || project.repoSource?.provider === "github" ||
        (project.provisioningState !== undefined && project.provisioningState !== "active")) continue;
    if (!isValidProjectId(project.projectSlug) || !isValidProjectId(project.giteaRepoName) || projects.has(project.projectSlug)) {
      throw new Error("Shared checkpoint project source is invalid");
    }
    projects.set(project.projectSlug, project.giteaRepoName);
  }
  return projects;
}

async function assertCheckpointDirectory(input: { root: string; slug: string }, project: string | null): Promise<void> {
  const user = path.join(input.root, input.slug);
  const directories = [input.root, user, ...(project ? [path.join(user, "projects"), path.join(user, "projects", project)] : [])];
  for (const directory of directories) {
    if (!(await lstat(directory)).isDirectory()) throw new Error("Project checkpoint directory is not confined");
  }
}

function githubAgentProjects(user: PersistenceUser): string[] {
  return (user.projectAgents ?? []).filter(agent =>
    agent.githubBacked && agent.enabled && agent.status !== "error" && agent.token,
  ).map(agent => agent.projectId).sort();
}

async function saveGithubProjectAgents(input: { root: string; slug: string }, user: PersistenceUser, readUser: SharedPersistenceDeps["readUser"]): Promise<void> {
  const projects = githubAgentProjects(user);
  await saveProjectAgentWorkspaces({ customerDir: path.join(input.root, input.slug), slug: input.slug, projects, checkpointEpoch: user.checkpointEpoch, assertCurrent: async () => {
    const current = await readUser(input.slug);
    if (current.uid !== user.uid || current.gatewayId !== user.gatewayId || current.checkpointEpoch !== user.checkpointEpoch ||
        JSON.stringify(githubAgentProjects(current)) !== JSON.stringify(projects)) {
      throw new Error("Project agent checkpoint authority changed");
    }
  } });
}

export async function persistSharedUserFiles(input: { root: string; slug: string }, deps: SharedPersistenceDeps = sharedDefaults): Promise<{ projects: number }> {
  return serializePersistence(input, async () => {
    const user = await deps.readUser(input.slug);
    await saveGithubProjectAgents(input, user, deps.readUser);
    const projects = sharedGiteaProjects(user);
    for (const [project, repo] of [[null, "workspace"], ...projects] as Array<[string | null, string]>) {
      const assertCurrent = async () => {
        await assertCheckpointDirectory(input, project);
        const current = await deps.readUser(input.slug);
        if (current.uid !== user.uid || current.gatewayId !== user.gatewayId || current.checkpointEpoch !== user.checkpointEpoch ||
            (project !== null && sharedGiteaProjects(current).get(project) !== repo)) {
          throw new Error("Shared checkpoint authority changed");
        }
      };
      await assertCurrent();
      const dir = project === null ? await deps.resolveUser(input.root, input.slug) : await deps.resolveProject(input.root, input.slug, project);
      if (!dir || !deps.trustedGitea(dir, repo)) throw new Error("Shared checkpoint canonical Gitea checkout is unavailable");
      const saved = await deps.commit(dir, {
        message: "autosave: workspace changes", author: { name: "Octogee autosave", email: `${input.slug}@octogee.com` },
        assertCurrent,
        beforeCommit: async () => {
          await assertCurrent();
          const excludePaths = project === null ? ["projects", PROJECT_AGENT_WORKSPACE_PARTS.join("/")] : [];
          const gcsPrefix = project ? `customers/${input.slug}/projects/${project}` : `customers/${input.slug}`;
          const result = await deps.divert(dir, { slug: input.slug, projectSlug: project, gcsPrefix }, { excludePaths });
          return result.failures.length ? { ok: false, error: { code: "BLOB_DIVERSION_FAILED", cwd: dir, paths: result.failedPaths } }
            : { ok: true, excludePaths: [...excludePaths, ...result.diverted.map(blob => blob.path)] };
        },
      });
      if (!saved.ok) throw new Error(`Shared checkpoint failed: ${saved.error.code}`);
      if (!saved.result.pushed) throw new Error(`Shared checkpoint remote push unconfirmed: ${saved.result.pushError || repo}`);
      await assertCurrent();
    }
    return { projects: projects.size };
  });
}

async function persistProjectsOnce(input: { root: string; slug: string }, deps: ProjectPersistenceDeps): Promise<{ projects: number }> {
  const user = await deps.readUser(input.slug);
  if (user.slug !== input.slug) throw new Error("Project persistence owner differs");
  await saveGithubProjectAgents(input, user, deps.readUser);
  const projects = userProjectCheckouts(user);
  for (const [project, source] of projects) {
    const assertCurrent = async () => {
      await assertCheckpointDirectory(input, project);
      const current = await deps.readUser(input.slug);
      if (current.uid !== user.uid || current.slug !== user.slug || current.gatewayId !== user.gatewayId ||
          current.checkpointEpoch !== user.checkpointEpoch || userProjectCheckouts(current).get(project) !== source) {
        throw new Error("Project persistence authority changed");
      }
    };
    await assertCurrent();
    const dir = await deps.resolveProject(input.root, input.slug, project);
    if (!dir) throw new Error(`project repository unavailable: ${project}`);
    await prepareChangedProjectAssets({ ...input, project }, dir, deps);
    const githubToken = await deps.githubToken(dir);
    const saved = await deps.commit(dir, {
      message: "autosave: project changes",
      author: { name: "Octogee autosave", email: `${input.slug}@octogee.com` },
      assertCurrent,
      ...(githubToken ? { githubToken } : {}),
      beforeCommit: async () => {
        await assertCurrent();
        const result = await deps.divert(dir, { slug: input.slug, projectSlug: project, gcsPrefix: `customers/${input.slug}/projects/${project}` });
        return result.failures.length
          ? { ok: false, error: { code: "BLOB_DIVERSION_FAILED", cwd: dir, paths: result.failedPaths } }
          : { ok: true, excludePaths: result.diverted.map(blob => blob.path) };
      },
    });
    if (!saved.ok) throw new Error(`project ${project}: ${saved.error.code}`);
    if (!saved.result.pushed) throw new Error(`project ${project}: ${saved.result.pushError || "remote push unconfirmed"}`);
    await assertCurrent();
    await prepareChangedProjectAssets({ ...input, project }, dir, deps);
  }
  return { projects: projects.size };
}

function userProjectCheckouts(user: PersistenceUser): Map<string, string> {
  const projects = new Map<string, string>();
  for (const project of user.projects) {
    if (!projectCheckoutEnabled(project.checkoutEnabled) ||
        project.provisioningState !== undefined && project.provisioningState !== "active") continue;
    if (!isValidProjectId(project.projectSlug) || projects.has(project.projectSlug)) throw new Error("User project checkout source is invalid");
    projects.set(project.projectSlug, JSON.stringify([project.giteaRepoName, project.repoSource?.provider, project.repoSource?.owner, project.repoSource?.repo]));
  }
  return projects;
}

async function prepareChangedProjectAssets(input: { root: string; slug: string; project: string }, dir: string, deps: ProjectPersistenceDeps): Promise<void> {
  const state = await readProjectRestoreState(dir, input.slug, input.project);
  if (state === "unrestored") throw new Error(`project restore is incomplete: ${input.project}`);
  if (state === "manifest-changed") {
    await deps.prepare(input);
    if (!await readProjectRestoreReady(dir, input.slug, input.project)) throw new Error(`project restore is incomplete: ${input.project}`);
  }
}
