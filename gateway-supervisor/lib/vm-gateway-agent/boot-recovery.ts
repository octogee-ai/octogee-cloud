import type { GatewayVmBootRecoverySample, GatewayVmRuntimeRequest } from "@octogee/shared/types/glm";
import { inspectContainer } from "./docker-engine.js";
import { GATEWAY_ID_LABEL, runningVersion } from "./plan.js";
import type { VmAgentDeps } from "./agent.js";

async function legacyRecovery(deps: VmAgentDeps): Promise<GatewayVmBootRecoverySample> {
  const points = await deps.home.fs.listDir(`${deps.stateRoot}/.home-checkpoint/pre-migration`);
  const gateway = await inspectContainer(deps.engine, "octogee-gateway");
  const version = runningVersion(gateway) ?? "unavailable";
  const freeBytes = (await deps.fs.diskUsage(deps.stateRoot)).freeBytes;
  let ready = false;
  if (points.length === 0 && gateway?.State?.Running && !gateway.State.Paused && gateway.Config?.Labels?.[GATEWAY_ID_LABEL] === deps.gatewayId) {
    const response = await deps.fetchImpl("http://127.0.0.1:3003/surge-ready", { signal: AbortSignal.timeout(5_000) });
    if (response.ok) {
      const body = await response.json() as Record<string, unknown>;
      ready = ["ready", "openclawUp", "brokerProfilesSettled", "dashboardBridgeReady", "handoffReleased"].every(key => body[key] === true)
        && body.runtimeStatus === "ready" && (body.prelaunchState === "none" || body.prelaunchState === "serving");
    }
  }
  return { currentPointId: null, retainedPoints: points.length, ready, bundleVersion: version, freeBytes };
}

const lastLogged = new WeakMap<VmAgentDeps, string>();

function logOnChange(deps: VmAgentDeps, line: string): void {
  if (lastLogged.get(deps) === line) return;
  lastLogged.set(deps, line);
  deps.log(line);
}

const UNAVAILABLE_SAMPLE: GatewayVmBootRecoverySample = { currentPointId: null, retainedPoints: 1000, ready: false, bundleVersion: "unavailable", freeBytes: 0 };

async function sampleBootRecovery(deps: VmAgentDeps, recovery: () => Promise<GatewayVmBootRecoverySample>): Promise<GatewayVmBootRecoverySample> {
  try {
    const sample = await recovery();
    logOnChange(deps, `[vm-agent] boot recovery ready=${sample.ready} retainedPoints=${sample.retainedPoints} freeGiB=${Math.floor(sample.freeBytes / 1024 ** 3)} bundle=${sample.bundleVersion}`);
    return sample;
  } catch (error) {
    if ((error as { status?: number }).status === 400 && String(error).includes("unknown action")) {
      try { return await legacyRecovery(deps); }
      catch (legacyError) { logOnChange(deps, `[vm-agent] legacy recovery preflight unavailable: ${String(legacyError)}`); }
    }
    logOnChange(deps, `[vm-agent] home recovery admission/capacity unavailable; retaining points: ${String(error)}`);
    return UNAVAILABLE_SAMPLE;
  }
}

export async function bootRecoveryReport(deps: VmAgentDeps): Promise<GatewayVmRuntimeRequest> {
  if (!deps.home.desktop.recovery) return {};
  return { bootRecovery: await sampleBootRecovery(deps, deps.home.desktop.recovery) };
}
