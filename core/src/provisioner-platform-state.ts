import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { lazyInstance } from "./lazy-instance.js";
import { platformStateStoreFromEnvironment } from "./platform-state/postgres/store-from-environment.js";

const logger = createServiceLogger("provisioner");

export const platformStateStore = lazyInstance(() => platformStateStoreFromEnvironment({
  applicationName: "octogee-provisioner",
  logger,
}));
