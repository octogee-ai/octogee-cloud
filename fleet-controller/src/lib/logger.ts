import { createServiceLogger, type LogContext, type ServiceLogger } from "@octogee/shared/server/service-logger";

export interface ScopeMeta extends LogContext {
  scope?: string;
  emoji?: string;
}

export interface Logger {
  info(message: string, meta?: ScopeMeta): void;
  warn(message: string, meta?: ScopeMeta): void;
  error(message: string, meta?: ScopeMeta): void;
  debug(message: string, meta?: ScopeMeta): void;
  child(scope: string, emoji?: string): Logger;
  legacy(message: string): void;
}

export function debugFromEnv(): boolean {
  return process.env.DEBUG != null || (process.env.LOG_LEVEL ?? "").toLowerCase() === "debug";
}

export function createLogger(options: { debug?: boolean } = {}): Logger {
  const wrap = (logger: ServiceLogger): Logger => {
    const fields = (meta: ScopeMeta = {}): LogContext => {
      const { scope, ...rest } = meta;
      delete rest.emoji;
      return { ...rest, ...(scope ? { category: scope } : {}) };
    };
    return {
      info: (message, meta) => logger.info(message, fields(meta)),
      warn: (message, meta) => logger.warn(message, fields(meta)),
      error: (message, meta) => logger.error(message, fields(meta)),
      debug: (message, meta) => logger.debug(message, fields(meta)),
      child: scope => wrap(logger.child({ category: scope })),
      legacy: message => {
        const text = message.replace(/^\[glm-controller\]\s*/, "");
        const prefix = /^(?:\[[^\]]+\]\s*)?([⚠❌🔴])/u.exec(text);
        const level = ({ "⚠": "warn", "❌": "error", "🔴": "error" } as const)[prefix?.[1] as "⚠" | "❌" | "🔴"] ?? "info";
        logger[level](text);
      },
    };
  };
  return wrap(createServiceLogger("cowboy", options));
}
