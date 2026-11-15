import type { FileTarget } from "@octogee/core/workspace/fileTarget";
import { createIssue } from "./issues.js";
import { giteaUsername, workspaceGiteaOrg, projectRepoName } from "@octogee/core/gitea-naming";
import { logger } from "@octogee/core/http/logging";

export const BOARD_WELCOME_TITLE = "👋 Welcome to your Board";

export function boardWelcomeBody(projectName: string): string {
  return `This card is the first item of work in ${projectName} — and the Board is where work lives.

**How it works**

- Every card is a real issue in your project's repo. Your Agent sees and manages them too.
- Drag cards between columns as work moves: **Backlog → To do → Doing → Review → Done**.
- Moving a card to **Done** closes it; Pulse counts it as shipped that week.
- Tap a card to open it — edit the description, add labels, comments, and screenshots.
- Label something **bug** and Pulse tracks it in your bug backlog until it's fixed.

**Let your Agent drive**

Ask in chat: "add a card for …", "move the login card to Done", "what's on the board?" — your Agent keeps the Board honest while you build.

When you've had a look around, drag this card to **Done**. That's your first ship. 🚀
`;
}

// Seeded during project provisioning so a new user never opens an empty
// Board. A miss here must never fail project creation — the Board works
// without it — but it is always logged.
export async function seedBoardWelcomeIssue(input: {
  workspaceId: string;
  slug: string;
  name: string;
}): Promise<void> {
  const target: FileTarget = {
    slug: input.workspaceId,
    projectSlug: input.slug,
    provider: "gitea",
    org: workspaceGiteaOrg(input.workspaceId),
    repoName: projectRepoName(input.slug),
    gcsPrefix: `customers/${input.workspaceId}/projects/${input.slug}`,
    sudoUser: giteaUsername(input.workspaceId),
  };
  try {
    await createIssue(target, {
      title: BOARD_WELCOME_TITLE,
      body: boardWelcomeBody(input.name),
      status: "todo",
    });
  } catch (error) {
    logger.warn(
      `[projects] board welcome issue seed failed for ${input.workspaceId}/${input.slug}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
