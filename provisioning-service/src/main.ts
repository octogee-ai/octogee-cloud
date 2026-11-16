import { readFile } from "node:fs/promises";
import { PROVISIONING_SERVICE_AUDIENCE } from "@octogee/shared/types/provisioning-service";
import { createTokenReviewer } from "./auth/token-review.js";
import { loadConfig } from "./config.js";
import { hostsFromConfig } from "./hosts-from-config.js";
import { createLogger } from "./logger.js";
import { startService } from "./service.js";

const log = createLogger();

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const ca = config.tokenReviewCaFile ? await readFile(config.tokenReviewCaFile, "utf8") : undefined;
  const reviewer = createTokenReviewer({
    url: config.tokenReviewUrl,
    audience: PROVISIONING_SERVICE_AUDIENCE,
    reviewerToken: async () => (await readFile(config.tokenReviewTokenFile, "utf8")).trim(),
    ...(ca ? { ca } : {}),
  });
  const hosts = hostsFromConfig(config.hosts, log);
  if (config.hosts.kind === "fake") log.warn("provisioning service is using fake host adapters; for tests only");
  const service = await startService({
    database: config.database,
    databaseSchema: config.databaseSchema,
    credentialKey: config.credentialKey,
    reviewer,
    callerNamespace: config.callerNamespace,
    roleTable: config.callerRoles,
    chat: hosts.chat,
    git: hosts.git,
    log,
    replicaId: config.replicaId,
    port: config.port,
    limits: config.limits,
    changeRetentionMs: config.changeRetentionSeconds * 1_000,
  });
  log.info("provisioning service listening", { port: config.port, hostAdapters: config.hosts.kind, replica: config.replicaId });
  const shutdown = (signal: string) => {
    log.info("provisioning service stopping", { signal });
    service.stop().then(() => process.exit(0), (error: unknown) => {
      log.error("provisioning service stop failed", { error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  log.error("provisioning service failed to start", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
