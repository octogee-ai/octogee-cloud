import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const publish = join(repoRoot, "gateway/publish-plugin.sh");
const plugin = "octogee-broker-tools";
const sourcePath = `gateway/extensions/platform/${plugin}`;
const committed = (file: string) =>
  JSON.parse(execFileSync("git", ["-C", repoRoot, "show", `HEAD:${sourcePath}/${file}`], { encoding: "utf8" }));

describe("publish-plugin.sh", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "publish-plugin-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(env: Record<string, string>, ...args: string[]) {
    const clawhub = join(root, "clawhub");
    writeFileSync(clawhub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${root}/args"\ncp "$4" "${root}/release.tgz"\n`);
    chmodSync(clawhub, 0o755);
    return spawnSync("bash", [publish, plugin, ...args], {
      encoding: "utf8",
      env: { ...process.env, CLAWHUB: clawhub, RUNNER_TEMP: root, npm_config_update_notifier: "false", ...env },
    });
  }

  it("hands ClawHub the built plugin and the commit it was built from", () => {
    const { name, version } = committed("package.json");
    const result = run({
      EXPECTED_VERSION: version,
      GITHUB_REPOSITORY: "octogee-ai/octogee-cloud",
      GITHUB_REF: `refs/tags/${plugin}-v${version}`,
    }, "--dry-run");
    expect(result.status, result.stderr).toBe(0);

    const args = readFileSync(join(root, "args"), "utf8").trim().split("\n");
    expect(args.slice(0, 3)).toEqual(["--no-input", "package", "publish"]);
    expect(args.slice(4)).toEqual([
      "--family", "code-plugin", "--owner", name.slice(1, name.indexOf("/")),
      "--source-repo", "octogee-ai/octogee-cloud",
      "--source-commit", execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      "--source-path", sourcePath, "--json",
      "--source-ref", `refs/tags/${plugin}-v${version}`, "--dry-run",
    ]);

    const tarball = join(root, "release.tgz");
    expect(execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n").sort()).toEqual([
      "package/LICENSE", "package/README.md", "package/index.js", "package/openclaw.plugin.json", "package/package.json",
    ]);
    const shipped = JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }));
    expect(shipped).toMatchObject({ name, version, openclaw: { extensions: ["./index.js"] } });
    expect(shipped).not.toHaveProperty("scripts");
    expect(shipped).not.toHaveProperty("devDependencies");
  }, 60_000);

  it("waits for ClawHub to accept a real release", () => {
    const result = run({ EXPECTED_VERSION: committed("package.json").version, SOURCE_REF: "refs/heads/main" });
    expect(result.status, result.stderr).toBe(0);

    const args = readFileSync(join(root, "args"), "utf8").trim().split("\n");
    expect(args.slice(-3)).toEqual(["--source-ref", "refs/heads/main", "--wait"]);
    expect(args).not.toContain("--dry-run");
  }, 60_000);

  it("refuses a release tag whose version the plugin does not declare", () => {
    const result = run({ EXPECTED_VERSION: "0.0.0-not-declared" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not the release version 0.0.0-not-declared");
    expect(existsSync(join(root, "args"))).toBe(false);
  }, 60_000);
});
