import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { describe, expect, it, vi } from "vitest";
import {
  isReleasePayload,
  PLATFORM_RELEASE_RECORD_DOC_PATH,
  releasePayloadHash,
} from "@octogee/shared/types/gateway-releases";
import {
  platformGatewayArtifactFromEnvironment,
  sharedPoolReplicaBoundsFromEnvironment,
  writePlatformReleaseRecord,
} from "../platform-release.js";

const REPOSITORY = "us-central1-docker.pkg.dev/octogee/octogee";
const env = {
  PLATFORM_GATEWAY_IMAGE_REPOSITORY: `${REPOSITORY}/octogee-gateway`,
  PLATFORM_GATEWAY_IMAGE_TAG: `a0180aa@sha256:${"a".repeat(64)}`,
  PLATFORM_GATEWAY_BUILDER_IMAGE_TAG: `a0180aa@sha256:${"b".repeat(64)}`,
  PLATFORM_GATEWAY_EDGE_IMAGE_REPOSITORY: `${REPOSITORY}/gateway-edge`,
  PLATFORM_GATEWAY_EDGE_IMAGE_TAG: `a0180aa@sha256:${"c".repeat(64)}`,
};

describe("platformGatewayArtifactFromEnvironment", () => {
  it("builds a complete release payload including the isolated image disposable allocations need", () => {
    const artifact = platformGatewayArtifactFromEnvironment(env);
    expect(artifact).toEqual({
      imageRepository: `${REPOSITORY}/octogee-gateway`,
      imageTag: env.PLATFORM_GATEWAY_IMAGE_TAG,
      profileImages: {
        isolated: {
          imageRepository: `${REPOSITORY}/octogee-gateway-builder`,
          imageTag: env.PLATFORM_GATEWAY_BUILDER_IMAGE_TAG,
        },
      },
      gatewayEdgeImage: {
        imageRepository: `${REPOSITORY}/gateway-edge`,
        imageTag: env.PLATFORM_GATEWAY_EDGE_IMAGE_TAG,
      },
    });
    expect(isReleasePayload(artifact)).toBe(true);
  });

  it("carries the OpenClaw fork sha only when it is a full commit", () => {
    expect(platformGatewayArtifactFromEnvironment({ ...env, OPENCLAW_FORK_SHA: "f".repeat(40) }))
      .toMatchObject({ openclawSourceSha: "f".repeat(40) });
    expect(platformGatewayArtifactFromEnvironment({ ...env, OPENCLAW_FORK_SHA: "n/a" }))
      .not.toHaveProperty("openclawSourceSha");
  });

  it.each([
    ["PLATFORM_GATEWAY_IMAGE_TAG", "latest"],
    ["PLATFORM_GATEWAY_BUILDER_IMAGE_TAG", ""],
    ["PLATFORM_GATEWAY_BUILDER_IMAGE_TAG", `other12@sha256:${"b".repeat(64)}`],
    ["PLATFORM_GATEWAY_EDGE_IMAGE_TAG", `a0180aa@sha256:${"c".repeat(63)}`],
    ["PLATFORM_GATEWAY_EDGE_IMAGE_REPOSITORY", `${REPOSITORY}/octogee-api`],
  ])("fails closed when %s is %j", (name, value) => {
    expect(() => platformGatewayArtifactFromEnvironment({ ...env, [name]: value })).toThrow();
  });
});

describe("sharedPoolReplicaBoundsFromEnvironment", () => {
  it("parses the environment floor and ceiling and rejects an inverted pair", () => {
    expect(sharedPoolReplicaBoundsFromEnvironment({
      SHARED_POOL_MIN_REPLICAS: "0",
      SHARED_POOL_MAX_REPLICAS: "8",
    })).toEqual({ minReplicas: 0, maxReplicas: 8 });
    expect(() => sharedPoolReplicaBoundsFromEnvironment({
      SHARED_POOL_MIN_REPLICAS: "3",
      SHARED_POOL_MAX_REPLICAS: "2",
    })).toThrow("SHARED_POOL_MIN_REPLICAS");
  });
});

describe("writePlatformReleaseRecord", () => {
  it("records the running platform build and its release payload hash for other placers", async () => {
    const artifact = platformGatewayArtifactFromEnvironment({ ...env, OPENCLAW_FORK_SHA: "f".repeat(40) });
    const documents: Record<string, Record<string, unknown>> = {};

    await writePlatformReleaseRecord({ store: createDocumentFixtureStore(documents), artifact, now: () => 1_234, log: vi.fn() });

    expect(documents).toEqual({
      [PLATFORM_RELEASE_RECORD_DOC_PATH]: {
        schemaVersion: 1,
        payloadHash: releasePayloadHash(artifact),
        imageTag: env.PLATFORM_GATEWAY_IMAGE_TAG,
        openclawSourceSha: "f".repeat(40),
        writtenAt: 1_234,
      },
    });
  });

  it("logs and rethrows when the record cannot be written", async () => {
    const artifact = platformGatewayArtifactFromEnvironment(env);
    const log = vi.fn();
    const store = createDocumentFixtureStore({});
    vi.spyOn(store.controllerState.platformRelease, "put").mockRejectedValue(new Error("permission denied"));

    await expect(writePlatformReleaseRecord({ store, artifact, now: () => 1, log }))
      .rejects.toThrow("permission denied");
    expect(log).toHaveBeenCalledWith(
      `[glm-controller] platform release record ${PLATFORM_RELEASE_RECORD_DOC_PATH} write failed: permission denied`,
    );
  });
});
