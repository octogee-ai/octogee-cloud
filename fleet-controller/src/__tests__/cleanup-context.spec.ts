

import { describe, it, expect } from "vitest";
import { userAccountFromData, type UserAccountReader } from "@octogee/core/user-account";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { loadUserCleanupContext, type ContextDeps } from "../lib/user-ops/cleanup-context";

function agentImportDoc(uid: string, importId: string): Record<string, unknown> {
  return { uid, importId, status: "complete", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

function contextDeps(
  initialDocs: Record<string, Record<string, unknown> | undefined>,
  product: ContextDeps["product"] = null,
): ContextDeps {
  const account = (uid: string) => {
    const data = initialDocs[`users/${uid}`];
    return data === undefined ? null : userAccountFromData(uid, data);
  };
  const accounts: UserAccountReader = {
    get: async (uid) => account(uid),
    getMany: async () => { throw new Error("cleanup context reads one account"); },
    list: async () => { throw new Error("cleanup context reads one account"); },
  };
  return {
    store: createDocumentFixtureStore(initialDocs),
    accounts,
    product,
  };
}

describe("loadUserCleanupContext", () => {
  it("returns null when the user doc does not exist", async () => {
    const deps = contextDeps({});
    const ctx = await loadUserCleanupContext(
      deps,
      "uid-missing",
    );
    expect(ctx).toBeNull();
  });

  it("resolves slug from provisioning.openclaw.slug (canonical)", async () => {
    const deps = contextDeps({
      "users/uid-alice": {
        email: "alice@example.com",
        provisioning: { openclaw: { slug: "alice-canon", gatewayId: "gw-test" } },
      },
    });
    const ctx = await loadUserCleanupContext(
      deps,
      "uid-alice",
    );
    expect(ctx?.slug).toBe("alice-canon");
    expect(ctx?.currentGatewayId).toBe("gw-test");
    expect(ctx?.email).toBe("alice@example.com");
  });

  it("normalizes the captured email used to erase email-indexed PII", async () => {
    const deps = contextDeps({
      "users/uid-alice": { username: "alice", email: " Alice@Example.COM " },
    });
    const ctx = await loadUserCleanupContext(
      deps,
      "uid-alice",
    );
    expect(ctx?.email).toBe("alice@example.com");
  });

  it("falls back to username when openclaw.slug is missing", async () => {
    const deps = contextDeps({
      "users/uid-bob": { username: "bob-legacy" },
    });
    const ctx = await loadUserCleanupContext(
      deps,
      "uid-bob",
    );
    expect(ctx?.slug).toBe("bob-legacy");
    expect(ctx?.currentGatewayId).toBeNull();
  });

  it("returns empty repoNames + null IDs when no slug at all", async () => {
    const deps = contextDeps({
      "users/uid-bare": { email: "bare@example.com" },
    });
    const ctx = await loadUserCleanupContext(
      deps,
      "uid-bare",
    );
    expect(ctx?.slug).toBe("");
    expect(ctx?.repoNames).toEqual([]);
    expect(ctx?.workspaceTeamId).toBeNull();
    expect(ctx?.adminChannelId).toBeNull();
  });

  it("derives bare project repo names (org-namespaced) from the project slug when giteaRepoName absent", async () => {
    const deps = contextDeps({
      "users/uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice" } },
      },
      "workspaces/alice/projects/blog": { slug: "blog", ownerUid: "uid-alice" },
      "workspaces/alice/projects/shop": { projectSlug: "shop", ownerUid: "uid-alice" },
    });
    const ctx = await loadUserCleanupContext(
      deps,
      "uid-alice",
    );
    expect(ctx?.repoNames).toEqual(["workspace", "system_config", "blog", "shop"]);
  });

  it("prefers projData.giteaRepoName when present (the actual Gitea name)", async () => {
    const deps = contextDeps({
      "users/uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice" } },
      },
      "workspaces/alice/projects/p1": {
        slug: "ignored-derivation",
        giteaRepoName: "alice-proj-canonical-name",
        ownerUid: "uid-alice",
      },
    });
    const ctx = await loadUserCleanupContext(
      deps,
      "uid-alice",
    );
    expect(ctx?.repoNames).toContain("alice-proj-canonical-name");
    expect(ctx?.repoNames).not.toContain("alice-proj-ignored-derivation");
  });

  it("falls back to project doc id when neither slug nor projectSlug nor giteaRepoName is set", async () => {
    const deps = contextDeps({
      "users/uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice" } },
      },
      "workspaces/alice/projects/legacy-doc-id": { ownerUid: "uid-alice" },
    });
    const ctx = await loadUserCleanupContext(
      deps,
      "uid-alice",
    );
    expect(ctx?.repoNames).toEqual(["workspace", "system_config", "legacy-doc-id"]);
  });

  it("surfaces projectSlugs[] directly from project docs (PR #3 — drives Firebase Hosting deletes)", async () => {

const deps = contextDeps({
      "users/uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice" } },
      },
      "workspaces/alice/projects/blog": { slug: "blog", ownerUid: "uid-alice" },
      "workspaces/alice/projects/shop": { projectSlug: "shop", ownerUid: "uid-alice" },
      "workspaces/alice/projects/legacy-id": { ownerUid: "uid-alice" },
    });
    const ctx = await loadUserCleanupContext(
      deps,
      "uid-alice",
    );
    
    expect(ctx?.projectSlugs).toEqual(["blog", "legacy-id", "shop"]);
  });

  it("names projects by their document id rather than a diverging legacy slug field", async () => {
    const deps = contextDeps({
      "users/uid-alice": { username: "alice", provisioning: { openclaw: { slug: "alice" } } },
      "workspaces/alice/projects/blog": { slug: "legacy-blog", projectSlug: "legacy-blog", ownerUid: "uid-alice" },
    });
    const ctx = await loadUserCleanupContext(deps, "uid-alice");
    expect(ctx?.projectSlugs).toEqual(["blog"]);
    expect(ctx?.repoNames).toEqual(["workspace", "system_config", "blog"]);
  });

  it("fails context capture when a workspace project record has no owner", async () => {
    const deps = contextDeps({
      "users/uid-alice": { username: "alice", provisioning: { openclaw: { slug: "alice" } } },
      "workspaces/alice/projects/blog": { slug: "blog" },
    });
    await expect(loadUserCleanupContext(deps, "uid-alice")).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("returns projectSlugs: [] when the user has no projects", async () => {
    const deps = contextDeps({
      "users/uid-bob": { username: "bob", provisioning: { openclaw: { slug: "bob" } } },
    });
    const ctx = await loadUserCleanupContext(
      deps,
      "uid-bob",
    );
    expect(ctx?.projectSlugs).toEqual([]);
  });

  it("returns projectSlugs: [] when the user has no slug (no workspace path to scan)", async () => {
    const deps = contextDeps({
      "users/uid-bare": { email: "bare@example.com" },
    });
    const ctx = await loadUserCleanupContext(
      deps,
      "uid-bare",
    );
    expect(ctx?.projectSlugs).toEqual([]);
  });

  it("resolves Mattermost IDs from user, workspace, agents, and admin channel docs", async () => {
    const deps = contextDeps({
      "users/uid-alice": {
        username: "alice",
        email: "alice@example.com",
        provisioning: { openclaw: { slug: "alice", gatewayId: "gw-test" } },
        mattermost: { userId: "mm-u-1" },
      },
      "workspaces/alice": { id: "alice", ownerUid: "uid-alice", mattermost: { teamId: "team-1" } },
      "agents/uid-alice": { mattermost: { userId: "mm-coach-1" } },
      "workspaces/alice/channels/admin": { mattermost: { channelId: "mm-c-admin" } },
    });
    const ctx = await loadUserCleanupContext(
      deps,
      "uid-alice",
    );
    expect(ctx).toMatchObject({
      uid: "uid-alice",
      slug: "alice",
      mmUserId: "mm-u-1",
      mmCoachUserId: "mm-coach-1",
      workspaceTeamId: "team-1",
      adminChannelId: "mm-c-admin",
      currentGatewayId: "gw-test",
      giteaOrg: "alice",
    });
  });

  it("captures the platform's model credential secret names without a product", async () => {
    const deps = contextDeps({ "users/uid-alice": { username: "alice" } });

    const ctx = await loadUserCleanupContext(
      deps,
      "uid-alice",
    );

    expect(ctx?.credentialSecretNames).toEqual([
      "byok-alice-anthropic",
      "byok-alice-grok",
      "byok-alice-minimax",
      "byok-alice-openai",
      "byok-alice-openai-compatible",
      "byok-alice-openrouter",
      "byosub-uid-alice-anthropic",
      "byosub-uid-alice-openai",
    ]);
  });

  it("captures every project-agent Mattermost user and credential document before suspension", async () => {
    const deps = contextDeps({
      "users/uid-alice": { username: "alice" },
      "users/uid-alice/secrets/projectAgentMattermost-orbit": {
        mmUserId: "mm-project-orbit",
        personalToken: "secret-orbit",
      },
      "users/uid-alice/secrets/projectAgentMattermost-labs": {
        mmUserId: "mm-project-labs",
        personalToken: "secret-labs",
      },
      "users/uid-alice/secrets/coachMattermost": {
        coachMmUserId: "mm-coach",
      },
    });
    const ctx = await loadUserCleanupContext(
      deps,
      "uid-alice",
    );
    expect(ctx?.projectAgentMmUserIds).toEqual(["mm-project-labs", "mm-project-orbit"]);
    expect(ctx?.projectAgentCredentialDocPaths).toEqual([
      "users/uid-alice/secrets/projectAgentMattermost-labs",
      "users/uid-alice/secrets/projectAgentMattermost-orbit",
    ]);
  });

  it("adds the product's credential secrets and chat artifacts to the platform context", async () => {
    const cleanup = async (uid: string, slug: string) => ({
      credentialSecretNames: [`product-${uid}`, `byok-${slug}-openai`],
      chatArtifactIds: ["b".repeat(64), "a".repeat(64), "b".repeat(64)],
    });
    const deps = contextDeps({ "users/uid-alice": { username: "alice" } }, { cleanup });

    const ctx = await loadUserCleanupContext(deps, "uid-alice");

    expect(ctx?.credentialSecretNames).toEqual([
      "byok-alice-anthropic",
      "byok-alice-grok",
      "byok-alice-minimax",
      "byok-alice-openai",
      "byok-alice-openai-compatible",
      "byok-alice-openrouter",
      "byosub-uid-alice-anthropic",
      "byosub-uid-alice-openai",
      "product-uid-alice",
    ]);
    expect(ctx?.chatArtifactIds).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  it("captures no chat artifacts without a product", async () => {
    const ctx = await loadUserCleanupContext(contextDeps({ "users/uid-alice": { username: "alice" } }), "uid-alice");

    expect(ctx?.chatArtifactIds).toEqual([]);
  });

  it("captures every agent import staging prefix owned by the user", async () => {
    const deps = contextDeps({
      "users/uid-alice": { username: "alice" },
      "users/uid-alice/agentImports/import-owned": agentImportDoc("uid-alice", "import-owned"),
      "users/uid-other/agentImports/import-other": agentImportDoc("uid-other", "import-other"),
    });

    const ctx = await loadUserCleanupContext(
      deps,
      "uid-alice",
    );

    expect(ctx?.agentImportIds).toEqual(["import-owned"]);
  });

  it("fails context capture when the product cannot read its cleanup context", async () => {
    const cleanup = async () => { throw new Error("credential cleanup context invalid: malformed provider leaf"); };
    const deps = contextDeps({ "users/uid-alice": { username: "alice" } }, { cleanup });

    await expect(loadUserCleanupContext(deps, "uid-alice")).rejects.toThrow(/malformed provider leaf/);
  });
});
