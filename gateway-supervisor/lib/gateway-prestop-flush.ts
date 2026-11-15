export interface GatewayPreStopFlushDeps {
  gatewayId: string;
  gatewayClass: string;
  quiesceSessions?: () => Promise<void>;
  flushFiles: () => Promise<unknown>;
  syncBlobs?: () => Promise<void>;
  syncSystemConfig?: () => Promise<void | { acceptedCommit: string }>;
  syncRuntimeState?: () => Promise<void>;
  releaseGiteaKey?: () => Promise<void>;
  log: (msg: string) => void;
  now?: () => number;
}

export interface GatewaySystemConfigConvergenceCheckpointDeps {
  gatewayId: string;
  gatewayClass: string;
  syncSystemConfig: () => Promise<{ acceptedCommit: string }>;
  log: (msg: string) => void;
  now?: () => number;
}

export interface GatewayPreStopFlushStep {
  name:
    | "session-quiesce"
    | "customer-files"
    | "blob-sync"
    | "system-config"
    | "runtime-state"
    | "gitea-key-release";
  status: "done" | "failed" | "skipped";
  error?: string;
  durationMs: number;
}

export interface GatewayPreStopFlushResult {
  ok: boolean;
  durationMs: number;
  systemConfigCommit?: string;
  steps: GatewayPreStopFlushStep[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function systemConfigCommit(value: unknown): string | undefined {
  return value && typeof value === "object" &&
      "acceptedCommit" in value &&
      typeof value.acceptedCommit === "string"
    ? value.acceptedCommit
    : undefined;
}

async function runStep<T>(
  deps: Pick<GatewayPreStopFlushDeps, "log" | "now">,
  name: GatewayPreStopFlushStep["name"],
  fn: (() => Promise<T>) | undefined,
): Promise<{ step: GatewayPreStopFlushStep; value?: T }> {
  const now = deps.now ?? Date.now;
  const started = now();
  if (!fn) {
    return { step: { name, status: "skipped", durationMs: 0 } };
  }
  try {
    const value = await fn();
    const durationMs = now() - started;
    deps.log(`[prestop-flush] ${name} done in ${durationMs}ms`);
    return { step: { name, status: "done", durationMs }, value };
  } catch (err) {
    const durationMs = now() - started;
    const error = errorMessage(err);
    deps.log(`[prestop-flush] ${name} failed in ${durationMs}ms: ${error}`);
    return { step: { name, status: "failed", error, durationMs } };
  }
}

export async function runGatewayPreStopFlush(
  deps: GatewayPreStopFlushDeps,
): Promise<GatewayPreStopFlushResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  deps.log(
    `[prestop-flush] starting gateway=${deps.gatewayId} class=${deps.gatewayClass || "unknown"}`,
  );

  const quiesce = await runStep(deps, "session-quiesce", deps.quiesceSessions);
  const runtimeStatePromise = runStep(deps, "runtime-state", deps.syncRuntimeState);
  const workspace = await runStep(deps, "customer-files", deps.flushFiles);
  const blobs = await runStep(deps, "blob-sync", deps.syncBlobs);
  const systemConfig = await runStep(deps, "system-config", deps.syncSystemConfig);
  const runtimeState = await runtimeStatePromise;
  const durableSteps = [workspace.step, blobs.step, systemConfig.step, runtimeState.step];
  const safeToReleaseKey = [quiesce.step, ...durableSteps]
    .every((step) => step.status !== "failed");
  const keyRelease = await runStep(
    deps,
    "gitea-key-release",
    safeToReleaseKey ? deps.releaseGiteaKey : undefined,
  );
  const steps = [quiesce.step, ...durableSteps, keyRelease.step];
  const durationMs = now() - started;
  const ok = steps.every((step) => step.status !== "failed");
  deps.log(`[prestop-flush] complete ok=${ok} durationMs=${durationMs}`);
  const acceptedCommit = systemConfigCommit(systemConfig.value);
  return {
    ok,
    durationMs,
    steps,
    ...(acceptedCommit ? { systemConfigCommit: acceptedCommit } : {}),
  };
}

export async function runGatewaySystemConfigConvergenceCheckpoint(
  deps: GatewaySystemConfigConvergenceCheckpointDeps,
): Promise<GatewayPreStopFlushResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  deps.log(
    `[prestop-flush] starting config convergence gateway=${deps.gatewayId} class=${deps.gatewayClass || "unknown"}`,
  );
  const systemConfig = await runStep(deps, "system-config", async () => {
    const result = await deps.syncSystemConfig();
    if (!systemConfigCommit(result)) {
      throw new Error("system config checkpoint returned no accepted commit");
    }
    return result;
  });
  const steps: GatewayPreStopFlushStep[] = [
    { name: "session-quiesce", status: "skipped", durationMs: 0 },
    { name: "customer-files", status: "skipped", durationMs: 0 },
    { name: "blob-sync", status: "skipped", durationMs: 0 },
    systemConfig.step,
    { name: "runtime-state", status: "skipped", durationMs: 0 },
    { name: "gitea-key-release", status: "skipped", durationMs: 0 },
  ];
  const durationMs = now() - started;
  const ok = systemConfig.step.status !== "failed";
  deps.log(`[prestop-flush] config convergence complete ok=${ok} durationMs=${durationMs}`);
  const acceptedCommit = systemConfigCommit(systemConfig.value);
  return {
    ok,
    durationMs,
    steps,
    ...(acceptedCommit ? { systemConfigCommit: acceptedCommit } : {}),
  };
}
