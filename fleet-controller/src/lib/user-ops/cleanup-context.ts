import type { UserAccountReader } from "@octogee/core/user-account";
import { SYSTEM_CONFIG_REPO, WORKSPACE_REPO } from "@octogee/core/gitea-naming";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { UserCleanupContext } from "../../handlers/deprovision-user.js";
import type { ProductUserLifecycle } from "./user-lifecycle-product.js";
import {
  MODEL_CREDENTIAL_STATIC_PROVIDER_IDS,
  byosubSecretNameForUser,
  MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS,
} from "@octogee/shared/types/model-credentials";

export interface ContextDeps {
  store: PlatformStateStore;
  accounts: UserAccountReader;
  product: Pick<ProductUserLifecycle, "cleanup"> | null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function normalizedEmail(v: unknown): string | null {
  const email = asString(v)?.trim().toLowerCase() ?? "";
  return email.length > 0 ? email : null;
}

async function resolveWorkspaceTeamId(store: PlatformStateStore, slug: string): Promise<string | null> {
  if (!slug) return null;
  return asString((await store.workspaces.records.get(slug))?.mattermostTeamId);
}

async function resolveDefaultAgentMmUserId(store: PlatformStateStore, uid: string): Promise<string | null> {
  return asString((await store.workspaces.agentIdentities.get(uid))?.mattermostUserId);
}

async function resolveAdminChannelId(store: PlatformStateStore, slug: string): Promise<string | null> {
  if (!slug) return null;
  const channel = await store.workspaces.channels.get({ workspaceSlug: slug, projectSlug: null }, "admin");
  return asString(channel?.mattermostChannelId);
}

async function resolveProjects(
  store: PlatformStateStore,
  slug: string,
): Promise<{ repoNames: string[]; projectSlugs: string[] }> {
  if (!slug) return { repoNames: [], projectSlugs: [] };
  const projects = await store.workspaces.projects.list(slug);
  return {
    repoNames: [
      WORKSPACE_REPO,
      SYSTEM_CONFIG_REPO,
      ...projects.map((project) => asString(project.giteaRepoName) ?? project.projectSlug),
    ],
    projectSlugs: projects.map((project) => project.projectSlug).sort(),
  };
}

function platformCredentialSecretNames(uid: string, slug: string): string[] {
  return [
    ...(slug ? MODEL_CREDENTIAL_STATIC_PROVIDER_IDS.map(
      (provider) => `byok-${slug}-${provider}`,
    ) : []),
    ...MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS.map((provider) => {
      const secretName = byosubSecretNameForUser(uid, provider);
      if (!secretName) throw new Error(`credential cleanup context invalid uid: ${uid}`);
      return secretName;
    }),
  ];
}

async function resolveProjectAgentCleanup(
  store: PlatformStateStore,
  uid: string,
): Promise<{
  projectAgentMmUserIds: string[];
  projectAgentCredentialDocPaths: string[];
}> {
  const secrets = await store.secrets.list(uid, "project-agent-mattermost");
  return {
    projectAgentMmUserIds: secrets
      .map((secret) => secret.kind === "connector" ? null : asString(secret.mattermostUserId))
      .filter((value): value is string => value !== null)
      .sort(),
    projectAgentCredentialDocPaths: secrets
      .map((secret) => `users/${uid}/secrets/${secret.secretId}`)
      .sort(),
  };
}

async function resolveAgentImportIds(store: ContextDeps["store"], uid: string): Promise<string[]> {
  const imports = await store.jobs.agentImports.listForUid(uid);
  return imports.map(({ importId }) => {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(importId)) {
      throw new Error(`agent import cleanup context invalid: ${importId}`);
    }
    return importId;
  }).sort();
}

export async function loadUserCleanupContext(
  deps: ContextDeps,
  uid: string,
): Promise<UserCleanupContext | null> {
  const user = await deps.store.users.records.get(uid);
  if (user === null) return null;
  const slug = user.slug ?? "";

  const [
    account,
    workspaceTeamId,
    mmCoachUserId,
    adminChannelId,
    projects,
    productCleanup,
    projectAgentCleanup,
    agentImportIds,
  ] =
    await Promise.all([
      deps.accounts.get(uid),
      resolveWorkspaceTeamId(deps.store, slug),
      resolveDefaultAgentMmUserId(deps.store, uid),
      resolveAdminChannelId(deps.store, slug),
      resolveProjects(deps.store, slug),
      deps.product?.cleanup(uid, slug) ?? { credentialSecretNames: [], chatArtifactIds: [] },
      resolveProjectAgentCleanup(deps.store, uid),
      resolveAgentImportIds(deps.store, uid),
    ]);

  return {
    uid,
    slug,
    email: normalizedEmail(account?.email),
    giteaOrg: slug,
    ...projects,
    workspaceTeamId,
    mmUserId: asString(user.mattermostUserId),
    mmCoachUserId,
    adminChannelId,
    currentGatewayId: user.gateway?.gatewayId ?? null,
    credentialSecretNames: Array.from(new Set([
      ...platformCredentialSecretNames(uid, slug),
      ...productCleanup.credentialSecretNames,
    ])).sort(),
    ...projectAgentCleanup,
    chatArtifactIds: Array.from(new Set(productCleanup.chatArtifactIds)).sort(),
    agentImportIds,
  };
}
