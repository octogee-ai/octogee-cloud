import { describe, expect, it } from "vitest";
import { assertRecoveryImages } from "../lib/shared-restore-runtime.js";

const SOURCE_SHA = "a0180aa" + "0".repeat(33);
const REGISTRY = "registry.example/operator";
const release = {
  imageRepository: `${REGISTRY}/octogee-gateway`,
  gatewayEdgeImage: { imageRepository: `${REGISTRY}/gateway-edge` },
};
const images = {
  gateway: `${REGISTRY}/octogee-gateway:a0180aa@sha256:${"a".repeat(64)}`,
  "gateway-edge": `${REGISTRY}/gateway-edge:a0180aa@sha256:${"c".repeat(64)}`,
};

describe("assertRecoveryImages", () => {
  it("accepts digest-addressed images from the deployed release's own registry", () => {
    expect(() => assertRecoveryImages(images, SOURCE_SHA, release)).not.toThrow();
  });

  it.each([
    ["a tag-addressed gateway image", { ...images, gateway: `${REGISTRY}/octogee-gateway:a0180aa` }, "gateway", `${REGISTRY}/octogee-gateway:a0180aa`],
    ["a gateway image from another registry", { ...images, gateway: `registry.example/other/octogee-gateway:a0180aa@sha256:${"a".repeat(64)}` }, "gateway", `registry.example/other/octogee-gateway:a0180aa@sha256:${"a".repeat(64)}`],
    ["a gateway-edge image from another repository", { ...images, "gateway-edge": `${REGISTRY}/gateway-edge-other:a0180aa@sha256:${"c".repeat(64)}` }, "gateway-edge", `${REGISTRY}/gateway-edge-other:a0180aa@sha256:${"c".repeat(64)}`],
    ["an image from another build", { ...images, gateway: `${REGISTRY}/octogee-gateway:b0180aa@sha256:${"a".repeat(64)}` }, "gateway", `${REGISTRY}/octogee-gateway:b0180aa@sha256:${"a".repeat(64)}`],
  ])("refuses %s, naming the image and the deployed repository", (_label, candidate, name, image) => {
    const repository = name === "gateway" ? release.imageRepository : release.gatewayEdgeImage.imageRepository;
    expect(() => assertRecoveryImages(candidate, SOURCE_SHA, release)).toThrow(
      `restore recovery requires digest-addressed images from the deployed build: ${name} image ${image} is not ${repository}:a0180aa…@sha256:<digest>`,
    );
  });

  it("refuses a missing image", () => {
    expect(() => assertRecoveryImages({ gateway: images.gateway }, SOURCE_SHA, release)).toThrow(
      "restore recovery requires digest-addressed images from the deployed build: gateway-edge image undefined",
    );
  });
});
