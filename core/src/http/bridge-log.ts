import { logger } from "./logging.js";
export type BridgeLogSeverity = "info" | "warn";

export type BridgeLog = (message: string, severity?: BridgeLogSeverity) => void;

export interface BridgeLogDependencies {
  now?: () => Date;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export function createBridgeLog(deps: BridgeLogDependencies = {}): BridgeLog {
  const now = deps.now ?? (() => new Date());
  const info = deps.info ?? ((message: string) => logger.info(message));
  const warn = deps.warn ?? ((message: string) => logger.warn(message));

  return (message: string, severity: BridgeLogSeverity = "info"): void => {
    const formatted = `${now().toISOString()} ${message}`;
    if (severity === "warn") {
      warn(formatted);
      return;
    }
    info(formatted);
  };
}
