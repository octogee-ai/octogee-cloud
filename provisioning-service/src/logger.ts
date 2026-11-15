import { createServiceLogger, type ServiceLogger } from "@octogee/shared/server/service-logger";

export type Logger = Pick<ServiceLogger, "debug" | "info" | "warn" | "error">;

export function createLogger(): Logger {
  return createServiceLogger("provisioning-service");
}
