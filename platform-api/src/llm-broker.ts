import { lazyInstance } from "@octogee/core/lazy-instance";
import { createPostgresModelBrokerUsageLedger } from "@octogee/core/model-broker-usage-ledger";
import {
  createPlatformStatePool,
  platformDatabaseSettingsFromEnvironment,
  platformStateStoreFromEnvironment,
} from "@octogee/core/platform-state";
import { platformStateUserAccountReader } from "@octogee/core/platform-state-user-accounts";
import { readSecret } from "@octogee/core/secret-store";
import { createServiceLogger } from "@octogee/shared/server/service-logger";

import { createLedgerModelBrokerUsageStore } from "./lib/model-broker-usage.js";
import { createPlatformLlmBrokerApp } from "./platform-llm-broker.js";

const logger = createServiceLogger("llm-broker");
const databaseLogger = {
  warn: (message: string, detail: Readonly<Record<string, unknown>>) => logger.warn(message, { ...detail }),
  error: (message: string, detail: Readonly<Record<string, unknown>>) => logger.error(message, { ...detail }),
};

const state = lazyInstance(() =>
  platformStateStoreFromEnvironment({ applicationName: "llm-broker", logger: databaseLogger }));
const usagePool = createPlatformStatePool(platformDatabaseSettingsFromEnvironment(process.env), {
  applicationName: "llm-broker-usage",
  logger: databaseLogger,
});

const app = createPlatformLlmBrokerApp({
  env: process.env,
  state,
  accounts: platformStateUserAccountReader(state),
  usageStore: createLedgerModelBrokerUsageStore(createPostgresModelBrokerUsageLedger(usagePool)),
  readSecret: (name) => readSecret(name),
  logger,
});

const port = Number.parseInt(process.env.PORT || "3010", 10);
app.listen(port, () => {
  logger.info("llm-broker listening", {
    port,
    rails: ["operator"],
    sha: process.env.BUILD_SHA || "unknown",
    node: process.version,
  });
});
