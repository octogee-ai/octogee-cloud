import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("system-config-restore");
import { restoreSystemConfigForSlug } from "../lib/system-config.js";
import { pathToFileURL } from "node:url";
import { DEFAULT_OPENCLAW_DIR, userClaimSlug } from "@octogee/shared/server/user-claim";

const log = runtimeLogger.info;

export type SystemConfigRestorePlan =
  | { action: "restore"; gatewayClass: string; slug: string }
  | { action: "skip"; gatewayClass: string; reason: string };

export function resolveSystemConfigRestorePlan(
  env: NodeJS.ProcessEnv = process.env,
): SystemConfigRestorePlan {
  const gatewayClass = env.GATEWAY_CLASS ?? env.GATEWAY_PROFILE ?? "";
  if (gatewayClass === "shared" || gatewayClass === "standard" || gatewayClass === "") {
    return {
      action: "skip",
      gatewayClass,
      reason: `skipping restore for shared/standard gateway class (${gatewayClass || "unset"})`,
    };
  }

  const slug = userClaimSlug(env);
  if (!slug) {
    return {
      action: "skip",
      gatewayClass,
      reason: `skipping restore for ${gatewayClass}: this gateway has no user claim`,
    };
  }

  return { action: "restore", gatewayClass, slug };
}

export async function runSystemConfigRestore(
  opts: {
    env?: NodeJS.ProcessEnv;
    log?: (msg: string) => void;
    restore?: typeof restoreSystemConfigForSlug;
  } = {},
): Promise<SystemConfigRestorePlan> {
  const logger = opts.log ?? log;
  const plan = resolveSystemConfigRestorePlan(opts.env);
  if (plan.action === "skip") {
    logger(plan.reason);
    return plan;
  }

  const env = opts.env ?? process.env;
  const openclawDir = env.OPENCLAW_DIR?.trim() || DEFAULT_OPENCLAW_DIR;
  const result = await (opts.restore ?? restoreSystemConfigForSlug)(plan.slug, { log: logger, openclawDir });
  if (result.skipped) {
    throw new Error(`durable system_config restore failed: ${result.skipped}`);
  }
  if (!result.restored || !result.configPath) {
    throw new Error("durable system_config restore did not produce an active config path");
  }
  return plan;
}

async function main(): Promise<void> {
  await runSystemConfigRestore();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    runtimeLogger.error(`[system_config] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
