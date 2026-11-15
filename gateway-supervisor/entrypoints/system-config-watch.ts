import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("system-config-watch");
import path from "node:path";
import { pathToFileURL } from "node:url";

import { acquireSystemConfigSyncLeaseSync } from "@octogee/core/system-config-mutation-lease";

import { openClawConfigPath } from "../lib/openclaw-config-path.js";
import {
  auditSystemConfigForSlug,
  syncSystemConfigForSlug,
} from "../lib/system-config.js";
import { createSystemConfigWatcher } from "../lib/system-config-watcher.js";
import { isSystemConfigWatchDisabled } from "../lib/system-config-watch-state.js";
import {
  readSystemConfigStatus,
  updateSystemConfigStatus,
} from "../lib/system-config-status.js";
import { userClaimSlug } from "@octogee/shared/server/user-claim";

export type SystemConfigWatchPlan =
  | { action: "skip"; reason: "shared-gateway" }
  | { action: "watch"; slug: string; configPath: string };

export function resolveSystemConfigWatchPlan(
  env: NodeJS.ProcessEnv = process.env,
): SystemConfigWatchPlan {
  const gatewayClass = env.GATEWAY_CLASS ?? env.GATEWAY_PROFILE ?? "";
  if (gatewayClass === "shared" || gatewayClass === "standard" || gatewayClass === "") {
    return { action: "skip", reason: "shared-gateway" };
  }
  const slug = userClaimSlug(env);
  if (!slug) throw new Error("a user claim is required for durable config watch");
  const explicitPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (!explicitPath) throw new Error("OPENCLAW_CONFIG_PATH is required for durable config watch");
  const configPath = openClawConfigPath(env);
  if (!configPath.endsWith("/system_config/openclaw.json")) {
    throw new Error(`OPENCLAW_CONFIG_PATH is not the system_config checkout: ${configPath}`);
  }
  return { action: "watch", slug, configPath };
}

interface RunSystemConfigWatchOptions {
  env?: NodeJS.ProcessEnv;
  createWatcher?: typeof createSystemConfigWatcher;
  sync?: typeof syncSystemConfigForSlug;
  audit?: typeof auditSystemConfigForSlug;
  acquireSyncLease?: typeof acquireSystemConfigSyncLeaseSync;
  installSignalHandlers?: boolean;
}

export function runSystemConfigWatch(options: RunSystemConfigWatchOptions = {}): void {
  const env = options.env ?? process.env;
  const plan = resolveSystemConfigWatchPlan(env);
  if (plan.action === "skip") return;
  const openclawDir = path.dirname(path.dirname(plan.configPath));
  const watcher = (options.createWatcher ?? createSystemConfigWatcher)({
    configPath: plan.configPath,
    sync: async () => {
      if (isSystemConfigWatchDisabled(openclawDir, plan.slug)) {
        return { committed: false, pushed: true };
      }
      const lease = (options.acquireSyncLease ?? acquireSystemConfigSyncLeaseSync)({
        openclawDir,
      });
      if (!lease) {
        return {
          committed: false,
          pushed: false,
          pending: true,
          errorCode: "writer-lock-busy",
        };
      }
      try {
        if (isSystemConfigWatchDisabled(openclawDir, plan.slug)) {
          return { committed: false, pushed: true };
        }
        return (options.sync ?? syncSystemConfigForSlug)(plan.slug, {
          openclawDir,
          log: (message) => runtimeLogger.info(message),
          durablePolicy: true,
          env,
          source: "auto-watch",
          lockHeld: true,
        });
      } finally {
        lease.release();
      }
    },
    audit: async () => {
      if (isSystemConfigWatchDisabled(openclawDir, plan.slug)) {
        return { state: "clean", needsSync: false };
      }
      return (options.audit ?? auditSystemConfigForSlug)(plan.slug);
    },
    log: (message) => runtimeLogger.error(message),
    onStatusChange: (status) => {
      const current = readSystemConfigStatus(openclawDir);
      const at = new Date().toISOString();
      updateSystemConfigStatus(openclawDir, {
        state: status.state,
        watcherState: "running",
        dirtySince: status.state === "clean"
          ? null
          : current.dirtySince ?? at,
        ...(status.state === "error"
          ? { lastErrorCode: status.errorCode ?? "watcher-sync-failed", lastErrorAt: at }
          : {}),
      });
    },
  });
  if (options.installSignalHandlers === false) return;
  const close = () => {
    watcher.close();
    process.exit(0);
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runSystemConfigWatch({ env: process.env });
  } catch (error) {
    runtimeLogger.error(`[system_config] watcher fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
