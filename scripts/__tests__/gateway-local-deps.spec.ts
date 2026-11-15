import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const pack = resolve(import.meta.dirname, "../../gateway/pack-local-deps.sh");

it("refreshes packed internal modules while retaining the dependency tree", () => {
  const root = mkdtempSync(join(tmpdir(), "gateway-local-deps-"));
  try {
    const source = join(root, "core");
    const dependencies = join(root, "dependencies");
    const module = join(dependencies, "@octogee/core");
    const dependency = join(module, "node_modules/sibling");
    mkdirSync(join(source, "dist"), { recursive: true });
    mkdirSync(dependency, { recursive: true });
    const manifest = JSON.stringify({
      name: "@octogee/core", version: "1.0.0", files: ["dist"], main: "dist/index.js",
    });
    writeFileSync(join(source, "package.json"), manifest);
    writeFileSync(join(module, "package.json"), manifest);
    writeFileSync(join(dependency, "index.js"), "module.exports = 'dependency';\n");
    writeFileSync(join(source, "source-only.js"), "throw new Error('not packed');\n");

    for (const version of ["first", "second"]) {
      writeFileSync(join(source, "dist/index.js"), `module.exports = '${version}:' + require('sibling');\n`);
      const installed = join(root, `installed-${version}`);
      cpSync(dependencies, installed, { recursive: true });
      const payload = join(root, `packed-${version}`);
      execFileSync("bash", [pack, source, join(payload, "@octogee/core")], { stdio: "inherit" });
      cpSync(payload, installed, { recursive: true });

      const installedModule = join(installed, "@octogee/core");
      const output = execFileSync(process.execPath, ["-p", "require(process.argv[1])", installedModule], { encoding: "utf8" });
      expect(output.trim()).toBe(`${version}:dependency`);
      expect(existsSync(join(installedModule, "source-only.js"))).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
