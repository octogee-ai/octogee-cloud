import {
  extractOpenClawActivationManifest,
  type MigrationActivationManifest,
} from "./migration-activation-manifest.js";
import {
  mattermostAccountSecretRef,
  readMattermostAccountSecret,
  updateMattermostAccountSecrets,
} from "./mattermost-account-secrets.js";
import * as path from "node:path";
import { loadAppliedFingerprints } from "./applied-fingerprint-store.js";

export async function exportActivationManifestWithSecret(
  configPath: string,
  openclawDir: string,
  slug: string,
): Promise<MigrationActivationManifest> {
  const appliedFingerprint = loadAppliedFingerprints(
    path.join(openclawDir, "applied-fingerprints.json"),
  ).get(slug);
  if (!appliedFingerprint) {
    throw new Error(
      `[migration-activation:${slug}] source has no applied fingerprint; converge it before migration`,
    );
  }
  return extractOpenClawActivationManifest(configPath, slug, {
    appliedFingerprint,
    resolveBotToken: async (accountId) =>
      (await readMattermostAccountSecret(openclawDir, accountId)) ?? undefined,
  });
}

export async function materializeActivationManifestSecret(
  openclawDir: string,
  manifest: MigrationActivationManifest,
): Promise<{ manifest: MigrationActivationManifest; secretsChanged: boolean }> {
  const projectAgents = manifest.projectAgents ?? [];
  const accounts = [
    {
      accountId: manifest.accountId,
      mattermostAccount: manifest.mattermostAccount,
    },
    ...projectAgents,
  ];
  const tokens: Record<string, string> = {};
  for (const account of accounts) {
    const token = account.mattermostAccount.botToken;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(
        `[migration-activation:${manifest.slug}] transferred Mattermost token is missing for ${account.accountId}`,
      );
    }
    tokens[account.accountId] = token;
  }
  const { changed } = await updateMattermostAccountSecrets(openclawDir, {
    set: tokens,
    removePrefixes: [`${manifest.slug}-proj-`],
  });
  return {
    secretsChanged: changed,
    manifest: {
      ...manifest,
      mattermostAccount: {
        ...manifest.mattermostAccount,
        botToken: mattermostAccountSecretRef(manifest.accountId),
      },
      projectAgents: projectAgents.map((project) => ({
        ...project,
        mattermostAccount: {
          ...project.mattermostAccount,
          botToken: mattermostAccountSecretRef(project.accountId),
        },
      })),
    },
  };
}
