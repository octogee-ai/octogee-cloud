import * as fs from "node:fs";
import * as path from "node:path";

import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import type { GatewayRpcClient } from "./gateway-rpc.js";

export const BROKER_TOKEN_EXPIRY_DIRECTORY = "agent-model-token-expiry";
export const BROKER_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
export const BROKER_TOKEN_REFRESH_FALLBACK_MS = 23 * 60 * 60 * 1000;
export const BROKER_TOKEN_REFRESH_RETRY_MS = 60 * 1000;

export interface BrokerTokenExpiry {
  refId: string;
  expiresAt: number;
}

const BROKER_TOKEN_REF_ID_RE =
  /^(?:agent-model-token-(?:(?:openrouter|openai|vertex|meta)-)?|agent-embedding-token-openai-)(?<agentId>octogee-[a-z0-9-]{1,64}-coach)$/;

function isBrokerTokenExpiry(value: unknown): value is BrokerTokenExpiry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.refId === "string"
    && BROKER_TOKEN_REF_ID_RE.test(record.refId)
    && typeof record.expiresAt === "number"
    && Number.isSafeInteger(record.expiresAt)
    && record.expiresAt > 0
  );
}

export function brokerTokenExpiryDirectory(openclawDir: string): string {
  return path.join(openclawDir, "secrets", BROKER_TOKEN_EXPIRY_DIRECTORY);
}

function readBrokerTokenExpiryRecords(
  directory: string,
  log: (message: string) => void,
): Array<{ filename: string; expiry: BrokerTokenExpiry }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: Array<{ filename: string; expiry: BrokerTokenExpiry }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filename = path.join(directory, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
      if (!isBrokerTokenExpiry(parsed)) throw new Error("invalid expiry metadata");
      records.push({ filename, expiry: parsed });
    } catch (error) {
      log(`[agent-model-token] ⚠ ignored malformed expiry metadata ${entry.name}: ${String(error)}`);
    }
  }
  return records;
}

export function readBrokerTokenExpiries(
  directory: string,
  log: (message: string) => void,
): BrokerTokenExpiry[] {
  try {
    return readBrokerTokenExpiryRecords(directory, log).map((record) => record.expiry);
  } catch (error) {
    log(`[agent-model-token] ⚠ expiry metadata read failed: ${String(error)}`);
    return [];
  }
}

export function removeBrokerTokenExpiriesForSlug(
  directory: string,
  slug: string,
  log: (message: string) => void,
): void {
  for (const { filename, expiry } of readBrokerTokenExpiryRecords(directory, log)) {
    const agentId = BROKER_TOKEN_REF_ID_RE.exec(expiry.refId)?.groups?.agentId;
    if (agentId !== undefined && agentIdBelongsToSlug(agentId, slug)) fs.rmSync(filename, { force: true });
  }
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface BrokerTokenRefreshScheduler {
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
}

export function createBrokerTokenRefreshScheduler(input: {
  rpc: Pick<GatewayRpcClient, "secretsReload">;
  openclawDir?: string;
  log: (message: string) => void;
  now?: () => number;
  readExpiries?: () => BrokerTokenExpiry[];
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}): BrokerTokenRefreshScheduler {
  const now = input.now ?? Date.now;
  const directory = brokerTokenExpiryDirectory(
    input.openclawDir ?? path.join(process.env.HOME ?? "/home/node", ".openclaw"),
  );
  const readExpiries = input.readExpiries ?? (() => readBrokerTokenExpiries(directory, input.log));
  const setTimer = input.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = input.clearTimer ?? ((timer) => clearTimeout(timer));

  let stopped = false;
  let timer: TimerHandle | null = null;
  let inFlight: Promise<void> | null = null;
  let lastSuccessfulRefreshAt: number | null = null;
  let retryRequired = false;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void refresh();
    }, Math.max(0, Math.ceil(delayMs)));
  };

  const nextRefreshDelay = (refreshedAt: number) => {
    const fallbackDueAt = refreshedAt + BROKER_TOKEN_REFRESH_FALLBACK_MS;
    const expiryDueAt = readExpiries().reduce((earliest, entry) => {
      const dueAt = entry.expiresAt - BROKER_TOKEN_REFRESH_SKEW_MS;
      if (dueAt <= refreshedAt) return earliest;
      return Math.min(earliest, dueAt);
    }, fallbackDueAt);
    return Math.max(0, expiryDueAt - now());
  };

  const run = async () => {
    if (!retryRequired && lastSuccessfulRefreshAt !== null) {
      const delayMs = nextRefreshDelay(lastSuccessfulRefreshAt);
      if (delayMs > 0) {
        schedule(delayMs);
        return;
      }
    }
    retryRequired = false;
    try {
      const result = await input.rpc.secretsReload();
      if (result.ok !== true) {
        throw new Error("secrets.reload did not acknowledge success");
      }
      lastSuccessfulRefreshAt = now();
      if ((result.warningCount ?? 0) > 0) {
        retryRequired = true;
        input.log(
          `[agent-model-token] secrets.reload completed with ${result.warningCount} warning(s); retrying soon`,
        );
        schedule(BROKER_TOKEN_REFRESH_RETRY_MS);
        return;
      }
      schedule(nextRefreshDelay(lastSuccessfulRefreshAt));
    } catch (error) {
      retryRequired = true;
      input.log(`[agent-model-token] ⚠ refresh failed: ${String(error)}; retrying in 60s`);
      schedule(BROKER_TOKEN_REFRESH_RETRY_MS);
    }
  };

  const refresh = () => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    start() {
      if (stopped) return;
      schedule(0);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
    },
    refresh,
  };
}
