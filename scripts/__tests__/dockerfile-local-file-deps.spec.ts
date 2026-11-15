import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cloudBakePlan, PLATFORMS } from "../ci/cloud-build.mjs";
import { dockerfileLocalFileDeps } from "../lib/dockerfile-local-file-deps.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const dockerfiles = [...new Set(PLATFORMS.flatMap((platform: string) =>
  Object.values(cloudBakePlan({ registry: "registry.example/octogee/images", sha: "a".repeat(40), platform, root }).target)
    .map((target) => (target as { dockerfile: string }).dockerfile)))].sort();

const dockerfileDeps = dockerfiles.map((file) => dockerfileLocalFileDeps(path.join(root, file), root));

describe("platform image Dockerfiles", () => {
  it("covers every Dockerfile the platform image build uses", () => {
    expect(dockerfiles).toEqual(expect.arrayContaining([
      "fleet-controller/Dockerfile",
      "gateway-edge/Dockerfile",
      "gateway/Dockerfile",
      "gateway/Dockerfile.base",
      "platform-api/Dockerfile",
    ]));
  });

  it.each(dockerfiles.map((file, index) => [file, dockerfileDeps[index]] as const))(
    "%s provides every local file dependency before its npm installs",
    (_file, deps) => {
      expect(deps.missing).toEqual([]);
    },
  );

  it("checks the npm installs of every service image", () => {
    const installs = dockerfileDeps.flatMap((deps) => deps.installs.map((install) => install.replace(/^.*\((.*)\)$/u, "$1")));
    expect(installs.filter((dir) => dir === "platform-api")).toHaveLength(2);
    expect(installs.filter((dir) => dir === "gateway-edge")).toHaveLength(3);
    expect(installs).toEqual(expect.arrayContaining(["fleet-controller", "gateway-supervisor", "shared"]));
  });

  it("re-includes every packed interface in the Docker build context", () => {
    const lines = fs.readFileSync(path.join(root, ".dockerignore"), "utf8").split("\n").map((line) => line.trim());
    const distDirs = [...new Set(dockerfileDeps.flatMap((deps) => deps.distDirs))];
    expect(distDirs).toEqual(expect.arrayContaining(["core/dist", "core-testing/dist", "shared/dist"]));
    for (const distDir of distDirs) {
      expect(lines).toContain(`!${distDir}/`);
      expect(lines).toContain(`!${distDir}/**`);
    }
  });
});
