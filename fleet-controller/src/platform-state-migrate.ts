import { migratePlatformStateFromEnvironment } from "@octogee/core/platform-state";
import { createLogger } from "./lib/logger.js";

const logger = createLogger();

try {
  const result = await migratePlatformStateFromEnvironment({ applicationName: "platform-state-migrate", logger });
  logger.info("platform state schema is current", { version: result.version, applied: result.applied });
} catch (error) {
  logger.error("platform state migration failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
