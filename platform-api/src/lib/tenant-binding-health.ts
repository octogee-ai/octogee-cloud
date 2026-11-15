import { readFile } from "node:fs/promises";
import type { Reviewer } from "./token-review.js";

export const DEFAULT_PROJECTED_API_TOKEN_PATH =
  "/var/run/secrets/octogee-api/token";

export type TenantBindingHealth =
  | { status: "pending" }
  | { status: "healthy"; checkedAt: string }
  | { status: "unhealthy"; checkedAt: string; reason: string }
  | { status: "skipped"; reason: string };

export interface TenantBindingHealthState {
  get(): TenantBindingHealth;
  set(value: TenantBindingHealth): void;
}

export interface TenantBindingSelfCheckOptions {
  reviewer: Reviewer;
  tokenPath?: string;
  inCluster?: boolean;
  log?: (msg: string) => void;
}

export function createTenantBindingHealthState(): TenantBindingHealthState {
  let value: TenantBindingHealth = { status: "pending" };
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
}

export function startTenantBindingSelfCheck(
  state: TenantBindingHealthState,
  opts: TenantBindingSelfCheckOptions,
): void {
  const inCluster =
    opts.inCluster ?? typeof process.env.KUBERNETES_SERVICE_HOST === "string";
  if (!inCluster) {
    state.set({ status: "skipped", reason: "not-in-kubernetes" });
    return;
  }
  const tokenPath = opts.tokenPath ?? DEFAULT_PROJECTED_API_TOKEN_PATH;
  const runSelfCheck = async (): Promise<void> => {
    try {
      const token = (await readFile(tokenPath, "utf8")).trim();
      if (!token) throw new Error(`empty projected token at ${tokenPath}`);
      const reviewed = await opts.reviewer(token);
      if (!reviewed.authenticated) {
        throw new Error("projected token was not authenticated for octogee-api audience");
      }
      state.set({ status: "healthy", checkedAt: new Date().toISOString() });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      opts.log?.(`FATAL: tenant-binding self-check failed: ${reason}`);
      state.set({
        status: "unhealthy",
        checkedAt: new Date().toISOString(),
        reason,
      });
    }
  };
  runSelfCheck();
}
