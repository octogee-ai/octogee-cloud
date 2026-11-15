import { describe, expect, it } from "vitest";

import type { WorkspaceProject } from "@octogee/core/platform-state";

import { isRunnableWorkspaceProject, projectRetentionActive } from "./active-workspace-project.js";

describe("projectRetentionActive", () => {
  it.each([
    ["a missing product document", undefined],
    ["no retention field", { name: "Orbit" }],
    ["active retention", { retention: { status: "active" } }],
  ])("accepts %s", (_label, data) => {
    expect(projectRetentionActive(data)).toBe(true);
  });

  it.each([
    ["retention archive", { retention: { status: "archived" } }],
    ["retention deleting", { retention: { status: "deleting" } }],
    ["retention deleted", { retention: { status: "deleted" } }],
    ["malformed retention", { retention: "active" }],
  ])("rejects %s", (_label, data) => {
    expect(projectRetentionActive(data)).toBe(false);
  });
});

const ACTIVE_RECORD: WorkspaceProject = {
  workspaceSlug: "mira",
  projectSlug: "orbit",
  ownerUid: "owner-1",
  ownerActive: true,
  giteaRepoName: "mira-orbit",
  provisioningState: "active",
  provisioningError: null,
  pendingVisibility: null,
  visibility: "private",
  checkoutEnabled: null,
  status: "building",
  archived: null,
  archivedAt: null,
  commercialLifecycleStatus: null,
  repoSource: null,
  agent: null,
  updatedAt: null,
};

describe("isRunnableWorkspaceProject", () => {
  it.each([
    ["no commercial lifecycle", {}],
    ["an active commercial lifecycle", { commercialLifecycleStatus: "active" }],
  ])("accepts a fully active project with %s", (_label, patch) => {
    expect(isRunnableWorkspaceProject({ ...ACTIVE_RECORD, ...patch }, "owner-1")).toBe(true);
  });

  it.each([
    ["wrong owner", { ownerUid: "other" }],
    ["inactive owner", { ownerActive: false }],
    ["unrecorded owner activity", { ownerActive: null }],
    ["missing status", { status: null }],
    ["unknown status", { status: "ready" }],
    ["archived", { status: "archived" }],
    ["missing provisioning", { provisioningState: null }],
    ["provisioning", { provisioningState: "provisioning" }],
    ["failed", { provisioningState: "failed" }],
    ["commercial archive", { commercialLifecycleStatus: "archived" }],
  ])("rejects %s", (_label, patch) => {
    expect(isRunnableWorkspaceProject({ ...ACTIVE_RECORD, ...patch }, "owner-1")).toBe(false);
  });
});
