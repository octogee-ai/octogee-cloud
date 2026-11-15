import { describe, expect, it, vi } from "vitest";
import { agentExportGithub } from "./agent-export-github.js";
import type { AgentExportRecord } from "@octogee/core/http-candidates/agent-transfer/agent-export-service";
import { githubJson } from "@octogee/core/git-host/github";
vi.mock("@octogee/core/git-host/github", () => ({ githubRepoUrl: (owner: string, repo: string, suffix: string) => `https://api.github.com/repos/${owner}/${repo}${suffix}`, githubJson: vi.fn() }));
const old = "a".repeat(40), tree = "b".repeat(40), commit = "c".repeat(40), blob = "d".repeat(40);
describe("GitHub authored publication", () => {
  it("bases one commit on the previewed tree and head, preserves destination-only files, and updates without force", async () => {
    const calls = vi.mocked(githubJson); calls.mockReset();
    calls.mockImplementation(async (_method, url) => ({ sha: url.endsWith("/git/blobs") ? blob : url.endsWith("/git/trees") ? tree : commit }));
    const client = agentExportGithub(async () => "synthetic-token");
    const record = { id: "export-one", createdAt: "2026-10-23T00:00:00Z", destination: { owner: "alice", repo: "agent", branch: "main", head: old, tree }, expectedCommit: commit } as AgentExportRecord;
    await client.prepareCommit(record, { digest: "", assetIdentity: "", files: [{ path: "run.sh", content: "AAEC", sha256: "", size: 3, mode: "100755" as const }] });
    expect(calls.mock.calls[1].slice(0, 4)).toEqual(["POST", "https://api.github.com/repos/alice/agent/git/trees", "synthetic-token", { base_tree: tree, tree: [{ path: "run.sh", mode: "100755", type: "blob", sha: blob }] }]);
    expect(calls.mock.calls[2][3]).toMatchObject({ parents: [old], tree, author: { date: record.createdAt }, committer: { date: record.createdAt } });
    const assertCurrent = vi.fn(async () => {});
    await client.publish(record, assertCurrent);
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(calls.mock.calls[3].slice(0, 4)).toEqual(["PATCH", "https://api.github.com/repos/alice/agent/git/refs/heads/main", "synthetic-token", { sha: commit, force: false }]);
  });
  it.each(["read-only", "archived", "truncated"])("refuses an incomplete or unauthorized destination: %s", async scenario => {
    const calls = vi.mocked(githubJson); calls.mockReset();
    calls.mockImplementation(async (_method, url) => {
      if (url.endsWith("/agent")) return { permissions: { push: scenario !== "read-only" }, archived: scenario === "archived", default_branch: "main" };
      if (url.includes("/git/ref/")) return { object: { sha: old } };
      if (url.includes("/git/commits/")) return { tree: { sha: tree } };
      return { tree: [], truncated: true };
    });
    await expect(agentExportGithub(async () => "synthetic-token").destination({ owner: "alice", repo: "agent" })).rejects.toThrow();
    expect(calls.mock.calls.every(call => call[0] === "GET")).toBe(true);
  });
  it("rechecks custody after waiting for a token before sending the ref PATCH", async () => {
    const calls = vi.mocked(githubJson); calls.mockReset();
    let serving = true;
    const client = agentExportGithub(async () => { await Promise.resolve(); serving = false; return "synthetic"; });
    const assertCurrent = vi.fn(async () => { if (!serving) throw new Error("source custody changed"); });
    const record = { destination: { owner: "alice", repo: "agent", branch: "main" }, expectedCommit: commit } as AgentExportRecord;
    await expect(client.publish(record, assertCurrent)).rejects.toThrow("source custody changed");
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(calls).not.toHaveBeenCalled();
  });
  it("does not PATCH if the shared deadline expires during custody authorization", async () => {
    const calls = vi.mocked(githubJson); calls.mockReset();
    const controller = new AbortController();
    const client = agentExportGithub(async () => "synthetic", controller.signal);
    const record = { destination: { owner: "alice", repo: "agent", branch: "main" }, expectedCommit: commit } as AgentExportRecord;
    await expect(client.publish(record, async () => { controller.abort(); })).rejects.toThrow();
    expect(calls).not.toHaveBeenCalled();
  });
  it("bounds all sequential object calls with one shared deadline", async () => {
    vi.useFakeTimers();
    try {
      const calls = vi.mocked(githubJson); calls.mockReset();
      const controller = new AbortController();
      const client = agentExportGithub(async () => "synthetic", controller.signal);
      calls.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 60)); return { sha: blob }; });
      const record = { destination: { owner: "alice", repo: "agent", head: old, tree } } as AgentExportRecord;
      const file = { path: "one.md", mode: "100644" as const, content: "", sha256: "", size: 0 };
      const pending = client.prepareCommit(record, { files: [file, { ...file, path: "two.md" }], digest: "", assetIdentity: "" });
      const rejected = expect(pending).rejects.toMatchObject({ code: "export_unconfirmed" });
      setTimeout(() => controller.abort(), 90);
      await vi.advanceTimersByTimeAsync(150); await rejected;
      expect(calls).toHaveBeenCalledTimes(2);
      expect(calls.mock.calls.every(call => call[4] === controller.signal)).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("refuses more than 100 blobs before any GitHub call", async () => {
    const calls = vi.mocked(githubJson); calls.mockReset();
    const client = agentExportGithub(async () => "synthetic");
    const file = { path: "one.md", mode: "100644" as const, content: "", sha256: "", size: 0 };
    await expect(client.prepareCommit({} as AgentExportRecord, { files: Array.from({ length: 101 }, () => file), digest: "", assetIdentity: "" })).rejects.toThrow("100 files");
    expect(calls).not.toHaveBeenCalled();
  });

});
