import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, chown, mkdir, mkdtemp, lstat, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HOME_DESKTOP_TOOL_PATHS, admitHome, restoreHome, tarCreateArgs, tarExtractArgs, type HomeCheckpointDeps, type HomeScope } from "../../lib/vm-gateway-agent/home-checkpoint.js";

import { createHomeFs } from "../../lib/vm-gateway-agent/home-fs.js";

let root: string;
let scope: HomeScope;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "native-tool-archive-"));
  scope = { slug: "alice", dataDir: `${root}/volumes/data`, desktopDir: `${root}/desktop-home`, marker: `${root}/marker`, restorePending: `${root}/pending`, restoreGate: `${root}/gate`, desktopToolsRebuildable: true };
  await mkdir(scope.dataDir, { recursive: true });
  await writeFile(`${scope.dataDir}/agent-state`, "strict agent context");
  for (const name of [".local/share/mise/installs/node/bin/node", ".cache/mise/download.tar", ".npm/_cacache/cache", ".config/octogee-chromium/Default/Cookies", ".codex/auth.json", ".config/mise/config.toml", ".local/share/user-app/context"]) {
    const file = `${scope.desktopDir}/${name}`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, name.includes("mise/installs") || name.includes("cache") || name.includes(".npm") ? "rebuildable bytes" : "private user context");
  }
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("archives user context without desktop mise installations and package caches", () => {
  const archive = `${root}/home.tar.gz`;
  execFileSync("tar", tarCreateArgs(archive, scope));
  const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  expect(members).not.toContain("desktop-home/.local/share/mise");
  expect(members).not.toContain("desktop-home/.cache/mise");
  expect(members).not.toContain("desktop-home/.npm");
  expect(members).toContain("desktop-home/.codex/auth.json");
  expect(members).toContain("desktop-home/.config/mise/config.toml");
  expect(members).toContain("desktop-home/.config/octogee-chromium/Default/Cookies");
  expect(members).toContain("desktop-home/.local/share/user-app/context");
  expect(members).toContain("data/agent-state");
});

it("retains legacy tool versions in staging without restoring disposable download caches", async () => {
  const archive = `${root}/legacy.tar.gz`, staged = `${root}/staged`;
  execFileSync("tar", ["-czf", archive, "-C", root, "desktop-home", "-C", `${root}/volumes`, "data"]);
  await mkdir(staged);
  execFileSync("tar", tarExtractArgs(archive, staged));
  expect(await readFile(`${staged}/desktop-home/.local/share/mise/installs/node/bin/node`, "utf8")).toBe("rebuildable bytes");
  await expect(readFile(`${staged}/desktop-home/.cache/mise/download.tar`)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(`${staged}/desktop-home/.npm/_cacache/cache`)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(`${staged}/desktop-home/.codex/auth.json`, "utf8")).toBe("private user context");
  expect(await readFile(`${staged}/desktop-home/.config/mise/config.toml`, "utf8")).toBe("private user context");
  expect(await readFile(`${staged}/desktop-home/.config/octogee-chromium/Default/Cookies`, "utf8")).toBe("private user context");
  expect(await readFile(`${staged}/data/agent-state`, "utf8")).toBe("strict agent context");
});

it("full-home content replacement preserves existing platform tool links and browser/auth state", async () => {
  const staged = `${root}/restored`, live = `${root}/live-home`, osTools = `${root}/os-tools`;
  await mkdir(staged);
  await mkdir(osTools);
  await writeFile(`${osTools}/node`, "image binary");
  const before: number[] = [];
  for (const name of HOME_DESKTOP_TOOL_PATHS) {
    const link = `${live}/${name}`;
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(osTools, link);
    before.push((await lstat(link)).ino);
  }
  for (const name of [".codex/auth.json", ".config/mise/config.toml", ".config/octogee-chromium/Default/Cookies"]) {
    await mkdir(path.dirname(`${staged}/${name}`), { recursive: true });
    await writeFile(`${staged}/${name}`, "restored user context");
  }
  await createHomeFs(root).replaceDirectoryContents(staged, live, HOME_DESKTOP_TOOL_PATHS);
  for (const [index, name] of HOME_DESKTOP_TOOL_PATHS.entries()) {
    expect((await lstat(`${live}/${name}`)).ino).toBe(before[index]);
    expect(await readlink(`${live}/${name}`)).toBe(osTools);
  }
  expect(await readFile(`${live}/.codex/auth.json`, "utf8")).toBe("restored user context");
  expect(await readFile(`${live}/.config/mise/config.toml`, "utf8")).toBe("restored user context");
  expect(await readFile(`${live}/.config/octogee-chromium/Default/Cookies`, "utf8")).toBe("restored user context");
  expect(await readFile(`${osTools}/node`, "utf8")).toBe("image binary");
});

it("preserves legacy tool bytes when no recoverable rebuild declaration exists", () => {
  const archive = `${root}/preserved-tools.tar.gz`;
  execFileSync("tar", tarCreateArgs(archive, { ...scope, desktopToolsRebuildable: false }));
  expect(execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })).toContain("desktop-home/.local/share/mise/installs/node/bin/node");
});

it("restores home and cache directory permissions while retaining gateway tool links", async () => {
  const staged = `${root}/metadata-source`, live = `${root}/metadata-target`, tools = `${root}/metadata-tools`;
  await mkdir(tools);
  for (const name of HOME_DESKTOP_TOOL_PATHS) {
    await mkdir(path.dirname(`${live}/${name}`), { recursive: true });
    await symlink(tools, `${live}/${name}`);
  }
  await mkdir(`${staged}/.cache`, { recursive: true });
  await writeFile(`${staged}/.cache/user-context`, "retained user context");
  await chmod(staged, 0o710);
  await chmod(`${staged}/.cache`, 0o750);
  await createHomeFs(root).replaceDirectoryContents(staged, live, HOME_DESKTOP_TOOL_PATHS);
  expect((await lstat(live)).mode & 0o777).toBe(0o710);
  expect((await lstat(`${live}/.cache`)).mode & 0o777).toBe(0o750);
  expect(await readFile(`${live}/.cache/user-context`, "utf8")).toBe("retained user context");
  for (const name of HOME_DESKTOP_TOOL_PATHS) expect(await readlink(`${live}/${name}`)).toBe(tools);
});

it("moves real archived tool storage into durable retention while ignoring archived tool links", async () => {
  const retained = `${scope.desktopDir}/.config/octogee/mise-retained`;
  const fs = createHomeFs(root);
  await fs.retainToolStorage!(`${scope.desktopDir}/.local/share/mise`, retained);
  expect(await readFile(`${retained}/installs/node/bin/node`, "utf8")).toBe("rebuildable bytes");
  await symlink("/untrusted/archive/tool-link", `${scope.desktopDir}/.local/share/mise`);
  await fs.retainToolStorage!(`${scope.desktopDir}/.local/share/mise`, retained);
  expect(await readFile(`${retained}/installs/node/bin/node`, "utf8")).toBe("rebuildable bytes");
});

it("retained archive tool parents retain the desktop owner's write access", async () => {
  if (process.getuid?.() === 0) await chown(scope.desktopDir, 1000, 1000);
  await rm(`${scope.desktopDir}/.config`, { recursive: true });
  const owner = await lstat(scope.desktopDir);
  await createHomeFs(root).retainToolStorage!(`${scope.desktopDir}/.local/share/mise`, `${scope.desktopDir}/.config/octogee/mise-retained`);
  for (const name of [".config", ".config/octogee"]) {
    expect((await lstat(`${scope.desktopDir}/${name}`)).uid).toBe(owner.uid);
  }
});

it("rejects an unrelated tool retention destination before moving archive files", async () => {
  await expect(createHomeFs(root).retainToolStorage!(`${scope.desktopDir}/.local/share/mise`, `${root}/unrelated`)).rejects.toThrow("path");
  expect(await readFile(`${scope.desktopDir}/.local/share/mise/installs/node/bin/node`, "utf8")).toBe("rebuildable bytes");
});

it("reconciles restored custom-version declarations on a fresh image before desktop admission", async () => {
  const source = `${root}/checkpoint/desktop-home`, live = `${root}/new-image-home`, tools = `${root}/image-mise`;
  const config = `${source}/.config/octogee`;
  await mkdir(config, { recursive: true });
  await writeFile(`${config}/mise-installs.json`, JSON.stringify({ version: 1, rebuildable: true, requests: ["node@99.0.0"] }));
  await mkdir(`${tools}/installs/node/26/bin`, { recursive: true });
  await writeFile(`${tools}/installs/node/26/bin/node`, "image version");
  await mkdir(`${live}/.local/share`, { recursive: true });
  await symlink(tools, `${live}/.local/share/mise`);
  if (process.getuid?.() === 0) {
    await chown(source, 1000, 1000);
    await chown(live, 1000, 1000);
  }
  const archive = `${root}/custom-home.tar.gz`;
  execFileSync("tar", tarCreateArgs(archive, { ...scope, desktopDir: source }));
  const bytes = await readFile(archive);
  const record = { name: "20260905T101500Z.tar.gz", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), coverage: "builder-home-v2", writerProtocol: 2, download: { url: "https://archive.example/home", method: "GET" } };
  let held = false;
  const deps: HomeCheckpointDeps = {
    gatewayId: "native", apiUrl: "https://broker.example", stateRoot: root,
    metadata: { identityToken: async () => "fixture-token" },
    fetchImpl: async (url) => new Response(String(url).includes("download-url") ? JSON.stringify(record) : bytes),
    fs: createHomeFs(root),
    shell: { run: async (command, args) => ({ code: 0, stdout: execFileSync(command, args, { encoding: "utf8" }), stderr: "" }) },
    desktop: { run: async action => {
      if (action === "stop-home") held = true;
      if (action === "reconcile-tools") {
        expect(held).toBe(true);
        expect(await readFile(`${live}/.config/octogee/mise-installs.json`, "utf8")).toContain("node@99.0.0");
        const script = `import json, runpy, sys, types
from pathlib import Path
module = runpy.run_path(sys.argv[1])
home, tools, cache = map(Path, sys.argv[2:])
def command(argv, **kwargs):
    if 'show' in argv: return types.SimpleNamespace(stdout='inactive\\ninactive\\ninactive\\n')
    if 'ls' in argv:
        rows = [{'version': p.name, 'install_path': str(p)} for p in (home/'.local/share/mise/installs/node').glob('*')]
        return types.SimpleNamespace(stdout=json.dumps({'node': rows}))
    for request in argv:
        if request.startswith('node@'):
            target = tools/'installs/node'/request.split('@')[1]/'bin/node'
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('restored custom version')
    return types.SimpleNamespace(stdout='')
module['reconcile_boot'](home, tools, cache, run=command, processes=lambda uid: [])`;
        execFileSync("python3", ["-c", script, path.resolve(__dirname, "../../../desktop/image/rootfs/usr/local/bin/octo-desktop-tool-storage"), live, tools, `${root}/cache`]);
      }
      if (action === "start") {
        expect(await readFile(`${tools}/installs/node/99.0.0/bin/node`, "utf8")).toBe("restored custom version");
        held = false;
      }
    } },
    snapshot: async work => work(), captureSnapshot: async () => {}, discardSnapshot: async () => {},
    now: () => Date.now(), log: () => {}, logError: () => {},
  };
  const restored = { ...scope, dataDir: `${root}/restored-data`, desktopDir: live };
  await expect(restoreHome(deps, restored)).resolves.toMatchObject({ status: "restored" });
  expect(held).toBe(true);
  await admitHome(deps, restored);
  expect(held).toBe(false);
});
