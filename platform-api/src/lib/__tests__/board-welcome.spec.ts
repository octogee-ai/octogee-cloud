import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  createIssue: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../issues.js", () => ({
  createIssue: (...args: unknown[]) => h.createIssue(...args),
}));

vi.mock("@octogee/core/http/logging", () => ({
  logger: { warn: (...args: unknown[]) => h.warn(...args), info: vi.fn(), error: vi.fn() },
}));

const { seedBoardWelcomeIssue, BOARD_WELCOME_TITLE, boardWelcomeBody } = await import("../board-welcome.js");

beforeEach(() => {
  h.createIssue.mockReset().mockResolvedValue({ number: 1 });
  h.warn.mockReset();
});

describe("seedBoardWelcomeIssue", () => {
  it("creates the welcome card in the todo column as the workspace owner", async () => {
    await seedBoardWelcomeIssue({ workspaceId: "alice", slug: "rocket", name: "Rocket" });

    expect(h.createIssue).toHaveBeenCalledTimes(1);
    const [target, input] = h.createIssue.mock.calls[0] as [
      { provider: string; org: string; repoName: string; sudoUser: string; projectSlug: string },
      { title: string; body: string; status: string },
    ];
    expect(target.provider).toBe("gitea");
    expect(target.org).toBe("alice");
    expect(target.repoName).toBe("rocket");
    expect(target.sudoUser).toBe("ws-alice");
    expect(target.projectSlug).toBe("rocket");
    expect(input.title).toBe(BOARD_WELCOME_TITLE);
    expect(input.status).toBe("todo");
    expect(input.body).toContain("Rocket");
  });

  it("logs and swallows provider failures so provisioning never fails on the nicety", async () => {
    h.createIssue.mockRejectedValueOnce(new Error("gitea down"));

    await expect(
      seedBoardWelcomeIssue({ workspaceId: "alice", slug: "rocket", name: "Rocket" }),
    ).resolves.toBeUndefined();

    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(String(h.warn.mock.calls[0][0])).toContain("gitea down");
  });
});

describe("boardWelcomeBody", () => {
  it("teaches the columns, the bug label, and the agent in the project's name", () => {
    const body = boardWelcomeBody("Quote Reel");
    expect(body).toContain("Quote Reel");
    expect(body).toContain("Backlog → To do → Doing → Review → Done");
    expect(body).toContain("bug");
    expect(body).toContain("Agent");
  });
});
