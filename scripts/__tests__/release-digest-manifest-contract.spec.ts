import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReleaseDigestManifest } from "../../../.github/actions/release-digest-manifest/release-digest-manifest.mjs";
import { createCentralReleaseAuthority } from "@octogee/core/artifact-registry";

/**
 * The generator and the release authority are one contract split across two
 * packages, and nothing used to hold them together: a partial revert
 * (9659ddc49) took the generator back to schemaVersion 1 with four platform
 * images while the authority kept demanding schemaVersion 3 and a fifth image
 * no build produces. Every deployment then failed on a manifest our own
 * generator had just written. This is the test that would have caught it.
 */

const sourceSha = "a".repeat(40);
const openclawSourceSha = "c".repeat(40);
const manifestDigest = `sha256:${"b".repeat(64)}`;
const repository = "us-central1-docker.pkg.dev/octogee/octogee";
const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

// Exactly the images the release workflow builds and passes to the generator.
const BUILT_IMAGES = {
  "artifact-worker": digest("1"),
  "gateway-edge": digest("2"),
  "glm-controller": digest("3"),
  "octogee-api": digest("4"),
  "octogee-gateway": digest("5"),
  "octogee-gateway-builder": digest("6"),
  "octogee-ops-agent": digest("7"),
  "octogee-project-runner": digest("8"),
};

function tarFile(name: string, contents: string): Uint8Array {
  const body = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const length = Math.ceil(body.length / 512) * 512;
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(length - body.length), Buffer.alloc(1024)]));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Serves `manifest` as the archive the authority fetches for `sourceSha`. */
function serveManifest(manifest: unknown): void {
  fetchMock
    .mockResolvedValueOnce(jsonResponse({
      version:
        `projects/octogee/locations/us-central1/repositories/octogee` +
        `/packages/release-digest-manifest/versions/${manifestDigest}`,
    }))
    .mockResolvedValueOnce(jsonResponse({
      schemaVersion: 2,
      layers: [{ digest: `sha256:${"f".repeat(64)}` }],
    }))
    .mockResolvedValueOnce(new Response(tarFile(
      "release-digest-manifest.json",
      JSON.stringify(manifest),
    )));
}

describe("release digest manifest — generator/authority contract", () => {
  // No Application Default Credentials in CI — and this contract must hold
  // regardless of whose cloud identity runs it.
  const authority = () => createCentralReleaseAuthority(
    { project: "octogee", location: "us-central1", repository: "octogee" },
    { getAccessToken: async () => "test-token" },
  );

  it("accepts a manifest the generator actually produces", async () => {
    serveManifest(createReleaseDigestManifest({
      sourceSha,
      openclawVersion: "2026.7.2-beta.7",
      openclawSourceSha,
      repository,
      images: BUILT_IMAGES,
    }));

    const resolved = await authority().resolveManifest(sourceSha);

    expect(resolved.sourceSha).toBe(sourceSha);
    expect(resolved.openclawVersion).toBe("2026.7.2-beta.7");
    expect(resolved.openclawSourceSha).toBe(openclawSourceSha);
  });

  it("carries every built image through to the resolved surfaces, and nothing else", async () => {
    serveManifest(createReleaseDigestManifest({
      sourceSha,
      openclawVersion: "2026.7.2-beta.7",
      openclawSourceSha,
      repository,
      images: BUILT_IMAGES,
    }));

    const resolved = await authority().resolveManifest(sourceSha);

    // No entry the release workflow cannot build: a surface image with no
    // build definition can never appear in a manifest, so demanding one makes
    // every cut unsatisfiable.
    expect(Object.keys(resolved.surfaces.gateway).sort()).toEqual([
      "gateway-edge",
      "octogee-gateway",
      "octogee-gateway-builder",
    ]);
    expect(Object.keys(resolved.surfaces.platform).sort()).toEqual([
      "artifact-worker",
      "glm-controller",
      "octogee-api",
      "octogee-ops-agent",
      "octogee-project-runner",
    ]);
  });

  it("refuses a pre-RC v1 manifest by naming the gateway image it lacks", async () => {
    // Byte-shape of release-digest-manifest:c797802e2… — the manifest behind
    // the release running in TEST. The refusal is about absent bytes, not a
    // version number: octogee-gateway-builder is the renamed
    // octogee-gateway-operator, and those images were never pushed under the
    // new package name, so a v1 manifest cannot supply the digest the gateway
    // release needs. Everything else about a v1 manifest resolves fine.
    // Operational consequence: the first PROD promotion after this ships must
    // use a build whose manifest carries the isolated image.
    serveManifest({
      schemaVersion: 1,
      sourceSha,
      openclawVersion: "2026.7.2-beta.7",
      repository,
      surfaces: {
        gateway: {
          "gateway-edge": digest("2"),
          "octogee-gateway": digest("5"),
          "octogee-gateway-operator": digest("6"),
        },
        platform: {
          "artifact-worker": digest("1"),
          "glm-controller": digest("3"),
          "octogee-api": digest("4"),
          "octogee-ops-agent": digest("7"),
        },
      },
    });

    await expect(authority().resolveManifest(sourceSha)).rejects.toThrow(
      "release digest manifest is missing the gateway release images: octogee-gateway-builder",
    );
  });
});
