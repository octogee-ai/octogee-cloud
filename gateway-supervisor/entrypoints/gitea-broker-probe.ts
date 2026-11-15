import { pathToFileURL } from "node:url";

import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";
import { brokeredGitHost } from "../lib/gitea-admin-broker-client.js";

interface GiteaBrokerProbeDependencies {
  createClient?: (gatewayId: string) => {
    assignedUsers: () => Promise<Array<{ slug: string }>>;
  };
  repoExists?: (org: string, repo: string) => Promise<boolean>;
}

export interface GiteaBrokerProbeResult {
  slug: string;
  workspaceRepoExists: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function probeGiteaAdminBroker(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: GiteaBrokerProbeDependencies = {},
): Promise<GiteaBrokerProbeResult> {
  if (env.GIT_API_TOKEN?.trim()) {
    throw new Error("legacy GIT_API_TOKEN must not be present in the gateway container");
  }
  required(env, "GITEA_ADMIN_BROKER_URL");
  const gatewayId = required(env, "GATEWAY_ID");
  const client = (dependencies.createClient ?? createFleetBrokerClient)(gatewayId);
  const users = await client.assignedUsers();
  const slug = users.find((user) => user.slug.trim().length > 0)?.slug;
  if (!slug) throw new Error(`gateway ${gatewayId} has no assigned tenant for the Gitea broker probe`);
  const repoExists = dependencies.repoExists ??
    ((owner: string, repo: string) => brokeredGitHost.repoExists({ owner, repo }));
  const workspaceRepoExists = await repoExists(slug, "workspace");
  return { slug, workspaceRepoExists };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  probeGiteaAdminBroker()
    .then(({ slug, workspaceRepoExists }) => {
      console.log(`Gitea broker read succeeded for ${slug}; workspace repo ${workspaceRepoExists ? "present" : "absent"}`);
    })
    .catch((error) => {
      console.error(`[gitea-broker-probe] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
