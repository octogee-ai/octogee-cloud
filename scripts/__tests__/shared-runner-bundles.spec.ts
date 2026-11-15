import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPTS = resolve(import.meta.dirname, "..");
const DOCKERFILE = resolve(SCRIPTS, "../gateway/Dockerfile");
const IMAGE_SCRIPTS = "/octogee/scripts/";
const IMAGE_ESBUILD = `${IMAGE_SCRIPTS}node_modules/.bin/esbuild`;
const SHARED_RUNNERS_OUTDIR = `--outdir=${IMAGE_SCRIPTS}shared-runners`;

interface Metafile {
  outputs: Record<string, { entryPoint?: string; imports: { path: string; kind: string; external?: boolean }[] }>;
}

function sharedRunnerBuildArguments(): string[] {
  const command = readFileSync(DOCKERFILE, "utf8")
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .find(line => line.startsWith(`RUN ${IMAGE_ESBUILD} `) && line.includes(SHARED_RUNNERS_OUTDIR));
  if (!command) throw new Error(`No shared runner esbuild command in ${DOCKERFILE}`);
  return command.slice(`RUN ${IMAGE_ESBUILD} `.length).trim().split(/\s+/);
}

const workspace = mkdtempSync(join(tmpdir(), "shared-runner-bundles-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

function buildSharedRunners(): Metafile {
  const metafile = join(workspace, "meta.json");
  const args = sharedRunnerBuildArguments().map(arg =>
    arg.startsWith("--outdir=") ? `--outdir=${join(workspace, "shared-runners")}` : arg.replace(IMAGE_SCRIPTS, `${SCRIPTS}/`));
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

describe("shared runner bundles", () => {
  const metafile = buildSharedRunners();
  const runners = Object.values(metafile.outputs).filter(output => output.entryPoint);

  it("builds the shared runners the image starts", () => {
    expect(runners.map(output => output.entryPoint)).toEqual(expect.arrayContaining([
      "entrypoints/provisioner.ts",
      "entrypoints/byosub-syncback-runner.ts",
    ]));
  });

  it.each(runners.map(output => [output.entryPoint!, output] as const))(
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
