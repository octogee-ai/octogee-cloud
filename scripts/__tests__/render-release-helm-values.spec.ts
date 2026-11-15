import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { centralGatewayReleasePayload, type ReleaseDigestManifest } from "@octogee/core/artifact-registry";
import { renderReleaseHelmValues } from "../ops/render-release-helm-values.js";

const sourceSha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const manifest: ReleaseDigestManifest = {
  sourceSha, openclawSourceSha: "c".repeat(40), openclawVersion: "2026.9.8",
  manifestDigest: digest, repository: "us-central1-docker.pkg.dev/octogee/octogee",
  surfaces: {
    gateway: Object.fromEntries(["gateway-edge", "octogee-gateway", "octogee-gateway-builder"].map(name => [name, digest])),
    platform: Object.fromEntries(["glm-controller", "octogee-api", "artifact-worker", "octogee-ops-agent", "octogee-project-runner"].map(name => [name, digest])),
  },
};

describe("operator Helm release selection", () => {
  it("resolves one selected immutable manifest and pins the fleet controller, its source, and every image to that family", async () => {
    const resolveManifest = vi.fn(async () => manifest);
    const values = JSON.parse(await renderReleaseHelmValues(sourceSha, { resolveManifest }));
    expect(resolveManifest).toHaveBeenCalledExactlyOnceWith(sourceSha);
    expect(values["glm-controller"]).toMatchObject({
      image: { repository: `${manifest.repository}/glm-controller`, tag: sourceSha.slice(0, 7), digest },
      platformRelease: { sourceSha, openclawSourceSha: manifest.openclawSourceSha,
        gatewayImageTag: `${sourceSha.slice(0, 7)}-oc${manifest.openclawVersion}@${digest}`, builderImageTag: `${sourceSha.slice(0, 7)}-oc${manifest.openclawVersion}@${digest}`,
        gatewayEdgeImageTag: `${sourceSha.slice(0, 7)}-oc${manifest.openclawVersion}@${digest}` },
    });
    for (const key of ["octogee-api", "llmBroker", "artifactWorker", "opsAgent", "gateway-edge"]) {
      expect(values[key].image).toMatchObject({ tag: sourceSha.slice(0, 7), digest });
    }
    expect(values.global.projectRunnerImage).toMatchObject({ tag: sourceSha.slice(0, 7), digest });
  });

  it("offers every platform image of the selected family to the chart by name", async () => {
    const selected = structuredClone(manifest);
    selected.surfaces.platform["automation"] = `sha256:${"f".repeat(64)}`;
    const values = JSON.parse(await renderReleaseHelmValues(sourceSha, { resolveManifest: async () => selected }));
    expect(Object.keys(values.releaseImages)).toEqual(Object.keys(selected.surfaces.platform).sort());
    expect(values.releaseImages.automation).toEqual({
      repository: `${manifest.repository}/automation`, tag: sourceSha.slice(0, 7), digest: `sha256:${"f".repeat(64)}`,
    });
  });

  it("gives Shared allocation the exact canonical family used by user deployment", async () => {
    const selected = structuredClone(manifest);
    selected.surfaces.gateway["octogee-gateway-builder"] = `sha256:${"d".repeat(64)}`;
    selected.surfaces.gateway["gateway-edge"] = `sha256:${"e".repeat(64)}`;
    const values = JSON.parse(await renderReleaseHelmValues(sourceSha, { resolveManifest: async () => selected }));
    const platform = values["glm-controller"].platformRelease;
    expect({
      imageRepository: platform.gatewayImageRepository,
      imageTag: platform.gatewayImageTag,
      openclawSourceSha: platform.openclawSourceSha,
      profileImages: { isolated: {
        imageRepository: `${selected.repository}/octogee-gateway-builder`,
        imageTag: platform.builderImageTag,
      } },
      gatewayEdgeImage: {
        imageRepository: platform.gatewayEdgeImageRepository,
        imageTag: platform.gatewayEdgeImageTag,
      },
    }).toEqual(centralGatewayReleasePayload(selected));
  });

  it.each(["", "abc1234", "g".repeat(40)])("rejects an invalid source before resolving or provisioning: %s", async sha => {
    const resolveManifest = vi.fn();
    await expect(renderReleaseHelmValues(sha, { resolveManifest })).rejects.toThrow("full 40-character source SHA");
    expect(resolveManifest).not.toHaveBeenCalled();
    const result = spawnSync("bash", [resolve(import.meta.dirname, "../provision-namespace.sh"), "synthetic-identity-check", `--sha=${sha}`], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("before any destructive step");
  });

  it("rejects a mismatched manifest instead of assigning the requested identity to different bytes", async () => {
    await expect(renderReleaseHelmValues(sourceSha, { resolveManifest: async () => ({ ...manifest, sourceSha: "d".repeat(40) }) }))
      .rejects.toThrow("differs from the selected source SHA");
  });

  it("propagates an unavailable manifest without emitting partial values", async () => {
    await expect(renderReleaseHelmValues(sourceSha, { resolveManifest: async () => { throw new Error("manifest unavailable"); } }))
      .rejects.toThrow("manifest unavailable");
  });

  it.each(["glm-controller", "octogee-project-runner"])("rejects a missing %s image", async name => {
    const broken = structuredClone(manifest); delete broken.surfaces.platform[name];
    await expect(renderReleaseHelmValues(sourceSha, { resolveManifest: async () => broken })).rejects.toThrow(`missing ${name}`);
  });

  it("rejects a release without native source provenance", async () => {
    await expect(renderReleaseHelmValues(sourceSha, { resolveManifest: async () => ({ ...manifest, openclawSourceSha: undefined }) }))
      .rejects.toThrow("missing its OpenClaw source SHA");
  });
});
