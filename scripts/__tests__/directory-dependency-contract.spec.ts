import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dockerfileLocalFileDeps } from "../lib/dockerfile-local-file-deps.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(root, "..");

const directoryDependencies = [
  ["core", "@octogee/shared", "devDependencies", "file:../shared"],
  ["../functions", "@octogee/test-helpers", "devDependencies", "file:../product/test-helpers"],
  ["gateway-edge", "@octogee/core", "dependencies", "file:../core"],
  ["gateway-edge", "@octogee/shared", "dependencies", "file:../shared"],
  ["fleet-controller", "@octogee/core", "dependencies", "file:../core"],
  ["fleet-controller", "@octogee/shared", "dependencies", "file:../shared"],
  ["platform-api", "@octogee/core", "dependencies", "file:../core"],
  ["platform-api", "@octogee/shared", "dependencies", "file:../shared"],
  ["scripts", "@octogee/core", "dependencies", "file:../core"],
  ["scripts", "@octogee/shared", "dependencies", "file:../shared"],
] as const;

const trackedNpmrcFiles = execFileSync("git", ["ls-files", "--recurse-submodules", "*.npmrc"], { cwd: repoRoot, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const dockerfiles = execFileSync("git", ["ls-files", "*Dockerfile", "*Dockerfile.*"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((file) => file && !file.endsWith(".dockerignore") && !file.startsWith("tests/fixtures/"));

const dockerfileDeps = dockerfiles.map((file) => dockerfileLocalFileDeps(path.join(root, file), root));

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(root, filePath), "utf8"));
}

function dockerfile(pathname: string): string {
  return fs.readFileSync(path.join(root, pathname), "utf8");
}

function dockerStage(contents: string, name: string): string {
  const stage = contents.split(/^FROM /mu).find((part) => part.split("\n", 1)[0].endsWith(` AS ${name}`));
  if (!stage) throw new Error(`Docker stage is missing: ${name}`);
  return stage;
}

function expectBefore(contents: string, earlier: string, later: string): void {
  expect(contents.indexOf(earlier)).toBeGreaterThanOrEqual(0);
  expect(contents.indexOf(later)).toBeGreaterThanOrEqual(0);
  expect(contents.indexOf(earlier)).toBeLessThan(contents.indexOf(later));
}

function expectLastBefore(contents: string, earlier: string, later: string): void {
  expect(contents.lastIndexOf(earlier)).toBeGreaterThanOrEqual(0);
  expect(contents.indexOf(later)).toBeGreaterThanOrEqual(0);
  expect(contents.lastIndexOf(earlier)).toBeLessThan(contents.indexOf(later));
}

describe("directory dependency repository contract", () => {
  it("declares every internal package as a packed directory dependency", () => {
    for (const [consumer, packageName, section, spec] of directoryDependencies) {
      const packageJson = readJson(`${consumer}/package.json`);
      const lockfile = readJson(`${consumer}/package-lock.json`);
      const entry = lockfile.packages[`node_modules/${packageName}`];

      expect(packageJson[section][packageName]).toBe(spec);
      expect(entry.resolved).toBe(spec);
      expect(entry.integrity).toBeUndefined();
    }
    expect(readJson("core/package.json").peerDependencies["@octogee/shared"]).toBe("^1.0.0");
  });

  it("discovers every tracked consumer npm config", () => {
    expect(trackedNpmrcFiles).toEqual(expect.arrayContaining([
      "platform/core/.npmrc",
      "functions/.npmrc",
      "platform/gateway-edge/.npmrc",
      "platform/fleet-controller/.npmrc",
      "platform/platform-api/.npmrc",
      "platform/scripts/.npmrc",
    ]));
  });

  it.each(trackedNpmrcFiles)("%s enforces the 7-day npm release-age cooldown", (npmrc) => {
    const lines = fs.readFileSync(path.join(repoRoot, npmrc), "utf8").split("\n").map((line) => line.trim());
    expect(lines).toContain("min-release-age=7");
  });

  it.each(["core", "../functions", "gateway-edge", "fleet-controller", "platform-api"])(
    "%s enables locally linked packages with the release-age cooldown",
    (consumer) => {
      expect(fs.readFileSync(path.join(root, consumer, ".npmrc"), "utf8")).toBe(
        "install-links=true\nmin-release-age=7\n",
      );
    },
  );

  it("scripts preserves strict install-script review with the release-age cooldown", () => {
    expect(fs.readFileSync(path.join(root, "scripts", ".npmrc"), "utf8")).toBe(
      "install-links=true\nmin-release-age=7\nstrict-allow-scripts=true\n",
    );
  });

  it.each([
    ["core", "../scripts"],
    ["../functions", "../platform/scripts"],
    ["gateway-edge", "../scripts"],
    ["fleet-controller", "../scripts"],
    ["platform-api", "../scripts"],
    ["scripts", "../scripts"],
  ])(
    "%s refreshes packed dependencies before tests",
    (consumer, scripts) => {
      expect(readJson(`${consumer}/package.json`).scripts.pretest).toBe(
        `node ${scripts}/ops/sync-local-file-deps.mjs --consumer .`,
      );
    },
  );

  it("copies each packed dependency and consumer npm config before Docker installs", () => {
    const api = dockerfile("platform-api/Dockerfile");
    for (const source of ["core", "shared"]) {
      expectBefore(dockerStage(api, "builder"), `COPY ${source}/package.json`, "RUN npm ci --ignore-scripts");
      expectBefore(dockerStage(api, "builder"), `COPY ${source}/dist`, "RUN npm ci --ignore-scripts");
    }
    expectBefore(dockerStage(api, "builder"), "COPY platform-api/.npmrc", "RUN npm ci --ignore-scripts");
    const apiRuntimeInstall = "RUN npm ci --omit=dev --ignore-scripts\nRUN npm rebuild";
    for (const source of ["core", "shared"]) {
      expectLastBefore(api, `COPY ${source}/package.json`, apiRuntimeInstall);
      expectLastBefore(api, `COPY ${source}/dist`, apiRuntimeInstall);
    }
    expectLastBefore(api, "COPY platform-api/.npmrc", apiRuntimeInstall);

    const broker = dockerfile("llm-broker/Dockerfile");
    for (const source of ["core", "shared"]) {
      expectBefore(dockerStage(broker, "builder"), `COPY ${source}/package.json`, "RUN npm ci --ignore-scripts");
      expectBefore(dockerStage(broker, "builder"), `COPY ${source}/dist`, "RUN npm ci --ignore-scripts");
      expectLastBefore(broker, `COPY ${source}/package.json`, "RUN npm ci --omit=dev");
      expectLastBefore(broker, `COPY ${source}/dist`, "RUN npm ci --omit=dev");
    }
    expectBefore(dockerStage(broker, "builder"), "COPY llm-broker/.npmrc", "RUN npm ci --ignore-scripts");
    expectLastBefore(broker, "COPY llm-broker/.npmrc", "RUN npm ci --omit=dev");

    const edge = dockerfile("gateway-edge/Dockerfile");
    for (const source of ["core", "shared"]) {
      expectBefore(edge, `COPY ${source}/package.json`, "RUN npm ci --ignore-scripts");
      expectBefore(edge, `COPY ${source}/dist`, "RUN npm ci --ignore-scripts");
    }
    expectBefore(edge, "COPY gateway-edge/.npmrc", "RUN npm ci --ignore-scripts");
    for (const source of ["core", "shared"]) {
      expectLastBefore(edge, `COPY ${source}/package.json`, "RUN npm ci --omit=dev");
      expectLastBefore(edge, `COPY ${source}/dist`, "RUN npm ci --omit=dev");
    }
    expectLastBefore(edge, "COPY gateway-edge/.npmrc", "RUN npm ci --omit=dev");

    const glm = dockerfile("fleet-controller/Dockerfile");
    for (const source of ["core", "shared"]) {
      expectBefore(glm, `COPY ${source}/package.json`, "RUN npm ci");
      expectBefore(glm, `COPY ${source}/dist`, "RUN npm ci");
    }
    expectBefore(glm, "COPY fleet-controller/.npmrc", "RUN npm ci");
  });

  it.each(["platform-api", "llm-broker"])("builds the %s image without the product tree or an overlay", (service) => {
    expect(dockerfile(`${service}/Dockerfile`)).not.toMatch(/--from=(?:product|overlay)\b/);
  });

  it("installs gateway dependencies from manifests and overlays freshly packed internal packages", () => {
    const gateway = dockerfile("gateway/Dockerfile");
    const dependencies = dockerStage(gateway, "gateway-dependencies");
    const localPackages = dockerStage(gateway, "gateway-local-packages");
    const build = dockerStage(gateway, "gateway-build");
    const runtime = dockerStage(gateway, "gateway-runtime");
    const install = "RUN npm install --no-audit --no-fund";
    const overlay = "COPY --from=gateway-local-packages --chown=node:node /packages /octogee/scripts/node_modules";

    for (const source of ["core", "shared"]) {
      expectBefore(dependencies, `COPY --chown=node:node ${source}/package.json`, install);
      expect(dependencies).not.toContain(`${source}/dist`);
      const pack = `bash /tmp/pack-local-deps.sh /octogee/${source} /packages/@octogee/${source}`;
      expectBefore(localPackages, `COPY ${source}/package.json`, pack);
      expectBefore(localPackages, `COPY ${source}/dist`, pack);
    }
    expectBefore(dependencies, "COPY --chown=node:node scripts/.npmrc", install);
    expectBefore(dependencies, "shared/package-lock.json", "cd /octogee/shared && npm ci");
    expectBefore(build, "COPY --from=gateway-dependencies /octogee /octogee", overlay);
    expectBefore(build, overlay, "RUN /octogee/scripts/node_modules/.bin/esbuild");
    expectBefore(runtime, "COPY --link --from=gateway-production-dependencies --chown=1000:1000 /octogee/scripts/node_modules", overlay);
    expectBefore(runtime, overlay, "RUN node /octogee/scripts/ops/verify-native-modules.mjs");
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
    expect(installs.filter((dir) => dir === "gateway-edge")).toHaveLength(2);
    expect(installs.filter((dir) => dir === "llm-broker")).toHaveLength(2);
    expect(installs).toEqual(expect.arrayContaining(["fleet-controller", "scripts", "shared"]));
  });

  it("re-includes every packed interface in the Docker build context", () => {
    const lines = fs
      .readFileSync(path.join(root, ".dockerignore"), "utf8")
      .split("\n")
      .map((line) => line.trim());
    const distDirs = [...new Set(dockerfileDeps.flatMap((deps) => deps.distDirs))];
    expect(distDirs).toEqual(expect.arrayContaining(["core/dist", "shared/dist"]));
    for (const distDir of distDirs) {
      expect(lines).toContain(`!${distDir}/`);
      expect(lines).toContain(`!${distDir}/**`);
    }
  });

  it("retires tarball transport and its maintenance commands", () => {
    for (const filePath of [
      "core/octogee-core.tgz",
      "shared/octogee-shared.tgz",
      "test-helpers/octogee-test-helpers.tgz",
      "core/verify-tarball.sh",
      "shared/verify-tarball.sh",
      "test-helpers/verify-tarball.sh",
      "scripts/ops/rebase-resolve-tarballs.mjs",
    ]) {
      expect(fs.existsSync(path.join(root, filePath))).toBe(false);
    }
    const rootPackage = readJson("../package.json");
    expect(rootPackage.scripts["regen:file-deps"]).toBeUndefined();
    expect(rootPackage.scripts["rebase:resolve"]).toBeUndefined();
  });
});
