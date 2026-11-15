import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  chartVersionExists,
  expectedReferences,
  gatewayReleaseValues,
  placeholderManifest,
  platformReleaseValues,
  publishCharts,
  stampValues,
} from "../ci/release-charts.mjs";

const registry = "ghcr.io/octogee-ai/octogee-cloud";
const sha = "c".repeat(40);
const digest = (n: number) => `sha256:${String(n).repeat(64)}`;
const manifest = {
  sha, registry,
  images: {
    "glm-controller": { digest: digest(1) },
    "octogee-api": { digest: digest(2) },
    "gateway-edge": { digest: digest(3) },
    "octogee-gateway": { digest: digest(4) },
    "octogee-gateway-builder": { digest: digest(5) },
    "vm-bridge": { digest: digest(6) },
  },
};
const openclawSourceSha = "d".repeat(40);

describe("platform chart release values", () => {
  const values = platformReleaseValues({ tag: "v0.2.0", manifest, openclawSourceSha });

  it("pins each platform service to its release tag and index digest", () => {
    expect(values["glm-controller"].image).toEqual({ repository: `${registry}/glm-controller`, tag: "v0.2.0", digest: digest(1) });
    expect(values["octogee-api"].image).toEqual({ repository: `${registry}/octogee-api`, tag: "v0.2.0", digest: digest(2) });
    expect(values.llmBroker.image).toEqual(values["octogee-api"].image);
    expect(values["gateway-edge"].image.digest).toBe(digest(3));
    expect(values.global.computer.bridge.image.digest).toBe(digest(6));
  });

  it("gives the fleet controller the release's gateway images by commit tag, the form gateway image tags take", () => {
    expect(values["glm-controller"].platformRelease).toEqual({
      sourceSha: sha,
      gatewayImageRepository: `${registry}/octogee-gateway`,
      gatewayImageTag: `ccccccc@${digest(4)}`,
      builderImageTag: `ccccccc@${digest(5)}`,
      gatewayEdgeImageRepository: `${registry}/gateway-edge`,
      gatewayEdgeImageTag: `ccccccc@${digest(3)}`,
      openclawSourceSha,
    });
  });

  it("refuses a manifest that lacks an image or a commit", () => {
    const { "vm-bridge": _bridge, ...images } = manifest.images;
    expect(() => platformReleaseValues({ tag: "v0.2.0", manifest: { ...manifest, images }, openclawSourceSha }))
      .toThrow("no index digest for vm-bridge");
    expect(() => platformReleaseValues({ tag: "v0.2.0", manifest: { ...manifest, sha: "abc" }, openclawSourceSha }))
      .toThrow("names no full commit SHA");
  });

  it("lists every image reference the rendered chart must contain", () => {
    const references = expectedReferences(values);
    expect(references).toContain(`${registry}/glm-controller:v0.2.0@${digest(1)}`);
    expect(references).toContain(`${registry}/vm-bridge:v0.2.0@${digest(6)}`);
    expect(references).toContain(`ccccccc@${digest(5)}`);
  });
});

describe("gateway chart release values", () => {
  it("defaults the gateway and its edge sidecar to the release's images", () => {
    expect(gatewayReleaseValues({ tag: "v0.2.0", manifest })).toEqual({
      image: { repository: `${registry}/octogee-gateway` },
      imageTag: `ccccccc@${digest(4)}`,
      gatewayEdge: { image: { repository: `${registry}/gateway-edge`, tag: `ccccccc@${digest(3)}` } },
    });
  });
});

describe("values stamping", () => {
  it("sets the release values and keeps the rest of values.yaml with its comments", () => {
    const source = "# defaults\nglobal:\n  logLevel: info\n  computer:\n    bridge:\n      image:\n        tag: \"\"  # set per release\n";
    const stamped = stampValues(source, { global: { computer: { bridge: { image: { tag: "v0.2.0", digest: digest(6) } } } }, opsAgent: { enabled: false } });
    expect(stamped).toContain("# defaults");
    expect(stamped).toContain("# set per release");
    expect(parse(stamped)).toEqual({
      global: { logLevel: "info", computer: { bridge: { image: { tag: "v0.2.0", digest: digest(6) } } } },
      opsAgent: { enabled: false },
    });
  });

  it("does not fold long digests across lines", () => {
    expect(stampValues("a: \"\"\n", { a: `ccccccc@${digest(4)}` })).toBe(`a: "ccccccc@${digest(4)}"\n`);
  });
});

describe("placeholder manifest", () => {
  it("names a distinct digest for every platform image so a check can render the chart", () => {
    const placeholder = placeholderManifest();
    expect(() => platformReleaseValues({ tag: "v0.0.0", manifest: placeholder, openclawSourceSha })).not.toThrow();
    expect(new Set(Object.values(placeholder.images).map(image => image.digest)).size).toBe(Object.keys(placeholder.images).length);
  });
});

describe("chart push", () => {
  const out = mkdtempSync(join(tmpdir(), "release-charts-"));
  writeFileSync(join(out, "charts.json"), JSON.stringify([
    { name: "octogee", version: "0.2.0", directory: "helm/octogee", archive: "/release/octogee-0.2.0.tgz" },
    { name: "octogee-gateway", version: "0.2.0", directory: "helm/octogee-gateway", archive: "/release/octogee-gateway-0.2.0.tgz" },
  ]));

  it("treats a chart package GitHub has not created yet as unpublished, so the push that follows creates it or fails", () => {
    const denied = 'Error: GET "https://ghcr.io/token?scope=repository%3Aoctogee-ai%2Foctogee-cloud%2Fcharts%2Foctogee%3Apull&service=ghcr.io": response status code 403: denied: requested access to the resource is denied';
    expect(chartVersionExists("octogee", "0.2.0", () => ({ status: 1, stdout: "", stderr: denied }))).toBe(false);
  });

  it("treats a missing chart version as unpublished and fails on any other registry error", () => {
    expect(chartVersionExists("octogee", "0.2.0", () => ({ status: 0, stdout: "name: octogee", stderr: "" }))).toBe(true);
    expect(chartVersionExists("octogee", "0.2.0", () => ({ status: 1, stdout: "", stderr: "Error: ghcr.io/octogee-ai/octogee-cloud/charts/octogee:0.2.0: not found" }))).toBe(false);
    expect(() => chartVersionExists("octogee", "0.2.0", () => ({ status: 1, stdout: "", stderr: "Error: unauthorized" })))
      .toThrow("helm show chart octogee 0.2.0 failed");
  });

  it("pushes the charts a previous run did not, to the charts repository", () => {
    const helm = vi.fn();
    const outcomes = publishCharts({ out, exists: (name: string) => name === "octogee", helm });
    expect(outcomes).toEqual([{ name: "octogee", published: false }, { name: "octogee-gateway", published: true }]);
    expect(helm).toHaveBeenCalledExactlyOnceWith(["push", "/release/octogee-gateway-0.2.0.tgz", `oci://${registry}/charts`]);
  });
});
