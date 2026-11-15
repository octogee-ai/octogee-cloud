import { describe, it, expect } from "vitest";
import { projectsNeedingClone, type ProjectRestoreInput } from "../lib/openclaw-config-users.js";

const never = (_: string, __: string) => false;
const always = (_: string, __: string) => true;

function input(
  overrides: Partial<ProjectRestoreInput> = {},
): ProjectRestoreInput {
  return {
    userSlug: "alice",
    projectSlug: "mygame",
    giteaRepoName: "alice-proj-mygame",
    provisioningState: "active",
    ...overrides,
  };
}

describe("projectsNeedingClone", () => {
  it("selects an active project with a repo name that is not yet on disk", () => {
    const out = projectsNeedingClone([input()], never);
    expect(out).toHaveLength(1);
    expect(out[0].projectSlug).toBe("mygame");
  });

  it("skips projects already present on disk", () => {
    const out = projectsNeedingClone([input()], always);
    expect(out).toEqual([]);
  });

  it("skips projects with no giteaRepoName (nothing to clone)", () => {
    const out = projectsNeedingClone([input({ giteaRepoName: null })], never);
    expect(out).toEqual([]);
  });

  it("skips projects in provisioning state — retry endpoint owns those", () => {
    const out = projectsNeedingClone(
      [input({ provisioningState: "provisioning" })],
      never,
    );
    expect(out).toEqual([]);
  });

  it("skips projects in failed state — retry endpoint owns those too", () => {
    const out = projectsNeedingClone(
      [input({ provisioningState: "failed" })],
      never,
    );
    expect(out).toEqual([]);
  });

  it("treats missing provisioningState as active (legacy pre-§D4 docs)", () => {
    const out = projectsNeedingClone(
      [input({ provisioningState: undefined })],
      never,
    );
    expect(out).toHaveLength(1);
  });

  it("picks per-project based on the fs check — mixed result across one user", () => {
    const onDisk = new Set(["alice/mygame"]);
    const isCloned = (slug: string, proj: string) => onDisk.has(`${slug}/${proj}`);
    const out = projectsNeedingClone(
      [
        input({ projectSlug: "mygame" }),
        input({ projectSlug: "myapp" }),
        input({ projectSlug: "failedone", provisioningState: "failed" }),
        input({ projectSlug: "nopath", giteaRepoName: null }),
      ],
      isCloned,
    );
    expect(out.map((p) => p.projectSlug)).toEqual(["myapp"]);
  });
});
