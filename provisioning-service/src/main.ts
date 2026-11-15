import { readFile } from "node:fs/promises";
import { PROVISIONING_SERVICE_AUDIENCE } from "@octogee/shared/types/provisioning-service";
import { createTokenReviewer } from "./auth/token-review.js";
import { CALLER_ROLES, loadConfig } from "./config.js";
import { FakeChatHost, FakeGitHost } from "./hosts/fake-hosts.js";
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
  if (config.hosts.kind === "real") throw new Error("PROVISIONING_HOST_ADAPTERS=real needs the chat and git host adapters, which this build does not include");
  const service = await startService({
    database: config.database,
    databaseSchema: config.databaseSchema,
    credentialKey: config.credentialKey,
    reviewer,
    callerNamespace: config.callerNamespace,
    roleTable: CALLER_ROLES,
    chat: new FakeChatHost(),
    git: new FakeGitHost(),
    log,
    replicaId: config.replicaId,
    port: config.port,
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
