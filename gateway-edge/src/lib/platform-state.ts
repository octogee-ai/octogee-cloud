import { firestoreSizingKeyReader } from "@octogee/core/sizing-key";
import { lazyInstance } from "@octogee/core/lazy-instance";
import { platformStateStoreFromEnvironment } from "@octogee/core/platform-state";
import { logger } from "../middleware/logging.js";
import { db } from "./db.js";

export const platformStateStore = lazyInstance(() => platformStateStoreFromEnvironment({
  applicationName: "octogee-api",
  logger: {
    warn: (message, detail) => logger.warn(message, detail),
    error: (message, detail) => logger.error(message, detail),
  },
}));
export const readSizingKey = firestoreSizingKeyReader(db);
