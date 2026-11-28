import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPTS = resolve(import.meta.dirname, "..");
const DOCKERFILE = resolve(SCRIPTS, "../gateway/Dockerfile");
const ENTRYPOINT = resolve(SCRIPTS, "../gateway/entrypoint.sh");
const IMAGE_SCRIPTS = "/octogee/scripts/";
const IMAGE_ESBUILD = `${IMAGE_SCRIPTS}node_modules/.bin/esbuild`;
const SHARED_RUNNERS_OUTDIR = `--outdir=${IMAGE_SCRIPTS}shared-runners`;
const BUNDLED_ENTRYPOINTS_OUTDIR = `--outdir=${IMAGE_SCRIPTS}bundled-entrypoints`;

interface Metafile {
  outputs: Record<string, { entryPoint?: string; imports: { path: string; kind: string; external?: boolean }[] }>;
}

function esbuildCommandArguments(outdirFlag: string): string[] {
  const command = readFileSync(DOCKERFILE, "utf8")
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .find(line => line.startsWith(`RUN ${IMAGE_ESBUILD} `) && line.includes(outdirFlag));
  if (!command) throw new Error(`No esbuild command for ${outdirFlag} in ${DOCKERFILE}`);
  return command.slice(`RUN ${IMAGE_ESBUILD} `.length).trim().split(/\s+/);
}

const workspace = mkdtempSync(join(tmpdir(), "shared-runner-bundles-"));
const resolvableWorkspace = mkdtempSync(join(SCRIPTS, ".shared-runner-bundles-"));
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(resolvableWorkspace, { recursive: true, force: true });
});

function buildBundleGroup(outdirFlag: string, subdir: string, root = workspace): Metafile {
  const metafile = join(root, `${subdir}.meta.json`);
  const args = esbuildCommandArguments(outdirFlag).map(arg =>
    arg.startsWith("--outdir=") ? `--outdir=${join(root, subdir)}` : arg.replace(IMAGE_SCRIPTS, `${SCRIPTS}/`));
  execFileSync(resolve(SCRIPTS, "node_modules/.bin/esbuild"), [...args, `--metafile=${metafile}`, "--log-level=error"], { cwd: SCRIPTS });
  return JSON.parse(readFileSync(metafile, "utf8")) as Metafile;
}

const INSTALL_AFTER_IMPORTS = `
const [specifiers] = process.argv.slice(1).map(arg => JSON.parse(arg));
for (const specifier of specifiers) await import(specifier);
const { fileURLToPath } = await import("node:url");
const targets = await import("@octogee/core/deployment-environment");
const document = fileURLToPath(new URL("./deployment-targets.json", import.meta.resolve("@octogee/core/deployment-environment")));
targets.installDeploymentTargets(targets.loadDeploymentTargetsDocument(document));
`;

function installAfterLoading(specifiers: string[]) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", INSTALL_AFTER_IMPORTS, JSON.stringify(specifiers)], {
    cwd: SCRIPTS,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("bundled pre-boot", () => {
  it("patches openclaw.json when the image's runner starts the bundle", () => {
    buildBundleGroup(BUNDLED_ENTRYPOINTS_OUTDIR, "bundled-entrypoints", resolvableWorkspace);
    const home = mkdtempSync(join(tmpdir(), "bundled-pre-boot-"));
    try {
      const config = join(home, "openclaw.json");
      copyFileSync(resolve(SCRIPTS, "../gateway/openclaw.template.json"), config);
      const result = spawnSync(process.execPath, [join(resolvableWorkspace, "bundled-entrypoints", "pre-boot-config.mjs")], {
        cwd: SCRIPTS,
        env: { PATH: process.env.PATH, HOME: home, OPENCLAW_DIR: home, OPENCLAW_CONFIG_PATH: config, GATEWAY_CLASS: "shared" },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("openclaw.json patched");
      const patched = JSON.parse(readFileSync(config, "utf8")) as { agents: { defaults: { skipOptionalBootstrapFiles?: string[] } } };
      expect(patched.agents.defaults.skipOptionalBootstrapFiles).toContain("IDENTITY.md");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("shared runner bundles", () => {
  const sharedMetafile = buildBundleGroup(SHARED_RUNNERS_OUTDIR, "shared-runners");
  const prebootMetafile = buildBundleGroup(BUNDLED_ENTRYPOINTS_OUTDIR, "bundled-entrypoints");
  const runners = Object.values(sharedMetafile.outputs).filter(output => output.entryPoint);
  const prebootEntries = Object.values(prebootMetafile.outputs).filter(output => output.entryPoint);

  it("builds the shared runners the image starts", () => {
    expect(runners.map(output => output.entryPoint)).toEqual(expect.arrayContaining([
      "entrypoints/provisioner.ts",
      "entrypoints/byosub-syncback-runner.ts",
    ]));
  });

  it("bundles every TypeScript entrypoint invoked by gateway/entrypoint.sh", () => {
    const entrypointSource = readFileSync(ENTRYPOINT, "utf8");
    const invoked = new Set<string>();
    for (const match of entrypointSource.matchAll(/\/octogee\/scripts\/(entrypoints\/[A-Za-z0-9_.-]+\.ts)\b/g)) {
      invoked.add(match[1]!);
    }
    const bundled = new Set([
      ...runners.map(output => output.entryPoint!),
      ...prebootEntries.map(output => output.entryPoint!),
    ]);
    const unbundled = [...invoked].filter(entry => !bundled.has(entry)).sort();
    expect(unbundled).toEqual([]);
  });

  it.each([...runners, ...prebootEntries].map(output => [output.entryPoint!, output] as const))(
    "%s loads its hoisted package imports without reading the deployment targets an installing main sets",
    (_entry, output) => {
      const hoisted = output.imports.filter(entry => entry.external && entry.kind === "import-statement").map(entry => entry.path);
      const result = installAfterLoading([...new Set(hoisted)]);
      expect(result.stderr).not.toContain("Deployment targets must be installed before the registry is read");
      expect(result.status, result.stderr).toBe(0);
    },
    60_000,
  );
});
