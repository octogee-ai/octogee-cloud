import {
  createProjectGiteaRepo,
  giteaDeleteVerifiedRepo,
  giteaWriteFile,
  giteaWriteFiles,
  giteaWriteFilesIfAllAbsent,
} from "@octogee/core/git-host/gitea-client";
import { internalFetch } from "@octogee/core/internal-fetch";
import { workspaceGiteaOrg, projectRepoName } from "@octogee/core/gitea-naming";
import { renderReadmeTemplate } from "@octogee/core/templates/project-readmes";
import {
  notesWelcomeSeed,
  projectPlaybookSeeds,
  projectRecipeStarterSeeds,
} from "@octogee/core/templates/project-seeds";
import { seedBoardWelcomeIssue } from "../../lib/board-welcome.js";
import type { ProjectRecipeId } from "@octogee/shared/types/project";

export interface ProjectRepoProvisioningResult {
  created: boolean;
  error: string | null;
}

export class ProjectRepoProvisioningError extends Error {
  constructor(
    message: string,
    readonly created: boolean,
  ) {
    super(message);
    this.name = "ProjectRepoProvisioningError";
  }
}

export async function ensureProjectGiteaRepo(input: {
  workspaceId: string;
  slug: string;
  name: string;
  tagline: string;
  projectType: string | null;
  visibility: string;
  recipe: ProjectRecipeId;
  // GitHub-backed projects still get this Gitea repo, but their Board reads
  // the GitHub repo — a welcome issue here would be invisible (and seeding
  // into a user's imported GitHub repo is not ours to do).
  githubBacked?: boolean;
}): Promise<{ created: boolean }> {
  const org = workspaceGiteaOrg(input.workspaceId);
  const repoName = projectRepoName(input.slug);
  const created = await createProjectGiteaRepo(
    org,
    repoName,
    input.tagline || `Octogee project: ${input.name}`,
    input.visibility !== "public",
  );
  try {
    const body = renderReadmeTemplate(input.projectType, {
      name: input.name,
      tagline: input.tagline,
      owner: input.workspaceId,
      workspaceSlug: input.workspaceId,
      projectSlug: input.slug,
    });
    await giteaWriteFile(org, repoName, "README.md", body, "auto: seed project README");

    const today = new Date().toISOString().slice(0, 10);
    const playbookSeeds = [
      ...projectPlaybookSeeds({
        projectName: input.name,
        projectType: input.projectType,
        recipe: input.recipe,
        today,
      }),
      notesWelcomeSeed(input.name),
    ];
    await giteaWriteFiles(
      org,
      repoName,
      playbookSeeds.map((seed) => ({ path: seed.relPath, content: seed.content })),
      "auto: seed project playbook",
    );
    const starterSeeds = projectRecipeStarterSeeds({
      projectSlug: input.slug,
      recipe: input.recipe,
    });
    await giteaWriteFilesIfAllAbsent(
      org,
      repoName,
      starterSeeds.map((seed) => ({ path: seed.relPath, content: seed.content })),
      "auto: seed project starter",
    );
  } catch (error) {
    throw new ProjectRepoProvisioningError(errorMessage(error), created);
  }
  // A provisioning retry re-enters with the repo already created — seeding
  // again would duplicate the welcome card.
  if (created && !input.githubBacked) {
    await seedBoardWelcomeIssue({ workspaceId: input.workspaceId, slug: input.slug, name: input.name });
  }
  return { created };
}

export async function provisionProjectRepoResult(
  input: Parameters<typeof ensureProjectGiteaRepo>[0],
): Promise<ProjectRepoProvisioningResult> {
  if (process.env.GITEA_TOKEN) {
    try {
      return { ...(await ensureProjectGiteaRepo(input)), error: null };
    } catch (error) {
      return {
        created: error instanceof ProjectRepoProvisioningError && error.created,
        error: errorMessage(error),
      };
    }
  }
  try {
    const response = await internalFetch(`${giteaBrokerBase()}/internal/gitea/provision-project-repo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30_000),
    }, { requireProjectedToken: true });
    const body = await response.json().catch(() => null);
    if (response.ok) {
      return { created: isCreatedResult(body), error: null };
    }
    return {
      created: isCreatedResult(body),
      error: brokerError(response.status, body),
    };
  } catch (error) {
    return { created: false, error: errorMessage(error) };
  }
}

export async function provisionProjectRepo(
  input: Parameters<typeof ensureProjectGiteaRepo>[0],
): Promise<string | null> {
  return (await provisionProjectRepoResult(input)).error;
}

export async function deleteProjectRepo(input: {
  workspaceId: string;
  slug: string;
}): Promise<void> {
  if (process.env.GITEA_TOKEN) {
    await deleteProjectGiteaRepo(input);
    return;
  }
  const response = await internalFetch(`${giteaBrokerBase()}/internal/gitea/delete-project-repo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  }, { requireProjectedToken: true });
  if (response.ok) return;
  const body = await response.json().catch(() => null);
  throw new Error(brokerError(response.status, body));
}

export async function deleteProjectGiteaRepo(input: {
  workspaceId: string;
  slug: string;
}): Promise<void> {
  await giteaDeleteVerifiedRepo(workspaceGiteaOrg(input.workspaceId), projectRepoName(input.slug));
}

function giteaBrokerBase(): string {
  const base = process.env.FLEET_BROKER_URL ?? process.env.OPENCLAW_RUNTIME_BROKER_URL;
  if (!base) throw new Error("Gitea provisioning broker is not configured");
  let trimmed = base;
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

function isCreatedResult(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { created?: unknown }).created === true;
}

function brokerError(status: number, body: unknown): string {
  const error = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
    ? (body as { error: string }).error
    : "Gitea provisioning broker request failed";
  return `${error} (HTTP ${status})`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
