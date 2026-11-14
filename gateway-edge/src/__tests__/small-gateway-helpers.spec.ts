import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  update: vi.fn(),
  collection: vi.fn((_name: string) => ({
    doc: vi.fn((_uid: string) => ({ update: m.update })),
  })),
  serverTimestamp: vi.fn(() => ({ __serverTimestamp: true })),
  info: vi.fn(),
}));

vi.mock("../middleware/logging.js", () => ({
  logger: {
    info: (...args: unknown[]) => m.info(...args),
  },
}));

import {
  WORKSPACE_REPO,
  SYSTEM_CONFIG_REPO,
  giteaUsername,
  projectRepoName,
  systemConfigRepoName,
  workspaceGiteaOrg,
  workspaceRepoName,
} from "@octogee/core/gitea-naming";

beforeEach(() => {
  m.update.mockReset().mockResolvedValue(undefined);
  m.collection.mockClear();
  m.serverTimestamp.mockClear();
  m.info.mockClear();
});

describe("small gateway helpers", () => {
  it("derives gitea org, repo, and service user names", () => {
    expect(WORKSPACE_REPO).toBe("workspace");
    expect(SYSTEM_CONFIG_REPO).toBe("system_config");
    expect(workspaceGiteaOrg("mira")).toBe("mira");
    expect(workspaceRepoName()).toBe("workspace");
    expect(systemConfigRepoName()).toBe("system_config");
    expect(projectRepoName("orbit")).toBe("orbit");
    expect(giteaUsername("mira")).toBe("ws-mira");
  });

});
