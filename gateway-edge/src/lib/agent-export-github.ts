import { githubJson, githubRepoUrl } from "@octogee/core/git-host/github";
import { withinAgentExportDeadline, type AgentExportDestination, type AgentExportRecord } from "./agent-export-service.js";
import { MAX_AGENT_EXPORT_FILES, type AgentExportSnapshot } from "./agent-export-snapshot.js";
const sha = (value: unknown): string => { if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) { throw new Error("GitHub returned invalid object identity"); } return value; };
export function agentExportGithub(token: () => Promise<string>, deadline = AbortSignal.timeout(90_000)) {
  const request = async <T>(owner: string, repo: string, suffix: string, options: { method?: string; body?: unknown; beforeSend?: () => Promise<void> } = {}): Promise<T> => {
    if (!/^[A-Za-z0-9-]{1,39}$/u.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/u.test(repo) || [".", ".."].includes(repo)) throw new Error("invalid export repository");
    deadline.throwIfAborted();
    const credential = await withinAgentExportDeadline(token(), deadline);
    if (options.beforeSend) await withinAgentExportDeadline(options.beforeSend(), deadline);
    deadline.throwIfAborted();
    return await withinAgentExportDeadline(githubJson(options.method ?? "GET", githubRepoUrl(owner, repo, suffix), credential, options.body, deadline), deadline) as T;
  };
  return {
    async destination(input: { owner: string; repo: string }): Promise<AgentExportDestination> {
      const repo = await request<{ permissions?: { push?: boolean }; archived?: boolean; disabled?: boolean; default_branch?: string }>(input.owner, input.repo, "");
      if (repo.permissions?.push !== true || repo.archived === true || repo.disabled === true || typeof repo.default_branch !== "string") throw new Error("Choose an existing writable GitHub repository");
      const branch = repo.default_branch;
      let ref: { object?: { sha?: unknown } };
      try { ref = await request(input.owner, input.repo, `/git/ref/heads/${encodeURIComponent(branch)}`); }
      catch (error) {
        if (error instanceof Error && /GitHub API (404|409)\b/u.test(error.message)) throw new Error("Choose an existing repository with a commit on its default branch; empty repositories are not supported");
        throw error;
      }
      const head = sha(ref.object?.sha);
      const commit = await request<{ tree?: { sha?: unknown } }>(input.owner, input.repo, `/git/commits/${head}`);
      const tree = sha(commit.tree?.sha);
      const listing = await request<{ tree?: AgentExportDestination["files"]; truncated?: boolean }>(input.owner, input.repo, `/git/trees/${tree}?recursive=1`);
      if (listing.truncated || !Array.isArray(listing.tree)) throw new Error("repository is too large for a complete conflict preview");
      return { ...input, branch, head, tree, files: listing.tree };
    },
    async readHead(record: AgentExportRecord): Promise<string> {
      const { owner, repo, branch } = record.destination;
      const metadata = await request<{ permissions?: { push?: boolean }; default_branch?: string; archived?: boolean; disabled?: boolean }>(owner, repo, "");
      if (metadata.permissions?.push !== true || metadata.default_branch !== branch || metadata.archived || metadata.disabled) throw new Error("export repository permission or default branch changed");
      return sha((await request<{ object?: { sha?: unknown } }>(owner, repo, `/git/ref/heads/${encodeURIComponent(branch)}`)).object?.sha);
    },
    async prepareCommit(record: AgentExportRecord, snapshot: AgentExportSnapshot): Promise<string> {
      if (snapshot.files.length > MAX_AGENT_EXPORT_FILES) throw new Error(`Authored export supports at most ${MAX_AGENT_EXPORT_FILES} files`);
      const { owner, repo } = record.destination;
      const tree = [];
      for (const file of snapshot.files) {
        const blob = await request<{ sha?: unknown }>(owner, repo, "/git/blobs", { method: "POST", body: { content: file.content, encoding: "base64" } });
        tree.push({ path: file.path, mode: file.mode, type: "blob", sha: sha(blob.sha) });
      }
      const created = await request<{ sha?: unknown }>(owner, repo, "/git/trees", { method: "POST", body: { base_tree: record.destination.tree, tree } });
      const author = { name: "Octogee", email: "exports@octogee.com", date: record.createdAt };
      const commit = await request<{ sha?: unknown }>(owner, repo, "/git/commits", { method: "POST", body: { message: `Export authored agent workspace (${record.id})`, tree: sha(created.sha), parents: [record.destination.head], author, committer: author } });
      return sha(commit.sha);
    },
    async publish(record: AgentExportRecord, assertCurrent: () => Promise<void>): Promise<void> {
      const { owner, repo, branch } = record.destination;
      await request(owner, repo, `/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: { sha: sha(record.expectedCommit), force: false }, beforeSend: assertCurrent });
    },
  };
}
