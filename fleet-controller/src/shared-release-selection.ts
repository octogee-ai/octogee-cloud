import type { deploymentSettingsForRuntime } from "@octogee/core/deployment-environment";
import { readFile } from "node:fs/promises";
import { releasePayloadHash, isReleasePayload, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { HelmInstanceValue } from "@octogee/shared/types/glm";
import { gatewayUpsertOptsFromRelease, type DurableGateway } from "./converge-gateway.js";
import { sharedRuntimeIntentForValues, type HelmRunner } from "./helm-runner.js";

export type GatewayDeploymentSettings = Omit<Parameters<typeof gatewayUpsertOptsFromRelease>[0],
  "gateway" | "artifact" | "replicas" | "hobbyCheckpoint">;

export function gatewayDeploymentSettings(input: {
  namespace: string; environment: ReturnType<typeof deploymentSettingsForRuntime>;
  chartPath: string; valuesFile: string; chartFingerprint: string;
}): GatewayDeploymentSettings {
  const { namespace, environment, chartPath, valuesFile, chartFingerprint } = input;
  return {
    namespace, chartPath, valuesFile, chartFingerprint,
    kmsKeyName: environment.kmsKeyName,
    deploymentTargetId: environment.targetId,
    deploymentProjectId: environment.firebaseProjectId,
    gatewayServiceAccount: environment.firebaseProjectId
      ? `octogee-gateway@${environment.firebaseProjectId}.iam.gserviceaccount.com` : undefined,
  };
}

type Image = Pick<ReleasePayload, "imageRepository" | "imageTag">;

function sameRuntimeImage(current: Image | undefined, requested: Image | undefined): boolean {
  if (!current || !requested || current.imageRepository !== requested.imageRepository) return false;
  const tagged = /^[a-f0-9]{7,40}(-oc[a-z0-9][a-z0-9.-]*)?@(sha256:[a-f0-9]{64})$/;
  const first = tagged.exec(current.imageTag);
  const second = tagged.exec(requested.imageTag);
  return !!first && !!second && first[1] === second[1] && first[2] === second[2];
}

function sameSharedSoftware(current: ReleasePayload, requested: ReleasePayload): boolean {
  return isReleasePayload(current) && isReleasePayload(requested) && !!current.openclawSourceSha &&
    current.openclawSourceSha === requested.openclawSourceSha && sameRuntimeImage(current, requested) &&
    sameRuntimeImage(current.gatewayEdgeImage, requested.gatewayEdgeImage);
}

export function installedSharedOptions(input: {
  gateway: DurableGateway; current: ReleasePayload; requested: ReleasePayload; instance: HelmInstanceValue | null;
  settings: GatewayDeploymentSettings; values: Buffer | null;
}) {
  const { gateway, current, requested, instance } = input;
  if (gateway.gatewayClass !== "shared" || gateway.desiredStatus !== "running" ||
    gateway.latestRelease !== gateway.liveRelease || gateway.desiredRelease !== gateway.liveRelease ||
    !sameSharedSoftware(current, requested) || !instance?.sharedRuntimeIntent) return null;
  const opts = gatewayUpsertOptsFromRelease({ ...input.settings, gateway, artifact: current, replicas: 1 });
  const matching = [
    instance.gatewayId === gateway.gatewayId, instance.gatewayClass === "shared",
    instance.image.repository === opts.imageRepository, instance.image.tag === opts.imageTag,
    instance.gatewayEdgeImage?.imageRepository === opts.gatewayEdgeImageRepository,
    instance.gatewayEdgeImage?.imageTag === opts.gatewayEdgeImageTag,
    instance.chartFingerprint === opts.chartFingerprint,
    instance.deploymentIntentFingerprint === opts.deploymentIntentFingerprint,
    instance.sharedRuntimeIntent.fingerprint === sharedRuntimeIntentForValues(opts, input.values),
  ].every(Boolean);
  return matching ? { ...opts, sharedRuntimeIntent: instance.sharedRuntimeIntent.fingerprint } : null;
}

export const SHARED_RELEASE_OBSERVATION_GRACE_MS = 10 * 60_000;

function remember<V>(entries: Map<string, V>, key: string, value: V): void {
  entries.delete(key);
  if (entries.size >= 256) entries.delete(entries.keys().next().value!);
  entries.set(key, value);
}

export function installedSharedReleaseReader(
  settings: GatewayDeploymentSettings, helm: HelmRunner, log: (message: string) => void, now: () => number = Date.now,
) {
  const slots = Array.from({ length: 4 }, () => Promise.resolve());
  const accepted = new Map<string, string>();
  const verified = new Map<string, { inputs: string; at: number }>();
  const active = new Map<string, Promise<boolean>>();

  async function verify(gateway: DurableGateway, current: ReleasePayload, requested: ReleasePayload) {
    if (!helm.readSharedInstallation || !helm.matchesDeployedManifest) return false;
    const [observed, values] = await Promise.all([
      helm.readSharedInstallation({ namespace: settings.namespace, gatewayId: gateway.gatewayId }),
      settings.valuesFile ? readFile(settings.valuesFile) : null,
    ]);
    const receipt = observed?.instance.sharedRuntimeIntent;
    if (!observed || !receipt) return false;
    const opts = installedSharedOptions({ gateway, current, requested, instance: observed.instance, settings, values });
    if (!opts) return false;
    const key = JSON.stringify([receipt.helmRevision, opts.sharedRuntimeIntent, observed.manifestDigest, releasePayloadHash(requested)]);
    if (accepted.get(gateway.gatewayId) === key) return true;
    if (!await helm.matchesDeployedManifest(opts, receipt.helmRevision)) return false;
    remember(accepted, gateway.gatewayId, key);
    return true;
  }

  async function inspect(gateway: DurableGateway, current: ReleasePayload, requested: ReleasePayload, inputs: string) {
    try {
      const installed = await verify(gateway, current, requested);
      if (installed) remember(verified, gateway.gatewayId, { inputs, at: now() });
      else verified.delete(gateway.gatewayId);
      return installed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const earlier = verified.get(gateway.gatewayId);
      const retained = earlier?.inputs === inputs && now() - earlier.at <= SHARED_RELEASE_OBSERVATION_GRACE_MS;
      log(`[shared-release] cannot verify installed release for ${gateway.gatewayId}${retained ? ", keeping its verification from " +
        new Date(earlier.at).toISOString() : ""}: ${message.slice(0, 500)}`);
      return retained;
    }
  }

  return (gateway: DurableGateway, current: ReleasePayload, requested: ReleasePayload): Promise<boolean> => {
    if (!sameSharedSoftware(current, requested)) return Promise.resolve(false);
    const key = JSON.stringify([gateway, current, requested]);
    const pending = active.get(key);
    if (pending) return pending;
    const result = slots.shift()!.then(() => inspect(gateway, current, requested, key)).finally(() => active.delete(key));
    active.set(key, result);
    slots.push(result.then(() => undefined, () => undefined));
    return result;
  };
}
