import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import {
  createAgentSupportTurnVerifier,
  createOwnerWorkspaceTurnVerifier,
  createProjectWorkspaceTurnVerifier,
  type OwnerTurnUser,
} from "./openclaw-owner-turn.js";

const OWNER = "uid-eggman";

function runnableProject(overrides: Record<string, unknown> = {}) {
  return {
    ownerUid: OWNER,
    ownerActive: true,
    status: "building",
    provisioningState: "active",
    ...overrides,
  };
}

function turnStore(input: {
  workspace?: Record<string, unknown>;
  project?: Record<string, unknown>;
} = {}) {
  return createDocumentFixtureStore({
    ...(input.workspace ? { "workspaces/eggman": input.workspace } : {}),
    ...(input.project ? { "workspaces/eggman/projects/orbit": input.project } : {}),
  });
}

const activeWorkspace = { id: "eggman", ownerUid: OWNER, ownerActive: true };

function turn(overrides: Partial<{
  agentId: string;
  ownerUid: string;
  owner: OwnerTurnUser;
}> = {}) {
  return {
    req: { body: {} } as Request,
    gatewayId: "shared-slot",
    agentId: overrides.agentId ?? "octogee-eggman-coach",
    ownerUid: overrides.ownerUid ?? OWNER,
    owner: overrides.owner ?? { workspaceId: "eggman", mattermostUserId: null },
  };
}

const projectAgent = "octogee-eggman-proj-orbit-coach";

describe("createOwnerWorkspaceTurnVerifier", () => {
  it("allows the workspace agent without any originating Mattermost turn", async () => {
    const verify = createOwnerWorkspaceTurnVerifier(turnStore({ workspace: activeWorkspace }));

    await expect(verify(turn())).resolves.toBe(true);
  });

  it.each([
    ["the workspace is missing", {}],
    ["the workspace belongs to another owner", { workspace: { id: "eggman", ownerUid: "uid-other", ownerActive: true } }],
    ["the owner is suspended", { workspace: { id: "eggman", ownerUid: OWNER, ownerActive: false } }],
  ])("refuses when %s", async (_case, seeds) => {
    const verify = createOwnerWorkspaceTurnVerifier(turnStore(seeds));

    await expect(verify(turn())).resolves.toBe(false);
  });

  it("refuses a agent of a workspace the calling gateway is not serving", async () => {
    const verify = createOwnerWorkspaceTurnVerifier(turnStore({ workspace: activeWorkspace }));

    await expect(verify(turn({ owner: { workspaceId: "tails", mattermostUserId: null } }))).resolves.toBe(false);
  });

  it("refuses a project agent", async () => {
    const verify = createOwnerWorkspaceTurnVerifier(
      turnStore({ workspace: activeWorkspace, project: runnableProject() }),
    );

    await expect(verify(turn({ agentId: projectAgent }))).resolves.toBe(false);
  });
});

describe("createProjectWorkspaceTurnVerifier", () => {
  it("allows a runnable project's agent without any originating Mattermost turn", async () => {
    const verify = createProjectWorkspaceTurnVerifier(
      turnStore({ workspace: activeWorkspace, project: runnableProject() }),
    );

    await expect(verify(turn({ agentId: projectAgent }))).resolves.toBe(true);
  });

  it.each([
    ["the project is missing", undefined],
    ["the project belongs to another owner", runnableProject({ ownerUid: "uid-other" })],
    ["the project is archived", runnableProject({ commercialLifecycle: { status: "archived" } })],
    ["the project is still provisioning", runnableProject({ provisioningState: "provisioning" })],
  ])("refuses when %s", async (_case, project) => {
    const verify = createProjectWorkspaceTurnVerifier(turnStore({ workspace: activeWorkspace, project }));

    await expect(verify(turn({ agentId: projectAgent }))).resolves.toBe(false);
  });

  it("refuses when the owner is suspended", async () => {
    const verify = createProjectWorkspaceTurnVerifier(turnStore({
      workspace: { id: "eggman", ownerUid: OWNER, ownerActive: false },
      project: runnableProject(),
    }));

    await expect(verify(turn({ agentId: projectAgent }))).resolves.toBe(false);
  });

  it("refuses the workspace agent", async () => {
    const verify = createProjectWorkspaceTurnVerifier(
      turnStore({ workspace: activeWorkspace, project: runnableProject() }),
    );

    await expect(verify(turn())).resolves.toBe(false);
  });
});

describe("createAgentSupportTurnVerifier", () => {
  const store = turnStore({ workspace: activeWorkspace, project: runnableProject() });

  it("verifies a project agent through the project lane", async () => {
    await expect(createAgentSupportTurnVerifier(store)(turn({ agentId: projectAgent }))).resolves.toBe(true);
  });

  it("verifies a workspace agent through the owner lane", async () => {
    await expect(createAgentSupportTurnVerifier(store)(turn())).resolves.toBe(true);
  });

  it("refuses an identity that is neither a agent nor a project agent", async () => {
    await expect(createAgentSupportTurnVerifier(store)(turn({ agentId: "some-other-agent" }))).resolves.toBe(false);
  });
});
