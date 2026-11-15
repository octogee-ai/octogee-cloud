import { MalformedRecordError, type PlatformConfigRepository } from "@octogee/core/platform-state";
import { DEFAULT_PLATFORM_CONNECT_CONFIG, type PlatformConnectConfig } from "@octogee/shared/types/platform-config";
import { logger } from "@octogee/core/http/logging";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";

export class MalformedPlatformConnectConfigError extends Error {
  constructor() {
    super("platformConfig/connect is malformed");
    this.name = "MalformedPlatformConnectConfigError";
  }
}

export async function readPlatformConnectConfig(
  platform: Pick<PlatformConfigRepository, "get"> = platformStateStore.config.platform,
): Promise<PlatformConnectConfig> {
  try {
    return (await platform.get("connect"))?.value ?? DEFAULT_PLATFORM_CONNECT_CONFIG;
  } catch (error) {
    if (!(error instanceof MalformedRecordError)) throw error;
    logger.error(
      "[connect] platformConfig/connect is malformed — Google connect is refused until the operator rewrites it as { googleStages, googleAllowlistUids }",
      { error },
    );
    throw new MalformedPlatformConnectConfigError();
  }
}
