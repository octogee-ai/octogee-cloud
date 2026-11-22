import { describe, expect, it } from "vitest";
import type { ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { guestReleaseImagesMatch, guestReleaseInstalled } from "./guest-release.js";

const repo = "registry/images/octogee-gateway";
const edgeRepo = "registry/images/gateway-edge";
const gateway = "sha256:" + "a".repeat(64);
const edge = "sha256:" + "b".repeat(64);
const release = (tag: string, sha = "c".repeat(40)): ReleasePayload => ({
  imageRepository: repo, imageTag: `${tag}@sha256:${"d".repeat(64)}`, openclawSourceSha: sha,
  profileImages: { isolated: { imageRepository: repo + "-builder", imageTag: `${tag}@${gateway}` } },
  gatewayEdgeImage: { imageRepository: edgeRepo, imageTag: `${tag}@${edge}` },
});
const proof = {
  instanceId: "123", observedAt: 1_000, containers: [
    { name: "gateway", running: true, imageReference: `${repo}-builder:old@${gateway}`, digests: [`${repo}-builder@${gateway}`] },
    { name: "gateway-edge", running: true, imageReference: `${edgeRepo}:old@${edge}`, digests: [`${edgeRepo}@${edge}`] },
  ],
};

describe("retained guest release identity", () => {
  it("keeps the same installed bytes across a cosmetic product tag and a Shared-only gateway change", () => {
    const candidate = { ...release("new"), imageTag: `new@sha256:${"e".repeat(64)}` };
    expect(guestReleaseImagesMatch(release("old"), candidate)).toBe(true);
    expect(guestReleaseInstalled(candidate, "123", proof, 900)).toBe(true);
  });

  it("requires an exact edge digest, repository, and OpenClaw provenance", () => {
    expect(guestReleaseImagesMatch(release("old"), release("new", "d".repeat(40)))).toBe(false);
    expect(guestReleaseImagesMatch(release("old"), { ...release("new"), gatewayEdgeImage: undefined })).toBe(false);
    expect(guestReleaseInstalled(release("new"), "123", { ...proof,
      containers: [proof.containers[0], { ...proof.containers[1], digests: ["other@" + edge] }],
    }, 900)).toBe(false);
  });

  it("requires fresh exact installed images under the same VM identity", () => {
    expect(guestReleaseInstalled(release("new"), "other", proof, 900)).toBe(false);
    expect(guestReleaseInstalled(release("new"), "123", proof, 1_001)).toBe(false);
  });
});
