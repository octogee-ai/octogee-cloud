import { readInstalledOpenClawBuild } from "./openclaw-installed-build.js";
import { repairSourceDoctorAgentStores } from "./openclaw-source-doctor.js";
import type { FleetBrokerClient } from "./fleet-broker-client.js";

export interface OpenClawBootWatcher {
  beforeStart(): Promise<void>;
  healthy(): Promise<void>;
}

interface InstalledOpenClaw {
  binary: string;
  installedBuild?: () => Promise<string>;
}

const CLAIM_PATH = "/internal/fleet/openclaw-boot/claim";
const HEALTHY_PATH = "/internal/fleet/openclaw-boot/healthy";

function missingBrokerRoute(error: unknown, path: string): boolean {
  return error instanceof Error
    && error.message.includes(`fleet-broker POST ${path} → 404`);
}

function sourceDoctorRequest(claim: Awaited<ReturnType<FleetBrokerClient["claimOpenClawBoot"]>>) {
  const request = claim.sourceDoctor;
  if (request && (typeof request.requestId !== "string" || !request.requestId || request.requestId.includes("/") || !Array.isArray(request.agentIds) ||
      !request.postgresAgentStores || request.agentIds.length === 0 || new Set(request.agentIds).size !== request.agentIds.length ||
      !request.agentIds.every((id) => /^octogee-[a-z0-9][a-z0-9_-]*-coach$/.test(id)) ||
      request.schedulerStateRecovery !== undefined && (request.schedulerStateRecovery !== true || !request.postgresAgentStores))) throw new Error("invalid source Doctor request");
  return request;
}

export function createOpenClawBootWatcher(input: {
  client: Pick<FleetBrokerClient, "claimOpenClawBoot" | "completeOpenClawBoot" | "completeOpenClawDoctor"> & Partial<Pick<FleetBrokerClient, "assertOpenClawDoctor">>;
  releaseKey: string;
  log: (message: string) => void;
  repairSourceDoctor?: typeof repairSourceDoctorAgentStores;
  inspectUserStores?: () => Promise<"exact">;
  openclaw?: InstalledOpenClaw;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): OpenClawBootWatcher {
  const now = input.now ?? (() => performance.now());
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const openclaw = input.openclaw;
  const installedBuild = async () => openclaw
    ? { openclawBuild: await (openclaw.installedBuild ?? (() => readInstalledOpenClawBuild(openclaw.binary)))() }
    : {};
  async function claimBoot(build: { openclawBuild?: string }): Promise<Awaited<ReturnType<FleetBrokerClient["claimOpenClawBoot"]>>> {
    const deadline = now() + 120_000;
    let pendingRequest: string | undefined;
    for (;;) {
      let claim: Awaited<ReturnType<FleetBrokerClient["claimOpenClawBoot"]>>;
      try { claim = await input.client.claimOpenClawBoot({ releaseKey: input.releaseKey, ...build }); }
      catch (error) {
        if (pendingRequest) throw new Error("source Doctor claim failed while awaiting installed image proof", { cause: error });
        throw error;
      }
      const request = sourceDoctorRequest(claim);
      if (pendingRequest && pendingRequest !== request?.requestId) throw new Error("source Doctor request changed while waiting for installed image proof");
      if (claim.action !== "wait") return claim;
      if (!request) throw new Error("source Doctor image wait requires an explicit request");
      pendingRequest = request.requestId;
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error("source Doctor installed image proof wait timed out");
      input.log("[openclaw-boot] awaiting controller verification of the installed source recovery image");
      await wait(Math.min(2_000, remaining));
    }
  }
  return {
    async beforeStart() {
      const build = await installedBuild();
      let claim: Awaited<ReturnType<FleetBrokerClient["claimOpenClawBoot"]>>;
      try {
        claim = await claimBoot(build);
      } catch (error) {
        if (!missingBrokerRoute(error, CLAIM_PATH)) throw error;
        input.log("[openclaw-boot] boot sentinel unavailable on this platform release; starting normally");
        claim = { action: "start" };
      }
      if (claim.action !== "start" && claim.action !== "doctor") {
        throw new Error(`invalid OpenClaw boot claim action: ${String(claim.action)}`);
      }
      if (claim.action === "doctor" && !claim.sourceDoctor) throw new Error("OpenClaw boot claim requested Doctor without a source request");
      await input.inspectUserStores?.();
      if (claim.action === "start" || !claim.sourceDoctor) return;
      input.log("[openclaw-boot] running explicitly requested source Doctor before gateway startup");
      await runSourceDoctor(input, claim.sourceDoctor);
      await input.client.completeOpenClawDoctor({ releaseKey: input.releaseKey, requestId: claim.sourceDoctor.requestId,
        verifiedAgentIds: claim.sourceDoctor.agentIds });
    },
    async healthy() {
      try {
        await input.client.completeOpenClawBoot({ releaseKey: input.releaseKey, ...await installedBuild() });
      } catch (error) {
        if (!missingBrokerRoute(error, HEALTHY_PATH)) throw error;
        input.log("[openclaw-boot] boot sentinel completion unavailable on this platform release");
      }
    },
  };
}

async function runSourceDoctor(input: Parameters<typeof createOpenClawBootWatcher>[0],
  request: NonNullable<Awaited<ReturnType<FleetBrokerClient["claimOpenClawBoot"]>>["sourceDoctor"]>): Promise<void> {
  const assertDoctor = input.client.assertOpenClawDoctor;
  if (!assertDoctor) throw new Error("PostgreSQL source Doctor authority checks are unavailable");
  await (input.repairSourceDoctor ?? repairSourceDoctorAgentStores)(request.agentIds, {
    diagnostics: { requestId: request.requestId, releaseKey: input.releaseKey, log: input.log },
    expectedAnchors: request.postgresAgentStores,
    ...(request.schedulerStateRecovery ? { schedulerStateRecovery: true } : {}),
    assertCurrent: () => assertDoctor({ releaseKey: input.releaseKey, requestId: request.requestId }),
  });
}
