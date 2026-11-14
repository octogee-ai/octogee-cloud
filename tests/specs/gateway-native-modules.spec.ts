import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) => readFileSync(path.join(repoRoot, relativePath), "utf8");
const readJson = (relativePath: string) => JSON.parse(read(relativePath)) as Record<string, any>;

const gatewayDockerfile = read("infra/gateway/Dockerfile");
const scriptsNpmrc = read("scripts/.npmrc");
const scriptsPackageJson = readJson("scripts/package.json");
const scriptsLockfile = readJson("scripts/package-lock.json");

// #2721 pinned npm 12 into every service image. npm 12 blocks a dependency's
// install scripts unless a policy covers it, so each of these images is on the
// same silent path the gateway fell down — they are safe only because their
// dependency installs opt out of install scripts outright.
const npmTwelveServiceImages = [
  "gateway-edge/Dockerfile",
  "glm-controller/Dockerfile",
];

const SMOKE_CHECK_RUN = "RUN node /octogee/scripts/ops/verify-native-modules.mjs";
const SMOKE_CHECK_COPY =
  "COPY --chown=node:node scripts/ops/verify-native-modules.mjs /octogee/scripts/ops/";
const SCRIPTS_INSTALL = "RUN npm install --no-audit --no-fund";
const SCRIPTS_PRUNE = "npm prune --omit=dev";

// Every package whose installation runs a lifecycle script, as recorded by npm
// in the committed lockfile. npm 12 blocks these unless `allowScripts` covers
// them, so this set — not a hand-maintained list — is what the policy has to
// keep up with.
const installScriptPackages = Object.entries(scriptsLockfile.packages as Record<string, any>)
  .filter(([, entry]) => entry?.hasInstallScript)
  .map(([key]) => key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length))
  .sort();

describe("scripts/ install-script policy (npm 12 allowScripts)", () => {
  // Native modules are explicit so a future image dependency gets a loader
  // check rather than relying on its install step alone.
  it("records an explicit decision for each declared native dependency", () => {
    expect(scriptsPackageJson.nativeModules).toEqual([]);
  });

  // Lockfile `hasInstallScript` is npm's record of a declared
  // preinstall/install/postinstall. It is not the whole gate: npm 12 also
  // synthesises `install: node-gyp rebuild` for any package with a binding.gyp
  // on disk, and enumerates `prepare` for non-registry (file:/git:/remote)
  // sources — neither is recorded in the lockfile. Those two classes are caught
  // by CI running the image's own npm against strict-allow-scripts, not here.
  it("has an explicit decision for every install-script package in the lockfile", () => {
    expect(installScriptPackages.length).toBeGreaterThan(0);
    for (const name of installScriptPackages) {
      expect(
        scriptsPackageJson.allowScripts[name],
        `scripts/package.json allowScripts is missing an entry for "${name}" — decide true (its install script is required) or false (deliberately skipped)`,
      ).toBeTypeOf("boolean");
    }
  });

  // Name-only keys keep a routine version bump from silently re-blocking an
  // approved install script.
  it("keys the policy by package name only, never pinned to a version", () => {
    for (const key of Object.keys(scriptsPackageJson.allowScripts)) {
      expect(key.slice(1)).not.toContain("@");
    }
  });

  it("turns an unreviewed install script into a hard install failure", () => {
    expect(scriptsNpmrc).toContain("strict-allow-scripts=true");
  });
});

describe("gateway image validates declared native modules", () => {
  it("keeps install scripts enabled for the provisioner install", () => {
    expect(gatewayDockerfile).toContain(SCRIPTS_INSTALL);
    const installLine = gatewayDockerfile
      .split("\n")
      .find((line) => line.startsWith(SCRIPTS_INSTALL));
    expect(installLine).not.toContain("--ignore-scripts");
    expect(gatewayDockerfile).not.toContain("--dangerously-allow-all-scripts");
  });

  it("stages the native-module smoke check into the image", () => {
    expect(gatewayDockerfile).toContain(SMOKE_CHECK_COPY);
    expect(gatewayDockerfile.indexOf(SMOKE_CHECK_COPY)).toBeLessThan(
      gatewayDockerfile.indexOf(SMOKE_CHECK_RUN),
    );
  });

  // The gate has to live in the Dockerfile, not in a workflow step, so no
  // build path can skip a declared native dependency.
  it("requires every native module at build time", () => {
    expect(gatewayDockerfile).toContain(SMOKE_CHECK_RUN);
  });

  // Running the check after the prune covers both halves: the install has to
  // produce the binding, and nothing later may remove it.
  it("runs the smoke check after the dev-dependency prune", () => {
    expect(gatewayDockerfile.indexOf(SCRIPTS_PRUNE)).toBeGreaterThan(-1);
    expect(gatewayDockerfile.indexOf(SCRIPTS_PRUNE)).toBeLessThan(
      gatewayDockerfile.indexOf(SMOKE_CHECK_RUN),
    );
  });

  it("never softens the smoke check into a warning", () => {
    const smokeLine = gatewayDockerfile
      .split("\n")
      .find((line) => line.includes("verify-native-modules.mjs") && line.startsWith("RUN"));
    expect(smokeLine).toBe(SMOKE_CHECK_RUN);
  });
});

// Every other image pinned to npm 12 opts out explicitly, so none can silently
// gain an unreviewed dependency install step.
describe.each(npmTwelveServiceImages)("%s opts out of dependency install scripts", (file) => {
  it("passes --ignore-scripts on every dependency install", () => {
    const dependencyInstalls = read(file)
      .split("\n")
      .filter((line) => /^RUN npm (ci|install)\b/.test(line))
      .filter((line) => !line.includes("--global"));

    expect(dependencyInstalls.length).toBeGreaterThan(0);
    for (const line of dependencyInstalls) {
      expect(line, `${file}: "${line}" runs under npm 12 with no allowScripts policy`).toContain(
        "--ignore-scripts",
      );
    }
  });
});

describe("octogee-api Obsidian Headless native dependency", () => {
  const dockerfile = read("octogee-api/Dockerfile");
  const packageJson = readJson("octogee-api/package.json");

  it("allows only the better-sqlite3 install script required by Obsidian Headless", () => {
    expect(packageJson.allowScripts).toEqual({
      "@firebase/util": false,
      "better-sqlite3": true,
      esbuild: false,
      protobufjs: false,
      re2: false,
    });
  });

  it("installs dependencies inertly before rebuilding the one approved native module", () => {
    expect(dockerfile).toContain("RUN npm ci --omit=dev --ignore-scripts");
    expect(dockerfile).toContain("RUN npm rebuild better-sqlite3 --foreground-scripts");
  });

  it("fails the image build when the SQLite binding cannot load", () => {
    expect(dockerfile).toContain("new Database(':memory:')");
    expect(dockerfile).not.toContain("|| true");
  });
});
