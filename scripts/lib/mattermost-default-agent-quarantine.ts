import { CONFIG_PATCH_DEADLINE_MS } from "@octogee/shared/types/fleet-controller";
import {
  applyConfigPatch,
  userConfigReplacePaths,
  type ConfigCache,
} from "./apply-config-patch.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";
import { updateMattermostAccountSecrets } from "./mattermost-account-secrets.js";
import { OPENCLAW_DIR } from "./config.js";

export async function quarantineMalformedDefaultAgentMattermostAccount(
  slug: string,
  rpc: GatewayRpcClient,
  cache: ConfigCache,
  log: (message: string) => void,
): Promise<void> {
  const accountId = `${slug}-coach`;
  const projectAccountPrefix = `${slug}-proj-`;
  const accountPath = `channels.mattermost.accounts.${accountId}`;
  const projectAccountPathPrefix = `channels.mattermost.accounts.${projectAccountPrefix}`;
  await applyConfigPatch(
    {
      buildPatch: (current) => {
        const currentAccounts = (
          current as { channels?: { mattermost?: { accounts?: unknown } } }
        )?.channels?.mattermost?.accounts;
        const projectAccountIds = currentAccounts !== null &&
            typeof currentAccounts === "object" &&
            !Array.isArray(currentAccounts)
          ? Object.keys(currentAccounts).filter((id) => id.startsWith(projectAccountPrefix))
          : [];
        return {
          channels: {
            mattermost: {
              accounts: Object.fromEntries(
                [accountId, ...projectAccountIds].map((id) => [id, null]),
              ),
            },
          },
        };
      },
      buildReplacePaths: (current) => userConfigReplacePaths(current, slug)
        .filter((path) =>
          path === accountPath ||
          path.startsWith(`${accountPath}.`) ||
          path.startsWith(projectAccountPathPrefix)
        ),
      logPrefix: `[quarantine:${slug}]`,
    },
    {
      rpc,
      cache,
      totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS,
      log,
    },
  );
  await updateMattermostAccountSecrets(OPENCLAW_DIR, {
    remove: [accountId],
    removePrefixes: [projectAccountPrefix],
  });
  log(`[quarantine:${slug}] removed malformed user Mattermost accounts`);
}
