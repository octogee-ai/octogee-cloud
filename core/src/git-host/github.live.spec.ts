import { describe, expect, it } from "vitest";
import { githubContentsApi, githubListRepos } from "./github.js";

const RUN_LIVE = process.env.RUN_LIVE === "1";

// Real GitHub, no mocks — octocat/Hello-World is a stable public repo (anonymous
// works; GITHUB_TOKEN used if present for rate limits). Pins the contents shape
// files.ts relies on against the live provider.
describe.skipIf(!RUN_LIVE)("githubContentsApi — live against real GitHub", () => {
  it("lists a directory as an array and fetches a file in Gitea-compatible shape", async () => {
    const root = await githubContentsApi("octocat", "Hello-World", "", process.env.GITHUB_TOKEN);
    expect(Array.isArray(root)).toBe(true);

    const entries = root as Array<{ name: string; path: string; type: string }>;
    expect(entries.length).toBeGreaterThan(0);

    const firstFile = entries.find((e) => e.type === "file");
    expect(firstFile).toBeTruthy();

    const file = (await githubContentsApi(
      "octocat",
      "Hello-World",
      firstFile!.path,
      process.env.GITHUB_TOKEN,
    )) as { content?: string; sha?: string };

    expect(typeof file.sha).toBe("string");
    const decoded = Buffer.from(file.content ?? "", "base64").toString("utf-8");
    expect(decoded.length).toBeGreaterThan(0);
  }, 20_000);

  it("throws a 404-bearing error for a missing path (so files.ts maps it to empty)", async () => {
    await expect(
      githubContentsApi("octocat", "Hello-World", "no-such-file.xyz", process.env.GITHUB_TOKEN),
    ).rejects.toThrow(/404/);
  }, 20_000);
});

// Needs a real token (lists the token owner's repos), so gated on GITHUB_TOKEN too.
describe.skipIf(!RUN_LIVE || !process.env.GITHUB_TOKEN)("githubListRepos — live", () => {
  it("returns the token's repos as picker summaries", async () => {
    const { repos } = await githubListRepos(process.env.GITHUB_TOKEN!);
    expect(Array.isArray(repos)).toBe(true);
    for (const r of repos.slice(0, 3)) {
      expect(typeof r.owner).toBe("string");
      expect(typeof r.repo).toBe("string");
      expect(r.fullName).toContain("/");
    }
  }, 20_000);
});
