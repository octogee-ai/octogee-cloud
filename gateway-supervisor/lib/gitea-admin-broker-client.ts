import type { GitRepoRole, ManagedGitHost } from "@octogee/core/git-host";

import { internalFetch } from "./internal-fetch.js";

export type BrokeredGitHost = Pick<
  ManagedGitHost,
  "registerKey" | "listKeys" | "releaseKey" | "ensureOwner" | "ensureRepo" | "repoExists" | "archiveRepo"
>;

function baseUrl(): string {
  if (process.env.GITEA_ADMIN_BROKER_URL) return process.env.GITEA_ADMIN_BROKER_URL;
  return process.env.GATEWAY_EDGE_INTERNAL_URL || "http://127.0.0.1:3001";
}

async function postVoid(path: string, body: unknown): Promise<void> {
  const resp = await internalFetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).slice(0, 300);
    throw new Error(`gitea-broker POST ${path} → ${resp.status} ${text}`);
  }
}

async function getJson(path: string): Promise<unknown> {
  const resp = await internalFetch(`${baseUrl()}${path}`, { method: "GET" });
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).slice(0, 300);
    throw new Error(`gitea-broker GET ${path} → ${resp.status} ${text}`);
  }
  return resp.json();
}

function ensureRepoRequest(slug: string, role: GitRepoRole): { path: string; body: Record<string, string> } {
  switch (role.kind) {
    case "workspace":
      return { path: "/internal/gitea/ensure-workspace-repo", body: { slug } };
    case "system-config":
      return { path: "/internal/gitea/ensure-system-config-repo", body: { slug } };
    case "project-coaches":
      return { path: "/internal/gitea/ensure-project-coach-repo", body: { slug } };
    case "project":
      return { path: "/internal/gitea/ensure-project-repo", body: { slug, projectName: role.projectSlug } };
  }
}

export const brokeredGitHost: BrokeredGitHost = {
  registerKey: (slug, pubKey) => postVoid("/internal/gitea/ensure-user", { slug, pubKey }),

  releaseKey: (slug, pubKey) => postVoid("/internal/gitea/release-user-key", { slug, pubKey }),

  async listKeys(slug) {
    const data = (await getJson(
      `/internal/gitea/user-pubkeys?slug=${encodeURIComponent(slug)}`,
    )) as { pubKeys: string[] };
    return data.pubKeys;
  },

  ensureOwner: (slug) => postVoid("/internal/gitea/ensure-org", { slug }),

  ensureRepo(slug, role) {
    const { path, body } = ensureRepoRequest(slug, role);
    return postVoid(path, body);
  },

  async repoExists({ owner, repo }) {
    const data = (await getJson(
      `/internal/gitea/repo-exists?org=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
    )) as { exists: boolean };
    return data.exists;
  },

  archiveRepo: ({ owner, repo }) => postVoid("/internal/gitea/archive-repo", { org: owner, repo }),
};
