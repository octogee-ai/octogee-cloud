#!/usr/bin/env tsx
import "../src/main.js";
import { execFile as execFileCallback } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { applicationDefault, deleteApp, initializeApp } from "firebase-admin/app";
import { centralGatewayReleasePayload, createCentralReleaseAuthority, type ReleaseDigestManifest } from "@octogee/core/artifact-registry";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import { appendGatewayRelease, asDurableGatewayRoot, InvalidGatewayRootError, StaleGatewayReleaseError } from "@octogee/core/gateway-release-append";
import { GatewayRetirementConflictError } from "@octogee/core/gateway-retirement-claim";
import { readGatewayRuntimeDoc } from "@octogee/core/gateway-live-release";
import { runNormalFleetMutation } from "@octogee/core/normal-fleet-mutation";
import {
  type GatewayRelease,
  type OperationRecord,
  type PlatformStateStore,
  type Stored,
} from "@octogee/core/platform-state";
import { operatorPlatformStateStore } from "../lib/platform-state-store.js";
import { sharedGatewayAddedBy } from "@octogee/shared/types/shared-gateway-pool";
import { timestampMillis } from "@octogee/core/timestamps";
import {
  isGatewayRuntimeDoc, isReleasePayload, projectGatewayDesiredRootForGateway, releasePayloadHash,
  type PlatformReleaseRecord, type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import { deployFleet, formatFleetSummary, matchesFleetPlatformRelease, FleetDeploymentDeferredError, type FleetGateway, type FleetSnapshot } from "../lib/fleet-deploy.js";
import { object, fleetPodObservations, fleetVmObservation } from "../lib/fleet-observation.js";

const execFile = promisify(execFileCallback);

export function parseFleetDeployArgs(argv: string[]): { sourceSha: string; timeoutMs: number } {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--(sha|timeout-ms)=(.+)$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error(`invalid TEST fleet argument: ${arg}`);
    values.set(match[1], match[2]);
  }
  const sourceSha = values.get("sha") ?? "";
  const timeoutMs = Number(values.get("timeout-ms") ?? 2_700_000);
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("--sha=<full-lowercase-sha> and a positive --timeout-ms are required");
  return { sourceSha, timeoutMs };
}

function payloadOf(value: GatewayRelease | null, gatewayId: string, release: number): ReleasePayload | null {
  return value !== null && value.gatewayId === gatewayId && value.release === release && isReleasePayload(value.payload) &&
    value.payloadHash === releasePayloadHash(value.payload) ? value.payload : null;
}

function withoutRevision<T extends { readonly revision: unknown }>(record: T): Omit<T, "revision"> {
  const { revision: _revision, ...rest } = record;
  return rest;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function runtimeOf(value: Record<string, unknown>, gatewayId: string): FleetGateway["runtime"] {
  const heartbeat = object(value.heartbeat);
  if (!isGatewayRuntimeDoc(value) || value.gatewayId !== gatewayId) return null;
  return {
    release: value.release, lifecycle: String(value.lifecycle ?? "unknown"), status: String(heartbeat.status ?? "unknown"),
    heartbeatAt: timestampMillis(heartbeat.lastHeartbeatAt) ?? null, mountedCustomers: strings(heartbeat.mountedCustomers), migratingIn: strings(heartbeat.migratingIn),
  };
}

function platformRecordOf(stored: Stored<PlatformReleaseRecord> | null): PlatformReleaseRecord | null {
  return stored === null ? null : withoutRevision(stored);
}

async function readGateway(input: {
  store: PlatformStateStore; gatewayId: string; value: object; observedAt: number;
  pods: ReturnType<typeof fleetPodObservations>; operations: readonly Stored<OperationRecord>[];
}): Promise<FleetGateway> {
  const root = projectGatewayDesiredRootForGateway(input.value, input.gatewayId);
  if (!root) throw new Error(`gateway ${input.gatewayId} has an invalid durable root`);
  const [desired, latest, runtimeDoc, assignments] = await Promise.all([
    input.store.gateways.releases.get(root.gatewayId, root.desiredRelease),
    input.store.gateways.releases.get(root.gatewayId, root.latestRelease),
    readGatewayRuntimeDoc(input.store, root),
    input.store.gateways.assignments.list(root.gatewayId),
  ]);
  const runtime = object(runtimeDoc);
  return {
    gatewayId: root.gatewayId, gatewayClass: root.gatewayClass, imageProfile: root.imageProfile, addedBy: root.gatewayClass === "shared" ? sharedGatewayAddedBy(root) : null,
    desiredStatus: root.desiredStatus, latestRelease: root.latestRelease, desiredRelease: root.desiredRelease, liveRelease: root.liveRelease,
    desiredPayload: payloadOf(desired, root.gatewayId, root.desiredRelease), latestPayload: payloadOf(latest, root.gatewayId, root.latestRelease),
    runtime: runtimeOf(runtime, root.gatewayId),
    live: runtime.runtime === "gce-vm" ? fleetVmObservation(runtime) : input.pods.get(root.gatewayId) ?? { observedAt: input.observedAt, instances: [] },
    assignments: assignments.map((assignment) => ({ slug: assignment.slug, state: assignment.state })),
    operations: input.operations.flatMap((data) => {
      const operation = object(data.input);
      return operation.gatewayId === root.gatewayId && typeof operation.targetRelease === "number"
        ? [{ id: data.id, release: operation.targetRelease, status: String(data.status), error: typeof data.error === "string" ? data.error : null }] : [];
    }),
  };
}

export async function readFleetSnapshot(store: PlatformStateStore, observePods: () => Promise<unknown>): Promise<FleetSnapshot> {
  const [roots, operations, scalerState, platform, pods, retired] = await Promise.all([
    store.gateways.roots.list(),
    store.journal.operations.listByKind("rollout"),
    store.controllerState.sharedPoolScaler.get(),
    store.controllerState.platformRelease.get(),
    observePods(),
    store.journal.operations.listByKind("retire-gateway"),
  ]);
  const observedAt = Date.now();
  const observations = fleetPodObservations(pods, observedAt);
  const gateways = await Promise.all(roots.map((root) => readGateway({
    store, gatewayId: root.gatewayId, value: withoutRevision(root), observedAt, pods: observations, operations,
  })));
  const retirements = retired.flatMap((data) => {
    const gatewayId = object(data.input).gatewayId;
    const completedAt = timestampMillis(data.completedAt);
    if (data.status !== "succeeded" || typeof gatewayId !== "string" || completedAt == null) return [];
    return [{ gatewayId, operationId: data.id, completedAt, live: { observedAt, instances: observations.get(gatewayId)?.instances ?? [] } }];
  });
  return { gateways, retirements, sharedReplacements: [...(scalerState?.replacements ?? [])], platform: platformRecordOf(platform) };
}

async function observeGatewayPods(environment: "test" | "prod"): Promise<unknown> {
  const settings = deploymentEnvironmentSettings(environment);
  const pods = await execFile("kubectl", ["--context", settings.kubeContext, "--namespace", settings.namespace, "get", "pods", "--selector", "app=octogee-gateway", "-o", "json"], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(pods.stdout);
}

async function hasSucceededRetirement(store: PlatformStateStore, gatewayId: string): Promise<boolean> {
  const operations = await store.journal.operations.listByKind("retire-gateway", ["succeeded"]);
  return operations.some((operation) => object(operation.input).gatewayId === gatewayId);
}

async function rethrowMutationError(store: PlatformStateStore, gatewayId: string, error: unknown): Promise<never> {
  if (error instanceof GatewayRetirementConflictError || error instanceof StaleGatewayReleaseError) throw new FleetDeploymentDeferredError(error.message);
  if (error instanceof InvalidGatewayRootError && await hasSucceededRetirement(store, gatewayId)) throw new FleetDeploymentDeferredError(`${gatewayId} completed retirement during deployment selection`);
  throw error;
}

export async function deployFleetUser(store: PlatformStateStore, gateway: Pick<FleetGateway, "gatewayId">, manifest: ReleaseDigestManifest, payload: ReleasePayload, environment: "test" | "prod"): Promise<{ release: number; operationId: string | null }> {
  const [stored, platform] = await Promise.all([
    store.gateways.roots.get(gateway.gatewayId),
    store.controllerState.platformRelease.get(),
  ]);
  const current = stored === null ? null : asDurableGatewayRoot(withoutRevision(stored), gateway.gatewayId);
  if (current?.desiredStatus === "retired") throw new FleetDeploymentDeferredError(`${gateway.gatewayId} retired during deployment selection`);
  if (stored === null) await rethrowMutationError(store, gateway.gatewayId, new InvalidGatewayRootError(gateway.gatewayId));
  if (!current || current.gatewayClass !== "isolated") throw new Error(`${gateway.gatewayId} is no longer a non-retired isolated gateway`);
  if (!matchesFleetPlatformRelease(platformRecordOf(platform), payload, manifest.sourceSha)) throw new Error("platform release was superseded before user deployment");
  const actor = process.env.RELEASE_ACTOR ?? `operator:${environment}-fleet`;
  try { return await runNormalFleetMutation(store, {
    actor, forced: false, what: `deploy ${environment.toUpperCase()} build to isolated gateway`, why: process.env.RELEASE_REASON ?? `operator requested complete ${environment.toUpperCase()} fleet deployment`,
    target: { gatewayId: current.gatewayId, environment },
    preActionStatus: { desiredStatus: current.desiredStatus, desiredRelease: current.desiredRelease, latestRelease: current.latestRelease },
    mutation: { kind: "deploy-gateway-build", gatewayId: current.gatewayId, sourceSha: manifest.sourceSha, manifestDigest: manifest.manifestDigest },
    ...(environment === "test" ? { testProvenance: { environment: "test" as const, sourceCommit: manifest.sourceSha } } : {}),
    action: () => appendGatewayRelease(store, { gateway: current, artifact: payload, payload, createdBy: actor, now: Date.now(), sourceRelease: current.latestRelease, note: `complete ${environment.toUpperCase()} deployment of ${manifest.sourceSha}`, origin: "operator" }),
    classifyResult: (result) => ({ outcome: "completed", releaseRollout: { releaseId: `${current.gatewayId}/releases/${result.release}`, ...(result.operationId ? { rolloutOperationId: result.operationId } : {}) } }),
  }); } catch (error) {
    return rethrowMutationError(store, gateway.gatewayId, error);
  }
}

export async function runFleetDeploy(argv: string[]): Promise<void> {
  const options = parseFleetDeployArgs(argv);
  const environment = process.env.RELEASE_ENVIRONMENT;
  if (environment !== "test" && environment !== "prod") throw new Error("RELEASE_ENVIRONMENT must be test or prod");
  const settings = deploymentEnvironmentSettings(environment);
  const authority = createCentralReleaseAuthority({ project: settings.artifactRegistryProjectId, location: settings.artifactRegistryLocation, repository: settings.artifactRegistryName });
  const manifest = await authority.resolveManifest(options.sourceSha);
  if (manifest.sourceSha !== options.sourceSha) throw new Error("resolved immutable manifest differs from requested source SHA");
  const payload = centralGatewayReleasePayload(manifest);
  const app = initializeApp({ credential: applicationDefault(), projectId: settings.firebaseProjectId }, "deploy-fleet");
  try {
    const store = await operatorPlatformStateStore(settings.targetId);
    const report = await deployFleet({ ...options, environment, payload }, {
      now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      readSnapshot: () => readFleetSnapshot(store, () => observeGatewayPods(environment)),
      deploy: (gateway) => deployFleetUser(store, gateway, manifest, payload, environment),
      log: (message) => process.stdout.write(`${message}\n`),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, formatFleetSummary(report));
    if (report.outcome !== "converged") throw new Error(`${environment.toUpperCase()} fleet ${report.outcome}: ${[...report.reasons, ...report.targets.flatMap((target) => target.reasons.map((reason) => `${target.gatewayId}: ${reason}`))].join("; ")}`);
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runFleetDeploy(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
