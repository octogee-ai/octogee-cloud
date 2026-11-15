import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import {
  isGatewayEdgeImage,
  isReleasePayload,
  PLATFORM_RELEASE_RECORD_DOC_PATH,
  platformReleaseRecord,
} from "@octogee/shared/types/gateway-releases";
import { isGatewayImageTag } from "@octogee/shared/types/image-tag";
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
