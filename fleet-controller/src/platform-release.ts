import { GATEWAY_CONFIG_SCHEMA_VERSION } from "@octogee/shared/types/gateway-mutable-config";
import type { GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import {
  isGatewayEdgeImage,
  isReleasePayload,
  PLATFORM_RELEASE_RECORD_DOC_PATH,
  platformReleaseRecord,
} from "@octogee/shared/types/gateway-releases";
import { isGatewayImageTag } from "@octogee/shared/types/image-tag";
import {
  parseSharedPoolReplicaBounds,
  type SharedPoolReplicaBounds,
} from "@octogee/shared/types/shared-gateway-pool";
import type { GatewayArtifact } from "@octogee/core/gateway-live-release";

export type PlatformReleaseEnvironment = Record<string, string | undefined>;

function requiredEnv(env: PlatformReleaseEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required: the platform release publishes the shared pool image`);
  return value;
}

// The umbrella Helm upgrade sets these from the deployed build's immutable
// digest manifest. The fleet controller converges every shared slot to this artifact.
export function platformGatewayArtifactFromEnvironment(
  env: PlatformReleaseEnvironment = process.env,
): GatewayArtifact {
  const imageRepository = requiredEnv(env, "PLATFORM_GATEWAY_IMAGE_REPOSITORY");
  const imageTag = requiredEnv(env, "PLATFORM_GATEWAY_IMAGE_TAG");
  if (!isGatewayImageTag(imageTag)) {
    throw new Error("PLATFORM_GATEWAY_IMAGE_TAG must be an immutable gateway image tag");
  }
  const gatewayEdgeImage = {
    imageRepository: requiredEnv(env, "PLATFORM_GATEWAY_EDGE_IMAGE_REPOSITORY"),
    imageTag: requiredEnv(env, "PLATFORM_GATEWAY_EDGE_IMAGE_TAG"),
  };
  if (!isGatewayImageTag(gatewayEdgeImage.imageTag) || !isGatewayEdgeImage(gatewayEdgeImage, imageRepository)) {
    throw new Error(
      "PLATFORM_GATEWAY_EDGE_IMAGE_REPOSITORY and PLATFORM_GATEWAY_EDGE_IMAGE_TAG must identify the paired immutable gateway-edge image",
    );
  }
  const builderImageTag = requiredEnv(env, "PLATFORM_GATEWAY_BUILDER_IMAGE_TAG");
  const openclawSourceSha = env.OPENCLAW_FORK_SHA?.trim();
  const artifact: GatewayArtifact = {
    imageRepository,
    imageTag,
    profileImages: {
      isolated: {
        imageRepository: `${imageRepository.replace(/\/octogee-gateway$/, "")}/octogee-gateway-builder`,
        imageTag: builderImageTag,
      },
    },
    gatewayEdgeImage,
    ...(openclawSourceSha && /^[a-f0-9]{40}$/.test(openclawSourceSha) ? { openclawSourceSha } : {}),
  };
  if (!isReleasePayload(artifact)) {
    throw new Error(
      "PLATFORM_GATEWAY_* must describe one build's paired immutable gateway, gateway-builder, and gateway-edge images",
    );
  }
  return artifact;
}

export async function writePlatformReleaseRecord(input: {
  store: Pick<PlatformStateRepositories, "controllerState">;
  artifact: GatewayArtifact;
  now(): number;
  log(message: string): void;
}): Promise<void> {
  try {
    await input.store.controllerState.platformRelease.put(platformReleaseRecord(input.artifact, input.now()));
  } catch (error) {
    input.log(
      `[glm-controller] platform release record ${PLATFORM_RELEASE_RECORD_DOC_PATH} write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

export function sharedPoolReplicaBoundsFromEnvironment(
  env: PlatformReleaseEnvironment = process.env,
): SharedPoolReplicaBounds {
  const bounds = parseSharedPoolReplicaBounds({
    minReplicas: env.SHARED_POOL_MIN_REPLICAS,
    maxReplicas: env.SHARED_POOL_MAX_REPLICAS,
  });
  if (bounds === null) {
    throw new Error(
      "SHARED_POOL_MIN_REPLICAS and SHARED_POOL_MAX_REPLICAS must be integers with 0 <= min <= max and max >= 1",
    );
  }
  return bounds;
}

export function sharedSlotMutableConfig(): GatewayMutableConfig {
  return {
    configSchemaVersion: GATEWAY_CONFIG_SCHEMA_VERSION,
    profile: null,
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    modelBrokerLimits: null,
  };
}
