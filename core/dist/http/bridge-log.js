import { logger } from "./logging.js";
export function createBridgeLog(deps = {}) {
    const now = deps.now ?? (() => new Date());
    const info = deps.info ?? ((message) => logger.info(message));
    const warn = deps.warn ?? ((message) => logger.warn(message));
    return (message, severity = "info") => {
        const formatted = `${now().toISOString()} ${message}`;
        if (severity === "warn") {
            warn(formatted);
            return;
        }
        info(formatted);
    };
}
