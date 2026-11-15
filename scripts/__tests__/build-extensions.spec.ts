import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const build = join(repoRoot, "gateway/build-extensions.mjs");
const esbuild = join(repoRoot, "scripts/node_modules/.bin/esbuild");

describe("build-extensions.mjs", () => {
  let root: string;
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "build-extensions-"))); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("bundles runtime dependencies without running their install scripts", () => {
    const marker = join(root, "install-script-ran");
    const env = { ...process.env, PROBE_MARKER: marker, npm_config_update_notifier: "false" };
    const dependency = join(root, "dependency");
    mkdirSync(dependency);
    writeFileSync(join(dependency, "package.json"), JSON.stringify({
      name: "probe-dependency", version: "1.0.0", main: "index.js",
      scripts: { install: `node -e "require('node:fs').writeFileSync(process.env.PROBE_MARKER, 'ran')"` },
    }));
    writeFileSync(join(dependency, "index.js"), "module.exports = { answer: 4242 };\n");

    const plugin = join(root, "extensions/octogee-probe-tools");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, "package.json"), JSON.stringify({
      name: "octogee-probe-tools", version: "0.0.0", type: "module",
      dependencies: { "probe-dependency": "file:../../dependency" },
      allowScripts: { [`file:${dependency}`]: true },
    }));
    writeFileSync(join(plugin, "openclaw.plugin.json"), JSON.stringify({ id: "octogee-probe-tools" }));
    writeFileSync(join(plugin, "index.ts"), 'import dependency from "probe-dependency";\nexport const answer = dependency.answer;\n');
    execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: plugin, env, stdio: "pipe" });

    const result = spawnSync("node", [build, join(root, "extensions"), esbuild], { encoding: "utf8", env });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(plugin, "index.js"), "utf8")).toContain("4242");
    expect(existsSync(join(plugin, "node_modules"))).toBe(false);
  }, 60_000);
});
