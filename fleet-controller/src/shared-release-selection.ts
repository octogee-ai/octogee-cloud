import type { deploymentSettingsForRuntime } from "@octogee/core/deployment-environment";
import { readFile } from "node:fs/promises";
import { isReleasePayload, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
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

export function installedSharedReleaseReader(settings: GatewayDeploymentSettings, helm: HelmRunner, log: (message: string) => void) {
  return async (gateway: DurableGateway, current: ReleasePayload, requested: ReleasePayload): Promise<boolean> => {
    if (!sameSharedSoftware(current, requested)) return false;
    try {
      const [instance, values] = await Promise.all([
        helm.readDeployedInstance({ namespace: settings.namespace, gatewayId: gateway.gatewayId }),
        settings.valuesFile ? readFile(settings.valuesFile) : null,
      ]);
      const opts = installedSharedOptions({ gateway, current, requested, instance, settings, values });
      if (!opts || !instance?.sharedRuntimeIntent || !helm.matchesDeployedManifest) return false;
      return await helm.matchesDeployedManifest(opts, instance.sharedRuntimeIntent.helmRevision);
    } catch (error) {
      log(`[shared-release] cannot verify installed release for ${gateway.gatewayId}: ${error instanceof Error ? error.name : "unknown error"}`);
      return false;
    }
  };
}
