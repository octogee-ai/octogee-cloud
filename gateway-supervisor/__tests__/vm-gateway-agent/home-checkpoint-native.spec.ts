import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointHome, homeIsDirty, homeScope, restoreHome, type HomeCheckpointDeps } from "../../lib/vm-gateway-agent/home-checkpoint";
import type { GatewayVmHomeCheckpoint } from "@octogee/shared/types/glm";
import { createHomeFs, homeShell } from "../../lib/vm-gateway-agent/home-fs";
import { bundleFixture } from "./fixture";
import { sshAuthentication } from "./ssh-auth-fixture";

const roots: string[] = [];
const nativeDocker = process.env.OCTOGEE_NATIVE_DOCKER_TEST === "1";
const exec = promisify(execFile);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "octogee-home-native-"));
  roots.push(root);
  const scope = homeScope(root, bundleFixture({ builderIdentity: { ownerUid: "uid-bob", builderSlug: "bob" } }))!;
  await mkdir(scope.dataDir, { recursive: true });
  await mkdir(`${scope.desktopDir}/.config/octogee-chromium/Default/Cache`, { recursive: true });
  await mkdir(`${scope.desktopDir}/Documents`, { recursive: true });
  await mkdir(`${root}/tokens`, { recursive: true });
  await writeFile(`${scope.dataDir}/gateway.txt`, "gateway state");
  await writeFile(`${scope.desktopDir}/.config/octogee-chromium/Default/Preferences`, "browser profile");
  await symlink("replaced-vm-1234", `${scope.desktopDir}/.config/octogee-chromium/SingletonLock`);
  await symlink("/tmp/old-chromium/socket", `${scope.desktopDir}/.config/octogee-chromium/SingletonSocket`);
  await writeFile(`${scope.desktopDir}/.config/octogee-chromium/DevToolsActivePort`, "9222");
  await writeFile(`${scope.desktopDir}/.config/octogee-chromium/Default/Cache/disposable`, "cache");
  await writeFile(`${scope.desktopDir}/Documents/project.txt`, "User document");
  await writeFile(`${root}/tokens/secret`, "not part of home");
  let uploaded = new Uint8Array();
  let current: Record<string, unknown> | null = null;
  const events: string[] = [];
  const shell = {
    run: async (command: string, args: string[]) => {
      if (command !== "tar" || process.platform !== "darwin") return homeShell.run(command, args);
      try {
        const result = await exec("docker", ["run", "--rm", "--pull", "never", "--network", "none",
          "--mount", `type=bind,source=${root},target=${root}`, "--entrypoint", "tar", "node:22-bookworm-slim", ...args]);
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const failure = error as { code: number; stdout: string; stderr: string };
        return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
      }
    },
  };
  const deps: HomeCheckpointDeps = {
    gatewayId: "b-x", apiUrl: "https://api.invalid", stateRoot: root,
    metadata: { identityToken: async () => "local-test-token" },
    fs: createHomeFs(root), shell, now: Date.now, log: vi.fn(), logError: vi.fn(),
    desktop: { run: async (action) => { events.push(action); } },
    discardSnapshot: async () => { await rm(`${root}/.home-checkpoint/snapshot`, { recursive: true, force: true }); },
    captureSnapshot: async () => {
      const snapshot = `${root}/.home-checkpoint/snapshot`;
      await mkdir(`${snapshot}/volumes`, { recursive: true });
      await cp(scope.dataDir, `${snapshot}/volumes/data`, { recursive: true, verbatimSymlinks: true });
      await cp(scope.desktopDir, `${snapshot}/desktop-home`, { recursive: true, verbatimSymlinks: true });
    },
    snapshot: async (work) => { events.push("freeze"); try { await work(); } finally { events.push("thaw"); } },
    fetchImpl: vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/checkpoint-url")) return Response.json({ name: "20260905T101500Z.tar.gz", upload: { url: "https://storage.invalid/upload", method: "PUT" } });
      if (url.endsWith("/upload")) {
        uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer());
        return new Response("");
      }
      if (url.endsWith("/commit")) { current = { ...JSON.parse(String(init?.body)), instanceId: "4242", generation: "9007199254740995", completedAt: 1000 }; return Response.json(current); }
      if (url.endsWith("/prune")) return Response.json({ deleted: 0 });
      if (url.endsWith("/download-url")) return current
        ? Response.json({ ...current, download: { url: "https://storage.invalid/download", method: "GET" } })
        : new Response("", { status: 404 });
      if (url.endsWith("/download")) return new Response(uploaded);
      throw new Error(`unexpected local fixture URL ${url}`);
    }) as typeof fetch,
  };
  const emptyGateway = async () => { await rm(scope.dataDir, { recursive: true }); await mkdir(scope.dataDir); };
  return { root, scope, deps, events, emptyGateway, archive: () => uploaded, checkpoint: () => current, required: () => { scope.restoreCheckpoint = current as unknown as GatewayVmHomeCheckpoint; } };
}

describe.skipIf(process.platform === "darwin" && !nativeDocker)("native home archive and recovery", () => {
  it("preserves arbitrary project and home state whose basenames resemble platform caches", async () => {
    const h = await fixture();
    const names = ["node_modules", ".npm", ".npm-cache", ".cache", ".pnpm-store", "Trash", "Cache", "Code Cache", "SingletonLock", "DevToolsActivePort"];
    for (const home of [h.scope.dataDir, h.scope.desktopDir]) {
      for (const name of names) {
        await mkdir(`${home}/project/${name}`, { recursive: true });
        await writeFile(`${home}/project/${name}/unpublished`, `dirty user state ${name}`);
      }
    }
    await checkpointHome(h.deps, h.scope, { force: true });
    h.required();
    for (const home of [h.scope.dataDir, h.scope.desktopDir]) await rm(`${home}/project`, { recursive: true });
    await restoreHome(h.deps, h.scope);
    for (const home of [h.scope.dataDir, h.scope.desktopDir]) {
      for (const name of names) expect(await readFile(`${home}/project/${name}/unpublished`, "utf8")).toBe(`dirty user state ${name}`);
    }
  });

  it("detects edits inside an existing cache-named user directory without relying on parent-directory changes", async () => {
    const h = await fixture();
    const directory = `${h.scope.desktopDir}/project/.cache`;
    const file = `${directory}/unpublished`;
    await mkdir(directory, { recursive: true });
    await writeFile(file, "old");
    await checkpointHome(h.deps, h.scope, { force: true });
    const marker = new Date("2090-01-01T00:00:00Z");
    await utimes(h.scope.marker, marker, marker);
    expect(await homeIsDirty(h.deps, h.scope)).toBe(false);
    await writeFile(file, "acknowledged edit");
    const newer = new Date("2091-01-01T00:00:00Z");
    await utimes(file, newer, newer);
    expect(await homeIsDirty(h.deps, h.scope)).toBe(true);
  });

  it("creates an absent SSH directory with private user ownership while metadata is unavailable", async () => {
    const h = await fixture();
    const { chmod, chown, stat } = await import("node:fs/promises");
    const owner = process.getuid?.() === 0 ? { uid: 1000, gid: 1000 } : await stat(h.scope.desktopDir);
    await chmod(h.root, 0o755);
    await chown(h.scope.desktopDir, owner.uid, owner.gid);
    await mkdir(`${h.scope.desktopDir}/.ssh`, { mode: 0o700 });
    await chown(`${h.scope.desktopDir}/.ssh`, owner.uid, owner.gid);
    await writeFile(`${h.scope.desktopDir}/.ssh/config`, "user SSH config\n");
    await checkpointHome(h.deps, h.scope, { force: true });
    h.required();
    await rm(`${h.scope.desktopDir}/.ssh`, { recursive: true });
    await restoreHome(h.deps, h.scope);
    const restored = await stat(`${h.scope.desktopDir}/.ssh`);
    expect({ uid: restored.uid, gid: restored.gid, mode: restored.mode & 0o777 }).toEqual({ uid: owner.uid, gid: owner.gid, mode: 0o700 });
    expect(await h.deps.fs.exists(`${h.scope.desktopDir}/.ssh/authorized_keys`)).toBe(false);
    if (process.getuid?.() === 0) {
      const written = await homeShell.run("setpriv", ["--reuid=1000", "--regid=1000", "--clear-groups", "sh", "-c", 'printf new > "$1/new-key"', "write-key", `${h.scope.desktopDir}/.ssh`]);
      expect(written.code).toBe(0);
    } else await writeFile(`${h.scope.desktopDir}/.ssh/new-key`, "new");
    expect(await readFile(`${h.scope.desktopDir}/.ssh/new-key`, "utf8")).toBe("new");
  });

  it("preserves current SSH authorization when the archive contains no SSH directory", async () => {
    const h = await fixture();
    await checkpointHome(h.deps, h.scope, { force: true });
    h.required();
    await mkdir(`${h.scope.desktopDir}/.ssh`, { mode: 0o700 });
    await writeFile(`${h.scope.desktopDir}/.ssh/authorized_keys`, "current-key-B\n", { mode: 0o600 });
    await writeFile(`${h.scope.desktopDir}/.ssh/seed-private-key`, "seed\n");
    await restoreHome(h.deps, h.scope);
    expect(await readFile(`${h.scope.desktopDir}/.ssh/authorized_keys`, "utf8")).toBe("current-key-B\n");
    expect(await h.deps.fs.exists(`${h.scope.desktopDir}/.ssh/seed-private-key`)).toBe(false);
  });

  it.each(["archive", "target"])("rejects a symlink in the protected SSH directory: %s", async (location) => {
    const h = await fixture();
    await mkdir(`${h.root}/outside-ssh`, { mode: 0o700 });
    await writeFile(`${h.root}/outside-ssh/authorized_keys`, "current-key-B\n");
    if (location === "archive") await symlink(`${h.root}/outside-ssh`, `${h.scope.desktopDir}/.ssh`);
    await checkpointHome(h.deps, h.scope, { force: true });
    h.required();
    if (location === "target") await symlink(`${h.root}/outside-ssh`, `${h.scope.desktopDir}/.ssh`);
    await expect(restoreHome(h.deps, h.scope)).rejects.toThrow("not a directory");
    expect(await readFile(`${h.root}/outside-ssh/authorized_keys`, "utf8")).toBe("current-key-B\n");
  });

  it.runIf(process.platform === "darwin")("demonstrates post-snapshot SSH writes under protocol 2 and refuses to replace that live home", async () => {
    const h = await fixture();
    const ssh = `${h.scope.desktopDir}/.ssh`;
    await mkdir(ssh, { mode: 0o700 });
    const auth = await sshAuthentication(h.root, `${ssh}/authorized_keys`);
    try {
      const capture = h.deps.captureSnapshot;
      const document = `${h.scope.desktopDir}/Documents/project.txt`;
      expect(document).toMatch(/^[-a-zA-Z0-9/_.]+$/);
      h.deps.captureSnapshot = async () => {
        await capture();
        expect(await auth.authenticate("B", `printf 'late SSH write' >> ${document}`)).toBe(true);
      };
      await checkpointHome(h.deps, h.scope, { force: true });
      expect(h.checkpoint()).toMatchObject({ writerProtocol: 2 });
      const archive = `${h.root}/archive-proof.tar.gz`;
      await writeFile(archive, h.archive());
      const captured = await homeShell.run("tar", ["--extract", "--gzip", "--to-stdout", `--file=${archive}`, "desktop-home/Documents/project.txt"]);
      expect(captured.code).toBe(0);
      expect(captured.stdout).toBe("User document");
      h.required();
      h.deps.desktop.run = async () => { throw new Error("SSH session writers have no verified host fence"); };
      await expect(restoreHome(h.deps, h.scope)).rejects.toThrow("SSH session writers");
      expect(await readFile(document, "utf8")).toBe("User documentlate SSH write");
    } finally {
      await auth.close();
    }
  }, 10_000);

  it.runIf(process.platform === "darwin")("preserves actual SSH authentication through revoked-key restore and an atomic metadata refresh", async () => {
    const h = await fixture();
    const ssh = `${h.scope.desktopDir}/.ssh`;
    await mkdir(ssh, { mode: 0o700 });
    const auth = await sshAuthentication(h.root, `${ssh}/authorized_keys`);
    try {
      await writeFile(`${ssh}/authorized_keys`, await auth.publicKey("A"));
      expect(await auth.authenticate("A")).toBe(true);
      await writeFile(`${ssh}/config`, "user SSH config\n");
      const shell = h.deps.shell;
      h.deps.shell = { run: (command, args) => shell.run(command, command === "tar" && args.includes("--create") ? args.filter((arg) => !arg.startsWith("--exclude=desktop-home/.ssh/authorized_keys")) : args) };
      await checkpointHome(h.deps, h.scope, { force: true });
      h.required();
      await h.emptyGateway();
      await writeFile(`${ssh}/authorized_keys`, await auth.publicKey("B"));
      const replace = h.deps.fs.replaceDirectory;
      h.deps.fs.replaceDirectory = async (source, target) => {
        if (target === `${ssh}/config`) {
          expect(await auth.authenticate("A")).toBe(false);
          expect(await auth.authenticate("B")).toBe(true);
          const { rename } = await import("node:fs/promises");
          await writeFile(`${ssh}/authorized_keys.metadata`, await auth.publicKey("C"), { mode: 0o600 });
          await rename(`${ssh}/authorized_keys.metadata`, `${ssh}/authorized_keys`);
          expect(await auth.authenticate("A")).toBe(false);
          expect(await auth.authenticate("C")).toBe(true);
        }
        await replace(source, target);
      };
      await restoreHome(h.deps, h.scope);
      expect(await readFile(`${ssh}/authorized_keys`, "utf8")).toBe(await auth.publicKey("C"));
      expect(await auth.authenticate("A")).toBe(false);
      expect(await auth.authenticate("B")).toBe(false);
      expect(await auth.authenticate("C"), auth.diagnostics()).toBe(true);
    } finally {
      await auth.close();
    }
  }, 10_000);

  it("leaves the live home untouched when the host cannot fence SSH writers for full-home installation", async () => {
    const h = await fixture();
    await checkpointHome(h.deps, h.scope, { force: true });
    h.required();
    await writeFile(`${h.scope.desktopDir}/Documents/project.txt`, "new SSH writes after the snapshot");
    h.deps.desktop.run = async (action) => {
      expect(action).toBe("stop-home");
      throw new Error("SSH session writers have no verified host fence");
    };
    await expect(restoreHome(h.deps, h.scope)).rejects.toThrow("SSH session writers");
    expect(await readFile(`${h.scope.desktopDir}/Documents/project.txt`, "utf8")).toBe("new SSH writes after the snapshot");
    expect(await h.deps.fs.exists(h.scope.restorePending)).toBe(false);
  });

  it.each(["current-key", "metadata-unavailable", "metadata-race", "no-current-key"])("never replays archived SSH authorization during restore: %s", async (scenario) => {
    const h = await fixture();
    const ssh = `${h.scope.desktopDir}/.ssh`;
    await mkdir(ssh, { mode: 0o700 });
    await writeFile(`${ssh}/authorized_keys`, "revoked-key-A\n", { mode: 0o600 });
    await writeFile(`${ssh}/authorized_keys.metadata`, "revoked-key-A\n", { mode: 0o600 });
    await writeFile(`${ssh}/config`, "user SSH config\n");
    await writeFile(`${ssh}/id_ed25519`, "user private key\n", { mode: 0o600 });
    const shell = h.deps.shell;
    h.deps.shell = { run: (command, args) => shell.run(command, command === "tar" && args.includes("--create") ? args.filter((arg) => !arg.startsWith("--exclude=desktop-home/.ssh/authorized_keys")) : args) };
    await checkpointHome(h.deps, h.scope, { force: true });
    h.required();
    if (scenario === "no-current-key") await rm(`${ssh}/authorized_keys`);
    else await writeFile(`${ssh}/authorized_keys`, "current-key-B\n");
    await rm(`${ssh}/authorized_keys.metadata`);
    await writeFile(`${ssh}/config`, "seed config\n");
    await h.emptyGateway();
    const { stat, rename } = await import("node:fs/promises");
    const inode = (await stat(ssh)).ino;
    const replace = h.deps.fs.replaceDirectory;
    h.deps.fs.replaceDirectory = async (source, target) => {
      expect(target).not.toBe(ssh);
      expect(target).not.toMatch(/\/authorized_keys(?:\.metadata)?$/);
      if (scenario === "metadata-race" && target === `${ssh}/config`) {
        await writeFile(`${ssh}/authorized_keys.metadata`, "current-key-C\n", { mode: 0o600 });
        await rename(`${ssh}/authorized_keys.metadata`, `${ssh}/authorized_keys`);
      }
      await replace(source, target);
    };
    await restoreHome(h.deps, h.scope);
    expect((await stat(ssh)).ino).toBe(inode);
    if (scenario === "no-current-key") expect(await h.deps.fs.exists(`${ssh}/authorized_keys`)).toBe(false);
    else expect(await readFile(`${ssh}/authorized_keys`, "utf8")).toBe(scenario === "metadata-race" ? "current-key-C\n" : "current-key-B\n");
    expect(await h.deps.fs.exists(`${ssh}/authorized_keys.metadata`)).toBe(false);
    expect(await readFile(`${ssh}/config`, "utf8")).toBe("user SSH config\n");
    expect(await readFile(`${ssh}/id_ed25519`, "utf8")).toBe("user private key\n");
  });

  it("detects deletion of an entire desktop persistence directory", async () => {
    const h = await fixture();
    await h.deps.fs.touch(h.scope.marker, Date.now() - 10_000);
    const { utimes } = await import("node:fs/promises");
    const old = new Date(Date.now() - 20_000);
    await h.deps.shell.run("find", [h.root, "-exec", "touch", "-h", "-t", "202001010000", "{}", "+"]);
    await h.deps.fs.touch(h.scope.marker, Date.now() - 10_000);
    await utimes(h.scope.desktopDir, old, old);
    expect(await homeIsDirty(h.deps, h.scope)).toBe(false);
    await rm(`${h.scope.desktopDir}/Documents`, { recursive: true });
    expect(await homeIsDirty(h.deps, h.scope)).toBe(true);
  });

  it("preserves user files named like legacy restore staging paths", async () => {
    const h = await fixture();
    for (const name of ["a", "a.octogee-restore-stage", "a.octogee-restore-backup"]) {
      await writeFile(`${h.scope.desktopDir}/${name}`, name);
    }
    await checkpointHome(h.deps, h.scope, { force: true });
    h.required();
    await h.emptyGateway();
    await restoreHome(h.deps, h.scope);
    for (const name of ["a", "a.octogee-restore-stage", "a.octogee-restore-backup"]) {
      expect(await readFile(`${h.scope.desktopDir}/${name}`, "utf8")).toBe(name);
    }
  });

  it("restores the desktop profile, Documents, and gateway home while excluding caches and tokens", async () => {
    const h = await fixture();
    await checkpointHome(h.deps, h.scope, { force: true });
    await h.emptyGateway();
    await rm(h.scope.desktopDir, { recursive: true });
    await mkdir(h.scope.desktopDir);
    expect(await restoreHome(h.deps, h.scope)).toMatchObject({ status: "restored" });
    expect(await readFile(`${h.scope.dataDir}/gateway.txt`, "utf8")).toBe("gateway state");
    expect(await readFile(`${h.scope.desktopDir}/.config/octogee-chromium/Default/Preferences`, "utf8")).toBe("browser profile");
    expect(await readFile(`${h.scope.desktopDir}/Documents/project.txt`, "utf8")).toBe("User document");
    expect(await h.deps.fs.exists(`${h.scope.desktopDir}/.config/octogee-chromium/Default/Cache/disposable`)).toBe(false);
    expect(await h.deps.fs.exists(`${h.scope.dataDir}/tokens`)).toBe(false);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(`${h.scope.desktopDir}/.config/octogee-chromium`)).toEqual(["Default"]);
    expect(h.events).toEqual(["freeze", "thaw", "stop-home", "reconcile-tools"]);
  });

  it("retries extraction failures without treating partially extracted staging files as a live home", async () => {
    const h = await fixture();
    await checkpointHome(h.deps, h.scope, { force: true });
    await h.emptyGateway();
    const shell = h.deps.shell;
    h.deps.shell = { run: async (command, args) => { await shell.run(command, args); return { code: 2, stdout: "", stderr: "injected disk exhaustion" }; } };
    await expect(restoreHome(h.deps, h.scope)).rejects.toThrow("injected disk exhaustion");
    expect(await h.deps.fs.listDir(h.scope.dataDir)).toEqual([]);
    expect(h.events).toEqual(["freeze", "thaw"]);
    h.deps.shell = shell;
    expect(await restoreHome(h.deps, h.scope)).toMatchObject({ status: "restored" });
  });

  it("sweeps an interrupted gated restore's staging off the home disk before downloading the checkpoint again", async () => {
    const h = await fixture();
    await checkpointHome(h.deps, h.scope, { force: true });
    h.required();
    await h.emptyGateway();
    await writeFile(h.scope.restoreGate, "");
    const leftovers = [`${h.root}/tmp/octogee-home-restore-interrupted`, `${h.scope.desktopDir}/.octogee-restore-interrupted`, `${h.scope.desktopDir}/.config/.octogee-restore-interrupted`];
    for (const leftover of leftovers) {
      await mkdir(`${leftover}/stage`, { recursive: true });
      await writeFile(`${leftover}/stage/partial`, "partial copy");
    }
    const fetchImpl = h.deps.fetchImpl;
    let presentAtDownload: boolean[] = [];
    h.deps.fetchImpl = (async (input, init) => {
      if (String(input).endsWith("/download")) presentAtDownload = await Promise.all(leftovers.map((path) => h.deps.fs.exists(path)));
      return fetchImpl(input, init);
    }) as typeof fetch;
    expect(await restoreHome(h.deps, h.scope)).toMatchObject({ status: "restored" });
    expect(presentAtDownload).toEqual([false, false, false]);
    expect(await readFile(`${h.scope.dataDir}/gateway.txt`, "utf8")).toBe("gateway state");
    expect(await h.deps.fs.exists(h.scope.restoreGate)).toBe(true);
  });

  it("keeps the desktop closed and resumes an interrupted installation even after the gateway directory becomes nonempty", async () => {
    const h = await fixture();
    await checkpointHome(h.deps, h.scope, { force: true });
    await h.emptyGateway();
    const replace = h.deps.fs.replaceDirectory;
    h.deps.fs.replaceDirectory = async (source, target) => {
      if (target !== h.scope.dataDir) throw new Error("injected installation interruption");
      await replace(source, target);
    };
    await expect(restoreHome(h.deps, h.scope)).rejects.toThrow("installation interruption");
    expect(await h.deps.fs.listDir(h.scope.dataDir)).toEqual(["gateway.txt"]);
    expect(await h.deps.fs.exists(h.scope.restorePending)).toBe(true);
    expect(h.events).not.toContain("start");
    h.deps.fs.replaceDirectory = replace;
    expect(await restoreHome(h.deps, h.scope)).toMatchObject({ status: "restored" });
    expect(await h.deps.fs.exists(h.scope.restorePending)).toBe(false);
    expect(h.events).not.toContain("start");
  });

  it("does not upload an incomplete archive, and releases the snapshot protection on failure", async () => {
    const h = await fixture();
    h.deps.shell = { run: async () => ({ code: 1, stdout: "", stderr: "file changed as we read it" }) };
    await expect(checkpointHome(h.deps, h.scope, { force: true })).rejects.toThrow("exited 1");
    expect(h.deps.fetchImpl).not.toHaveBeenCalled();
    expect(h.events).toEqual(["freeze", "thaw"]);
  });
  it("restores full Omarchy home files and metadata, omitting only the owned toolchain cache", async () => {
    const h = await fixture();
    for (const name of ["Desktop", "Downloads", "Pictures", ".ssh", ".local/share/custom", "projects/npm-cache"] ) await mkdir(`${h.scope.desktopDir}/${name}`, { recursive: true });
    for (const name of ["Desktop/file", "Downloads/file", "Pictures/file", ".ssh/key", ".local/share/custom/file", "projects/npm-cache/file"]) await writeFile(`${h.scope.desktopDir}/${name}`, name, { mode: 0o640 });
    await symlink("Downloads/file", `${h.scope.desktopDir}/download-link`);
    await mkdir(`${h.scope.dataDir}/.octogee/toolchains/npm-cache`, { recursive: true });
    await writeFile(`${h.scope.dataDir}/.octogee/toolchains/npm-cache/disposable`, "cache");
    const { chmod } = await import("node:fs/promises");
    await chmod(h.scope.desktopDir, 0o710);
    await checkpointHome(h.deps, h.scope, { force: true });
    h.required();
    await writeFile(`${h.scope.dataDir}/seed`, "image seed");
    await rm(h.scope.desktopDir, { recursive: true });
    await mkdir(h.scope.desktopDir);
    expect(await restoreHome(h.deps, h.scope)).toMatchObject({ status: "restored" });
    for (const name of ["Desktop/file", "Downloads/file", "Pictures/file", ".ssh/key", ".local/share/custom/file", "projects/npm-cache/file"]) expect(await readFile(`${h.scope.desktopDir}/${name}`, "utf8")).toBe(name);
    const { readlink, stat } = await import("node:fs/promises");
    expect(await readlink(`${h.scope.desktopDir}/download-link`)).toBe("Downloads/file");
    expect((await stat(`${h.scope.desktopDir}/.ssh/key`)).mode & 0o777).toBe(0o640);
    expect((await stat(h.scope.desktopDir)).mode & 0o777).toBe(0o710);
    expect(await h.deps.fs.exists(`${h.scope.dataDir}/seed`)).toBe(false);
    expect(await h.deps.fs.exists(`${h.scope.dataDir}/.octogee/toolchains/npm-cache/disposable`)).toBe(false);
    await writeFile(`${h.scope.desktopDir}/Downloads/newer`, "after restore");
    expect(await restoreHome(h.deps, h.scope)).toEqual({ status: "preserved" });
    expect(await readFile(`${h.scope.desktopDir}/Downloads/newer`, "utf8")).toBe("after restore");
  });

});
