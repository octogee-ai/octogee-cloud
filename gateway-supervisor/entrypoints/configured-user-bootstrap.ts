import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("configured-builder-bootstrap");
import { pathToFileURL } from "node:url";
import { userClaimSlug } from "@octogee/shared/server/user-claim";

import { hydrateConfiguredUserBootstrap } from "../lib/configured-user-bootstrap.js";

export const HOBBY_DESKTOP_HOME = "/home/octo";

export interface ConfiguredUserBootstrapInput {
  openclawDir: string;
  gatewayId: string;
  slug: string;
  desktopHome?: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function claimedSlug(env: NodeJS.ProcessEnv): string {
  const slug = userClaimSlug(env);
  if (!slug) throw new Error("a user claim is required for the configured user bootstrap");
  return slug;
}

export function resolveConfiguredUserBootstrapInput(
  env: NodeJS.ProcessEnv = process.env,
): ConfiguredUserBootstrapInput {
  const hobbyComputer = env.GATEWAY_RUNTIME_KIND === "cluster" && env.GATEWAY_COMPUTER_DESKTOP === "x11";
  return {
    openclawDir: required(env, "OPENCLAW_DIR"),
    gatewayId: required(env, "GATEWAY_ID"),
    slug: claimedSlug(env),
    ...(hobbyComputer ? { desktopHome: HOBBY_DESKTOP_HOME } : {}),
  };
}

export async function runConfiguredUserBootstrap(
  options: {
    env?: NodeJS.ProcessEnv;
    hydrate?: typeof hydrateConfiguredUserBootstrap;
  } = {},
): Promise<void> {
  await (options.hydrate ?? hydrateConfiguredUserBootstrap)(
    resolveConfiguredUserBootstrapInput(options.env),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runConfiguredUserBootstrap().catch((error) => {
    runtimeLogger.error(
      `[configured-builder-bootstrap] Fatal: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
