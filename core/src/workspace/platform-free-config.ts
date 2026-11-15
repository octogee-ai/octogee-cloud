import { MalformedRecordError } from "../platform-state/index.js";
import { DEFAULT_PLATFORM_FREE_CONFIG, type PlatformFreeConfig } from "@octogee/shared/types/platform-config";
import { logger } from "../http/logging.js";
import { platformStateStore } from "../identity/platform-state-store.js";

export async function readPlatformFreeConfig(): Promise<PlatformFreeConfig> {
  try {
    return (await platformStateStore.config.platform.get("free"))?.value ?? DEFAULT_PLATFORM_FREE_CONFIG;
  } catch (error) {
    if (!(error instanceof MalformedRecordError)) throw error;
    logger.warn("platformConfig/free invalid; using compiled Free storage allowance");
    return DEFAULT_PLATFORM_FREE_CONFIG;
  }
}
