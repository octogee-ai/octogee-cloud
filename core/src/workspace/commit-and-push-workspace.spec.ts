import { describe, it, expect, vi } from "vitest";
import { commitAndPushWorkspace, type CommitAndPushDeps } from "./workspace-git.js";

const author = { name: "acme", email: "acme@octogee.local" };

type CommitFn = CommitAndPushDeps["gitCommit"];
type PushFn = CommitAndPushDeps["gitPush"];
type PrepareFn = CommitAndPushDeps["gitPreparePush"];

const commitOk = (empty: boolean): CommitFn => async () => ({
  ok: true,
  result: { sha: empty ? "" : "abc123", empty },
});
const commitFail: CommitFn = async () => ({
  ok: false,
  error: { code: "GIT_FAILED", cwd: "/d", status: 1, stderr: "boom" },
});
const pushOk: PushFn = async () => ({ ok: true });
const prepareMain: PrepareFn = async () => ({
  ok: true,
  target: { branch: "main", setUpstream: false },
});
const pushFail: PushFn = async () => ({
  ok: false,
  error: { code: "GIT_FAILED", cwd: "/d", status: 1, stderr: "rejected" },
});
const mutationDeps = (
  gitCommit: CommitFn,
  gitPush: PushFn,
  release = vi.fn(),
  gitPreparePush: PrepareFn = prepareMain,
): CommitAndPushDeps => ({
  gitCommit,
  gitPush,
  gitPreparePush,
  acquireMutationLease: () => ({ ownerToken: "lease", release }),
});

describe("commitAndPushWorkspace", () => {
  it("synchronizes and pushes a retained local commit even when there is nothing new to commit", async () => {
    const order: string[] = [];
    const prepare: PrepareFn = async () => {
      order.push("prepare");
      return { ok: true, target: { branch: "main", setUpstream: false } };
    };
    const push: PushFn = async () => {
      order.push("push");
      return { ok: true };
    };
    const r = await commitAndPushWorkspace(
      "/d",
      { message: "m", author },
      mutationDeps(commitOk(true), push, vi.fn(), prepare),
    );
    expect(r).toEqual({ ok: true, result: { committed: false, pushed: true, nothingToCommit: true } });
    expect(order).toEqual(["prepare", "push"]);
  });

  it("commits, rebases onto remote advancement, then pushes on success", async () => {
    const release = vi.fn();
    const order: string[] = [];
    const commit: CommitFn = async () => {
      order.push("commit");
      return { ok: true, result: { sha: "abc123", empty: false } };
    };
    const prepare: PrepareFn = async () => {
      order.push("prepare");
      return { ok: true, target: { branch: "main", setUpstream: false } };
    };
    const push: PushFn = async () => {
      order.push("push");
      return { ok: true };
    };
    const r = await commitAndPushWorkspace(
      "/d",
      { message: "m", author },
      mutationDeps(commit, push, release, prepare),
    );
    expect(r).toEqual({ ok: true, result: { committed: true, pushed: true, nothingToCommit: false } });
    expect(order).toEqual(["commit", "prepare", "push"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("pushes the prepared current branch and establishes its missing upstream", async () => {
    const push = vi.fn<PushFn>(async () => ({ ok: true }));
    const prepare: PrepareFn = async () => ({
      ok: true,
      target: { branch: "feature/agent-edit", setUpstream: true },
    });

    const result = await commitAndPushWorkspace(
      "/d",
      { message: "m", author },
      mutationDeps(commitOk(false), push, vi.fn(), prepare),
    );

    expect(result).toEqual({
      ok: true,
      result: { committed: true, pushed: true, nothingToCommit: false },
    });
    expect(push).toHaveBeenCalledWith("/d", {
      branch: "feature/agent-edit",
      setUpstream: true,
    });
  });

  it("passes an on-demand GitHub token through remote preparation and push only", async () => {
    const prepare = vi.fn<PrepareFn>(async () => ({
      ok: true,
      target: { branch: "main", setUpstream: false },
    }));
    const push = vi.fn<PushFn>(async () => ({ ok: true }));

    await commitAndPushWorkspace(
      "/d",
      { message: "m", author, githubToken: "gh-owner-token" },
      mutationDeps(commitOk(false), push, vi.fn(), prepare),
    );

    expect(prepare).toHaveBeenCalledWith("/d", {
      author,
      githubToken: "gh-owner-token",
    });
    expect(push).toHaveBeenCalledWith("/d", {
      branch: "main",
      setUpstream: false,
      githubToken: "gh-owner-token",
    });
  });

  it("returns committed-but-not-pushed (with pushError) when push fails — not fatal", async () => {
    const r = await commitAndPushWorkspace("/d", { message: "m", author }, mutationDeps(commitOk(false), pushFail));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result).toMatchObject({ committed: true, pushed: false, nothingToCommit: false });
      expect(r.result.pushError).toContain("git failed");
    }
  });

  it("preserves the local commit and reports a remote rebase conflict without pushing", async () => {
    const push = vi.fn(pushOk);
    const prepare: PrepareFn = async () => ({
      ok: false,
      error: { code: "GIT_FAILED", cwd: "/d", status: 1, stderr: "CONFLICT" },
    });

    const r = await commitAndPushWorkspace(
      "/d",
      { message: "m", author },
      mutationDeps(commitOk(false), push, vi.fn(), prepare),
    );

    expect(r).toEqual({
      ok: true,
      result: {
        committed: true,
        pushed: false,
        nothingToCommit: false,
        pushError: "git failed (status 1)",
      },
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("propagates a commit failure as a hard error (no push attempted)", async () => {
    let pushed = false;
    const push: PushFn = async () => {
      pushed = true;
      return { ok: true };
    };
    const r = await commitAndPushWorkspace("/d", { message: "m", author }, mutationDeps(commitFail, push));
    expect(r.ok).toBe(false);
    expect(pushed).toBe(false);
  });

  it("returns WORKSPACE_BUSY without invoking git when an import holds the shared lease", async () => {
    const commit = commitOk(false);
    const deps: CommitAndPushDeps = {
      gitCommit: vi.fn(commit),
      gitPreparePush: vi.fn(prepareMain),
      gitPush: vi.fn(pushOk),
      acquireMutationLease: () => null,
    };

    const result = await commitAndPushWorkspace("/d", { message: "m", author }, deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "WORKSPACE_BUSY", cwd: "/d" },
    });
    expect(deps.gitCommit).not.toHaveBeenCalled();
    expect(deps.gitPreparePush).not.toHaveBeenCalled();
    expect(deps.gitPush).not.toHaveBeenCalled();
  });
});
