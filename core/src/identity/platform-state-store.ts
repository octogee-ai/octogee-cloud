import { lazyInstance } from "../lazy-instance.js";
import { platformStateStoreFromEnvironment } from "../platform-state/index.js";
import { logger } from "../http/logging.js";

export const platformStateStore = lazyInstance(() => platformStateStoreFromEnvironment({
  applicationName: "octogee-api",
  logger: {
    warn: (message, detail) => logger.warn(message, detail),
    error: (message, detail) => logger.error(message, detail),
  },
}));
