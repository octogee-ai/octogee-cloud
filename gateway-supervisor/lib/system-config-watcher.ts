import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface SystemConfigWatchSyncResult {
  committed: boolean;
  pushed: boolean;
  pending?: boolean;
  processedFingerprint?: string;
  rejected?: boolean;
  errorCode?: string;
}

export interface SystemConfigWatcherStatus {
  state: "clean" | "dirty" | "syncing" | "error";
  generation: number;
  lastError?: string;
  errorCode?: string;
}

interface WatchHandle {
  close(): void;
}

interface SystemConfigWatcherOptions {
  configPath: string;
  sync: () => Promise<SystemConfigWatchSyncResult>;
  audit?: () => Promise<{ needsSync: boolean }> | { needsSync: boolean };
  debounceMs?: number;
  retryMs?: number;
  pollMs?: number;
  startImmediately?: boolean;
  watch?: (directory: string, onChange: () => void) => WatchHandle;
  log?: (message: string) => void;
  onStatusChange?: (status: SystemConfigWatcherStatus) => void;
}

export function systemConfigFingerprint(configPath: string): string {
  try {
    return createHash("sha256").update(fs.readFileSync(configPath)).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export function createSystemConfigWatcher(options: SystemConfigWatcherOptions) {
  const debounceMs = options.debounceMs ?? 2_000;
  const retryMs = options.retryMs ?? 5_000;
  const pollMs = options.pollMs ?? 30_000;
  const log = options.log ?? (() => {});
  let generation = 0;
  let lastProcessedFingerprint = systemConfigFingerprint(options.configPath);
  let state: SystemConfigWatcherStatus["state"] = "clean";
  let lastError: string | undefined;
  let errorCode: string | undefined;
  let pendingPush = options.startImmediately !== false;
  let closed = false;
  let running = false;
  let auditRunning = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;

  const defaultWatch = (directory: string, onChange: () => void): WatchHandle => {
    const basename = path.basename(options.configPath);
    const watcher = fs.watch(directory, (_event, filename) => {
      if (!filename || filename.toString() === basename || filename.toString().startsWith(`${basename}.`)) {
        onChange();
      }
    });
    return watcher;
  };

  const watchHandle = (options.watch ?? defaultWatch)(path.dirname(options.configPath), () => notify());

  function status(): SystemConfigWatcherStatus {
    return {
      state,
      generation,
      ...(lastError ? { lastError } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
  }

  function transition(next: SystemConfigWatcherStatus["state"]): void {
    state = next;
    options.onStatusChange?.(status());
  }

  function schedule(delay: number): void {
    if (closed || running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delay);
  }

  async function synchronize(startedFingerprint: string): Promise<void> {
    transition("syncing");
    try {
      const result = await options.sync();
      const processedFingerprint = result.processedFingerprint ?? startedFingerprint;
      lastProcessedFingerprint = processedFingerprint;
      pendingPush = result.pending === true || (result.committed && !result.pushed);
      lastError = result.rejected ? (result.errorCode ?? "config-rejected") : undefined;
      errorCode = pendingPush || result.rejected
        ? (result.errorCode ?? "checkpoint-pending")
        : undefined;
    } catch (error) {
      pendingPush = true;
      lastError = error instanceof Error ? error.message : String(error);
      errorCode = "watcher-sync-failed";
      log(`[system_config] watcher sync failed: ${lastError}`);
    }
  }

  function scheduleRemainingWork(): void {
    if (closed) return;
    if (pendingPush) {
      schedule(retryMs);
      return;
    }
    if (systemConfigFingerprint(options.configPath) !== lastProcessedFingerprint) {
      transition("dirty");
      schedule(debounceMs);
    }
  }

  async function run(): Promise<void> {
    if (closed || running) return;
    running = true;
    try {
      while (!closed) {
        const startedFingerprint = systemConfigFingerprint(options.configPath);
        if (!pendingPush && startedFingerprint === lastProcessedFingerprint) {
          transition(lastError ? "error" : "clean");
          break;
        }
        await synchronize(startedFingerprint);
        const currentFingerprint = systemConfigFingerprint(options.configPath);
        const contentChangedAfterSnapshot = currentFingerprint !== lastProcessedFingerprint;
        if (contentChangedAfterSnapshot) {
          transition("dirty");
          continue;
        }

        transition(pendingPush || lastError ? "error" : "clean");
        break;
      }
    } finally {
      running = false;
      scheduleRemainingWork();
    }
  }

  function notify(): void {
    if (closed) return;
    generation += 1;
    transition("dirty");
    if (!running) schedule(debounceMs);
  }

  if (pollMs > 0) {
    poll = setInterval(() => {
      if (closed) return;
      if (pendingPush || systemConfigFingerprint(options.configPath) !== lastProcessedFingerprint) {
        notify();
        return;
      }
      if (!options.audit || auditRunning) return;
      auditRunning = true;
      void Promise.resolve(options.audit())
        .then((result) => {
          if (!closed && result.needsSync) {
            pendingPush = true;
            notify();
          }
        })
        .catch((error) => {
          if (closed) return;
          lastError = error instanceof Error ? error.message : String(error);
          errorCode = "watcher-audit-failed";
          log(`[system_config] watcher audit failed: ${lastError}`);
          notify();
        })
        .finally(() => {
          auditRunning = false;
        });
    }, pollMs);
  }

  if (options.startImmediately !== false) notify();

  return {
    notify,
    flush: run,
    status,
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      watchHandle.close();
    },
  };
}
