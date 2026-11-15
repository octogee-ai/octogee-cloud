import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VM_HOME_CHECKPOINT_MAX_BYTES } from "@octogee/shared/types/glm";
import {
  DESKTOP_HOME_PATHS,
  HOME_DESKTOP_TOOL_PATHS,
  HOME_METADATA_AUTHORIZATION,
  admitHome,
  checkpointHome,
  homeScope,
  restoreHome,
  tarCreateArgs,
  tarExtractArgs,
  findDirtyArgs,
  type HomeCheckpointDeps,
  type HomeScope,
} from "../../lib/vm-gateway-agent/home-checkpoint";
import { bundleFixture } from "./fixture";

const SHA = "c".repeat(64);
const NAME = "20260905T101500Z.tar.gz";

interface FakeHome {
  deps: HomeCheckpointDeps;
  scope: HomeScope;
  shell: string[];
  fetches: Array<{ url: string; init: RequestInit }>;
  touched: Array<{ path: string; at: number }>;
  removed: string[];
  files: Set<string>;
  world: { dataEntries: string[]; markerExists: boolean; dirty: boolean; archiveSize: number; tarCode: number; savedSize: number; freeBytes: number; dirs: Record<string, string[]> };
  routes: Record<string, () => { status: number; body: unknown }>;
}

function fakeHome(overrides: Partial<FakeHome["world"]> = {}, routes: FakeHome["routes"] = {}): FakeHome {
  const world = { dataEntries: ["README.md"], markerExists: true, dirty: true, archiveSize: 2048, tarCode: 0, savedSize: 2048, freeBytes: 1024 ** 4, dirs: {}, ...overrides };
  const shell: string[] = [];
  const fetches: FakeHome["fetches"] = [];
  const touched: FakeHome["touched"] = [];
  const removed: string[] = [];
  const files = new Set<string>();
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    fetches.push({ url: String(url), init: init ?? {} });
    const key = String(url).replace(/^https?:\/\/[^/]+/, "");
    const route = routes[key];
    if (!route) return new Response("", { status: 200 });
    const r = route();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const deps: HomeCheckpointDeps = {
    gatewayId: "b-x",
    apiUrl: "http://10.128.9.9:3001",
    metadata: { identityToken: async (aud) => `id-${aud}` },
    fetchImpl,
    stateRoot: "/srv/octogee",
    desktop: { tools: vi.fn(async () => ({ rebuildable: true })), run: vi.fn(async () => {}) },
    snapshot: async (work) => work(),
    captureSnapshot: async () => {},
    discardSnapshot: async () => {},
    shell: {
      run: async (command, args) => {
        shell.push(`${command} ${args.join(" ")}`);
        if (command === "sync") return { code: 0, stdout: "", stderr: "" };
        if (command === "find") return { code: 0, stdout: world.dirty ? "/srv/octogee/volumes/data/x\n" : "", stderr: "" };
        return { code: world.tarCode, stdout: "", stderr: world.tarCode > 1 ? "tar: boom" : "" };
      },
    },
    fs: {
      listDir: async (path) => world.dirs[path] ?? world.dataEntries,
      freeBytes: async () => world.freeBytes,
      exists: async (path) => files.has(path) || path.endsWith("/data") || path.endsWith("/desktop-home") || (path.endsWith("home-checkpoint.marker") && world.markerExists),
      mkdir: async () => {},
      replaceDirectory: async () => {},
      retainToolStorage: async () => {},
        replaceDirectoryContents: async () => {},
      fileSize: async (path) => (path.includes("home-restore") ? world.savedSize : world.archiveSize),
      sha256: async () => SHA,
      mkdtemp: async (prefix) => `/tmp/${prefix}xyz`,
      rm: async (path) => { removed.push(path); files.delete(path); },
      touch: async (path, at) => { touched.push({ path, at }); files.add(path); },
      uploadBody: async (path) => `body:${path}`,
      saveResponse: async () => {},
    },
    now: () => 1_700_000_000_000,
    log: vi.fn(),
    logError: vi.fn(),
  };
  const scope = homeScope("/srv/octogee", bundleFixture({
    builderIdentity: { ownerUid: "uid-bob", builderSlug: "bob" },
  }))!;
  scope.desktopToolsRebuildable = true;
  return { deps, scope, shell, fetches, touched, removed, files, world, routes };
}

const signedUpload = { url: "https://storage.example/customers/bob/computer-home/checkpoints/x", method: "PUT" as const, gcsPath: "p", expiresAt: "e", requiredHeaders: { "x-goog-if-generation-match": "0" } };

describe("homeScope", () => {
  it("derives the home volume and user slug from the bundle and is absent when either is missing", () => {
    const scope = homeScope("/srv/octogee", bundleFixture({ builderIdentity: { ownerUid: "uid-bob", builderSlug: "bob" } }));
    expect(scope).toEqual({ slug: "bob", dataDir: "/srv/octogee/volumes/data", marker: "/srv/octogee/home-checkpoint.marker", desktopDir: "/srv/octogee/desktop-home", restorePending: "/srv/octogee/home-restore.pending", restoreGate: "/srv/octogee/home-restore.gate", hostToolInventory: true });
    expect(homeScope("/srv/octogee", bundleFixture())).toBeNull();
    expect(homeScope("/srv/octogee", bundleFixture({ volumes: [{ name: "data", kind: "identityToken", audience: "x" }] }))).toBeNull();
  });
});

describe("checkpointHome", () => {
  it("records separate inventory, snapshot, archive, hash, upload and commit timings for a requested checkpoint", async () => {
    const requestedAt = 10_000;
    let now = 12_000;
    const h = fakeHome({}, {
      "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 200, body: { name: NAME, upload: signedUpload } }),
      "/customers/bob/computer-home/checkpoints/x": () => { now += 13; return { status: 200, body: {} }; },
      "/internal/fleet/computer-home/commit": () => { now += 17; return { status: 200, body: { name: NAME } }; },
    });
    h.deps.now = () => now;
    h.deps.desktop.tools = async () => { now += 2; return { rebuildable: true }; };
    h.deps.captureSnapshot = async () => { now += 3; };
    h.deps.shell.run = async () => { now += 5; return { code: 0, stdout: "", stderr: "" }; };
    h.deps.fs.sha256 = async () => { now += 7; return SHA; };

    await checkpointHome(h.deps, h.scope, { force: true, requestedAt });

    const events = vi.mocked(h.deps.log).mock.calls.map(([, fields]) => fields).filter((fields) => fields?.category === "home-checkpoint");
    expect(events.map((event) => `${event?.phase}:${event?.status}`)).toEqual([
      "inventory-before-snapshot:running", "inventory-before-snapshot:done",
      "snapshot:running", "inventory-in-snapshot:running", "inventory-in-snapshot:done", "snapshot:done",
      "archive:running", "archive:done", "hash:running", "hash:done",
      "upload:running", "upload:done", "commit:running", "commit:done",
    ]);
    expect(events.filter((event) => event?.status === "running").every((event) => event?.durationMs === undefined)).toBe(true);
    expect(events.filter((event) => event?.status === "done")).toEqual([
      { phase: "inventory-before-snapshot", durationMs: 2 },
      { phase: "inventory-in-snapshot", durationMs: 2 },
      { phase: "snapshot", durationMs: 5 },
      { phase: "archive", durationMs: 5 },
      { phase: "hash", durationMs: 7 },
      { phase: "upload", durationMs: 13, checkpointName: NAME, sizeBytes: 2048 },
      { phase: "commit", durationMs: 17, checkpointName: NAME, sizeBytes: 2048 },
    ].map((phase) => ({ gatewayId: "b-x", builderSlug: "bob", requestedAt, category: "home-checkpoint", status: "done", ...phase })));
  });

  it("preserves the archive error when snapshot cleanup also fails", async () => {
    const h = fakeHome({ tarCode: 2 });
    let cleanups = 0;
    h.deps.discardSnapshot = async () => { if (++cleanups === 2) throw new Error("snapshot deletion failed"); };
    await expect(checkpointHome(h.deps, h.scope, { force: true })).rejects.toThrow(/tar --create exited 2.*snapshot deletion failed/);
    expect(h.removed).toEqual(["/tmp/octogee-home-checkpoint-xyz"]);
  });

  it("thaws writers before compression and archives only the captured filesystem snapshot", async () => {
    const h = fakeHome({}, {
      "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 200, body: { name: NAME, upload: signedUpload } }),
      "/internal/fleet/computer-home/commit": () => ({ status: 200, body: { name: NAME, size: 2048, sha256: SHA } }),
      "/internal/fleet/computer-home/prune": () => ({ status: 200, body: { deleted: 0 } }),
    });
    let frozen = false;
    const events: string[] = [];
    h.deps.snapshot = async (work) => { frozen = true; try { await work(); } finally { frozen = false; events.push("thaw"); } };
    h.deps.captureSnapshot = async () => { expect(frozen).toBe(true); events.push("snapshot-home"); };
    h.deps.discardSnapshot = async () => { events.push("discard-home-snapshot"); };
    const run = h.deps.shell.run;
    h.deps.shell.run = async (command, args) => {
      if (command === "tar") {
        expect(frozen).toBe(false);
        expect(args).toContain("/srv/octogee/.home-checkpoint/snapshot/volumes/data/..");
        events.push("compress");
      }
      return run(command, args);
    };
    await checkpointHome(h.deps, h.scope, { force: true });
    expect(events).toEqual(["discard-home-snapshot", "snapshot-home", "thaw", "compress", "discard-home-snapshot"]);
  });

  it("is a no-op when nothing changed since the marker", async () => {
    const h = fakeHome({ dirty: false });
    expect(await checkpointHome(h.deps, h.scope, { force: false })).toEqual({ status: "clean" });
    expect(h.shell).toEqual([
      "find /srv/octogee/volumes/data ( -path /srv/octogee/volumes/data/.octogee/toolchains/npm-cache -o -path /srv/octogee/volumes/data/.octogee-source-doctor-diagnostics -o -path /srv/octogee/volumes/data/.octogee-carried-agent-diagnostics ) -prune -o -newer /srv/octogee/home-checkpoint.marker -print -quit",
      "find /srv/octogee/desktop-home ( -path /srv/octogee/desktop-home/.local/share/mise -o -path /srv/octogee/desktop-home/.cache/mise -o -path /srv/octogee/desktop-home/.npm -o -path /srv/octogee/desktop-home/.config/octogee-chromium/Default/Cache -o -path /srv/octogee/desktop-home/.config/octogee-chromium/SingletonLock -o -path /srv/octogee/desktop-home/.config/octogee-chromium/SingletonCookie -o -path /srv/octogee/desktop-home/.config/octogee-chromium/SingletonSocket -o -path /srv/octogee/desktop-home/.config/octogee-chromium/DevToolsActivePort -o -path /srv/octogee/desktop-home/.ssh/authorized_keys -o -path /srv/octogee/desktop-home/.ssh/authorized_keys.metadata ) -prune -o -newer /srv/octogee/home-checkpoint.marker -print -quit",
    ]);
    expect(h.fetches).toEqual([]);
  });

  it("carries the desktop's Octogee config (the Desk note) in the checkpoint alongside the browser profile and Omarchy config", async () => {
    expect(DESKTOP_HOME_PATHS).toEqual([".config/octogee-chromium", ".config/hypr", ".config/omarchy", ".config/octogee", "Documents"]);
    const h = fakeHome({}, {
      "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 200, body: { name: NAME, upload: signedUpload } }),
      "/internal/fleet/computer-home/commit": () => ({ status: 200, body: { name: NAME, size: 2048, sha256: SHA, completedAt: 5 } }),
      "/internal/fleet/computer-home/prune": () => ({ status: 200, body: { deleted: 0 } }),
    });
    const present = new Set(["/srv/octogee/.home-checkpoint/snapshot/desktop-home/.config/octogee", "/srv/octogee/.home-checkpoint/snapshot/desktop-home/Documents"]);
    const baseExists = h.deps.fs.exists;
    h.deps.fs.exists = async (path) => present.has(path) || baseExists(path);
    await checkpointHome(h.deps, h.scope, { force: true });
    const tar = h.shell.find((line) => line.startsWith("tar "))!;
    expect(tar).toContain("-C /srv/octogee/.home-checkpoint/snapshot/desktop-home/.. desktop-home");
    expect(tar).not.toContain("desktop-home/.config/hypr");
  });

  it("archives arbitrary user paths while excluding only explicit platform runtime state, uploads to the signed create-only URL, commits, marks the start time, and prunes", async () => {
    const h = fakeHome({}, {
      "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 200, body: { name: NAME, upload: signedUpload } }),
      "/internal/fleet/computer-home/commit": () => ({ status: 200, body: { name: NAME, size: 2048, sha256: SHA, completedAt: 5 } }),
      "/internal/fleet/computer-home/prune": () => ({ status: 200, body: { deleted: 2 } }),
    });
    const result = await checkpointHome(h.deps, h.scope, { force: false });
    expect(result).toEqual({ status: "uploaded", name: NAME, size: 2048, pruned: 2 });
    const tar = h.shell.find((line) => line.startsWith("tar "))!;
    expect(tar).toContain("--create --gzip --numeric-owner");
    expect(tar).toContain("--file=/tmp/octogee-home-checkpoint-xyz/home.tar.gz");
    expect(tar).toContain("-C /srv/octogee/.home-checkpoint/snapshot/volumes/data/.. data");
    expect(tar).not.toContain("--exclude=node_modules");
    expect(tar).not.toContain("--exclude=Code Cache");
    expect(tar).toContain("--anchored");
    expect(tar).toContain("--exclude=desktop-home/.config/octogee-chromium/Default/Cache");
    expect(tar).not.toContain("--ignore-failed-read");

    const [url, upload, commit, prune] = h.fetches;
    expect(url.url).toBe("http://10.128.9.9:3001/internal/fleet/computer-home/checkpoint-url");
    expect(JSON.parse(String(url.init.body))).toEqual({ gatewayId: "b-x", slug: "bob", size: 2048 });
    expect(url.init.headers).toMatchObject({ "x-k8s-sa-token": "id-octogee-api", "x-octogee-gateway-credential-token": "id-octogee-api-gateway-credentials" });
    expect(upload).toMatchObject({ url: signedUpload.url, init: { method: "PUT", body: "body:/tmp/octogee-home-checkpoint-xyz/home.tar.gz" } });
    expect(upload.init.headers).toEqual({ "content-type": "application/gzip", "x-goog-if-generation-match": "0" });
    expect(JSON.parse(String(commit.init.body))).toEqual({ gatewayId: "b-x", slug: "bob", name: NAME, size: 2048, sha256: SHA, requestedAt: null, coverage: "builder-home-v2", writerProtocol: 2 });
    expect(JSON.parse(String(prune.init.body))).toEqual({ gatewayId: "b-x", slug: "bob" });
    expect(h.touched).toEqual([{ path: "/srv/octogee/home-checkpoint.marker", at: 1_700_000_000_000 }]);
    expect(h.removed).toEqual(["/tmp/octogee-home-checkpoint-xyz"]);
  });

  it("force skips the dirty check and a prune failure does not fail the checkpoint", async () => {
    const h = fakeHome({ dirty: false }, {
      "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 200, body: { name: NAME, upload: signedUpload } }),
      "/internal/fleet/computer-home/commit": () => ({ status: 200, body: { name: NAME, size: 2048, sha256: SHA, completedAt: 5 } }),
      "/internal/fleet/computer-home/prune": () => ({ status: 502, body: { error: "boom" } }),
    });
    expect(await checkpointHome(h.deps, h.scope, { force: true })).toEqual({ status: "uploaded", name: NAME, size: 2048, pruned: null });
    expect(h.shell.some((line) => line.startsWith("find "))).toBe(false);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining("prune failed"));
  });

  it("refuses an oversized or empty archive and surfaces tar, upload, and commit failures, always cleaning up", async () => {
    const big = fakeHome({ archiveSize: VM_HOME_CHECKPOINT_MAX_BYTES + 1 });
    await expect(checkpointHome(big.deps, big.scope, { force: true })).rejects.toThrow(/over the .* byte cap/);
    expect(big.fetches).toEqual([]);
    expect(big.removed).toEqual(["/tmp/octogee-home-checkpoint-xyz"]);

    const empty = fakeHome({ archiveSize: 0 });
    await expect(checkpointHome(empty.deps, empty.scope, { force: true })).rejects.toThrow(/archive is empty/);

    const tarFailed = fakeHome({ tarCode: 2 });
    await expect(checkpointHome(tarFailed.deps, tarFailed.scope, { force: true })).rejects.toThrow(/tar --create exited 2: tar: boom/);

    const denied = fakeHome({}, { "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 403, body: { error: "forbidden" } }) });
    await expect(checkpointHome(denied.deps, denied.scope, { force: true })).rejects.toThrow(/checkpoint-url: HTTP 403/);

    const uploadFailed = fakeHome({}, {
      "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 200, body: { name: NAME, upload: { ...signedUpload, url: "https://storage.example/fail" } } }),
      "/fail": () => ({ status: 412, body: {} }),
    });
    await expect(checkpointHome(uploadFailed.deps, uploadFailed.scope, { force: true })).rejects.toThrow(/upload: HTTP 412/);
    expect(uploadFailed.touched).toEqual([]);
  });
});

it("keeps checkpointing and preserves tool storage if optional inventory is unreadable", async () => {
  const h = fakeHome({}, {
    "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 200, body: { name: NAME, upload: { url: "https://storage.example/upload", method: "PUT", requiredHeaders: {} } } }),
    "/internal/fleet/computer-home/commit": () => ({ status: 200, body: { name: NAME } }),
  });
  h.deps.desktop.tools = vi.fn(async () => { throw new Error("optional cache unreadable"); });
  expect(await checkpointHome(h.deps, h.scope, { force: true })).toMatchObject({ status: "uploaded" });
  expect(h.shell.find(value => value.startsWith("tar --create"))).not.toContain("--exclude=desktop-home/.local/share/mise");
  expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining("retaining tool storage"));
});

it("archives the X11 gateway's tool storage instead of trusting the host home's inventory", async () => {
  const h = fakeHome({}, {
    "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 200, body: { name: NAME, upload: { url: "https://storage.example/upload", method: "PUT", requiredHeaders: {} } } }),
    "/internal/fleet/computer-home/commit": () => ({ status: 200, body: { name: NAME } }),
  });
  const scope = homeScope("/srv/octogee", bundleFixture({ desktop: "x11", builderIdentity: { ownerUid: "uid-bob", builderSlug: "bob" } }))!;
  expect(scope.hostToolInventory).toBe(false);
  expect(await checkpointHome(h.deps, scope, { force: true })).toMatchObject({ status: "uploaded" });
  expect(h.deps.desktop.tools).not.toHaveBeenCalled();
  const tar = h.shell.find(value => value.startsWith("tar --create"));
  expect(tar).not.toContain("--exclude=desktop-home/.local/share/mise");
  expect(tar).toContain("--exclude=desktop-home/.cache/mise");
});

describe("restoreHome", () => {
  const record = { name: NAME, size: 2048, sha256: SHA, completedAt: 5, download: { url: "https://storage.example/download", method: "GET", gcsPath: "p", expiresAt: "e" } };

  it("never touches a non-empty home", async () => {
    const h = fakeHome();
    expect(await restoreHome(h.deps, h.scope)).toEqual({ status: "preserved" });
    expect(h.fetches).toEqual([]);
    expect(h.shell).toEqual([]);
    expect(h.deps.log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      gatewayId: "b-x", builderSlug: "bob", category: "home-restore", phase: "select-checkpoint", status: "skipped", reason: "home-preserved",
    }));
  });

  it("reports no checkpoint for a fresh user", async () => {
    const h = fakeHome({ dataEntries: [] }, { "/internal/fleet/computer-home/download-url": () => ({ status: 404, body: { error: "no_checkpoint" } }) });
    expect(await restoreHome(h.deps, h.scope)).toEqual({ status: "none" });
    expect(h.shell).toEqual([]);
    expect(h.deps.log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      category: "home-restore", phase: "select-checkpoint", status: "skipped", reason: "no-checkpoint",
    }));
  });

  it("times download, checksum verification, extraction, and installation without logging the signed URL", async () => {
    let now = 12_000;
    const h = fakeHome({ dataEntries: [] }, { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: record }) });
    h.deps.now = () => now;
    h.deps.fs.saveResponse = async () => { now += 7; };
    h.deps.fs.sha256 = async () => { now += 5; return SHA; };
    h.deps.shell.run = async () => { now += 13; return { code: 0, stdout: "", stderr: "" }; };
    h.deps.desktop.run = async () => { now += 3; };
    h.deps.fs.replaceDirectory = async () => { now += 17; };

    await expect(restoreHome(h.deps, h.scope)).resolves.toMatchObject({ status: "restored" });

    const logs = vi.mocked(h.deps.log).mock.calls;
    expect(logs.map(([, fields]) => fields)).toEqual(expect.arrayContaining([
      { phase: "download", durationMs: 7 },
      { phase: "hash", durationMs: 5 },
      { phase: "extract", durationMs: 13 },
      { phase: "install", durationMs: 36 },
    ].map((phase) => ({ gatewayId: "b-x", builderSlug: "bob", category: "home-restore", status: "done", checkpointName: NAME, sizeBytes: 2048, ...phase }))));
    expect(logs.map(([, fields]) => `${fields?.phase}:${fields?.status}`)).toEqual([
      "download:running", "download:done", "hash:running", "hash:done",
      "extract:running", "extract:done", "install:running", "install:done",
    ]);
    expect(JSON.stringify(logs)).not.toContain(record.download.url);
  });

  it("preserves current tool projections while restoring full desktop context behind the strict host fence", async () => {
    const h = fakeHome({ dataEntries: [] }, { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: { ...record, coverage: "builder-home-v2", writerProtocol: 2 } }) });
    h.deps.fs.replaceDirectoryContents = vi.fn(async () => {});
    await restoreHome(h.deps, h.scope);
    expect(h.deps.desktop.run).toHaveBeenNthCalledWith(1, "stop-home");
    expect(h.deps.fs.replaceDirectoryContents).toHaveBeenCalledWith(
      "/tmp/octogee-home-restore-xyz/staged/desktop-home", h.scope.desktopDir,
      [...HOME_METADATA_AUTHORIZATION, ...HOME_DESKTOP_TOOL_PATHS],
      HOME_METADATA_AUTHORIZATION,
    );
  });

  it("logs optional restored-tool rebuild failure and still completes the restore", async () => {
    const h = fakeHome({ dataEntries: [] }, { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: { ...record, coverage: "builder-home-v2", writerProtocol: 2 } }) });
    const actions: string[] = [];
    h.deps.desktop.run = async action => {
      actions.push(action);
      if (action === "reconcile-tools") throw new Error("optional tool install failed");
    };
    await expect(restoreHome(h.deps, h.scope)).resolves.toMatchObject({ status: "restored" });
    expect(actions).toEqual(["stop-home", "reconcile-tools"]);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining("preserving declarations for retry"));
  });

  it("downloads the current checkpoint, verifies size and digest, extracts it into the empty home, and marks it clean", async () => {
    const h = fakeHome({ dataEntries: [] }, { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: record }) });
    expect(await restoreHome(h.deps, h.scope)).toEqual({ status: "restored", name: NAME, size: 2048 });
    expect(h.fetches[1]).toMatchObject({ url: "https://storage.example/download", init: { method: "GET" } });
    expect(h.shell).toEqual([
      "tar --extract --gzip --numeric-owner --same-owner --same-permissions --anchored --exclude=desktop-home/.cache/mise --exclude=desktop-home/.npm --exclude=data/.octogee-source-doctor-diagnostics --exclude=data/.octogee-carried-agent-diagnostics --file=/tmp/octogee-home-restore-xyz/home.tar.gz --directory=/tmp/octogee-home-restore-xyz/staged",
      "sync -f /srv/octogee",
    ]);
    expect(h.touched).toEqual([{ path: "/srv/octogee/home-restore.pending", at: 1_700_000_000_000 }, { path: "/srv/octogee/home-checkpoint.marker", at: 1_700_000_000_000 }]);
    expect(h.removed).toEqual(["/tmp/octogee-home-restore-xyz/home.tar.gz", "/srv/octogee/home-restore.pending", "/tmp/octogee-home-restore-xyz"]);
  });

  it("refuses a checkpoint whose bytes do not match the committed record and leaves the home untouched", async () => {
    const h = fakeHome({ dataEntries: [], savedSize: 2047 }, { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: record }) });
    await expect(restoreHome(h.deps, h.scope)).rejects.toThrow(/downloaded 2047 bytes, expected 2048/);
    const digest = fakeHome({ dataEntries: [] }, { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: { ...record, sha256: "d".repeat(64) } }) });
    await expect(restoreHome(digest.deps, digest.scope)).rejects.toThrow(/sha256 mismatch/);
    expect(h.shell).toEqual([]);
    expect(digest.shell).toEqual([]);
    expect(h.removed).toEqual(["/tmp/octogee-home-restore-xyz"]);
    expect(digest.deps.logError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ category: "home-restore", phase: "hash", status: "failed" }));
    expect(digest.deps.log).not.toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ phase: "install" }));
  });
});

describe("fresh checkpoint-backed home", () => {
  const expected = { name: NAME, size: 2048, sha256: SHA, instanceId: "4242", completedAt: 1000, generation: "9007199254740993", coverage: "builder-home-v2" as const, writerProtocol: 2 as const };
  const current = { ...expected, download: { url: "https://storage.example/download", method: "GET" } };
  const receipt = `/srv/octogee/home-restored-${NAME}-${expected.generation}-${SHA}.marker`;

  function freshHome(routes: FakeHome["routes"] = { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: current }) }) {
    const h = fakeHome({ dataEntries: [] }, routes);
    h.scope.restoreCheckpoint = expected;
    h.files.add(h.scope.restoreGate);
    const order: string[] = [];
    const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
    const { touch, rm } = h.deps.fs;
    h.deps.fs.touch = async (path, at) => { order.push(`touch ${name(path)}`); await touch(path, at); };
    h.deps.fs.rm = async (path) => { order.push(`rm ${name(path)}`); await rm(path); };
    h.deps.fs.replaceDirectory = vi.fn(async () => { order.push("install data"); });
    h.deps.fs.replaceDirectoryContents = vi.fn(async () => { order.push("install desktop-home"); });
    h.deps.desktop.run = vi.fn(async (action) => { order.push(`desktop ${action}`); });
    const shell = h.deps.shell.run;
    h.deps.shell.run = async (command, args) => { order.push(command); return shell(command, args); };
    return { ...h, order, downloads: () => h.fetches.filter(({ url }) => url === current.download.url).length };
  }

  it("installs the exact checkpoint while every writer is still off and opens the gate only after the install is durable", async () => {
    const h = freshHome();
    await expect(restoreHome(h.deps, h.scope)).resolves.toEqual({ status: "restored", name: NAME, size: 2048 });
    expect(h.files.has(h.scope.restoreGate)).toBe(true);
    expect(h.deps.desktop.run).not.toHaveBeenCalledWith("start");
    await admitHome(h.deps, h.scope);
    expect(h.order).toEqual([
      "tar", "rm home.tar.gz", "desktop stop-home", "touch home-restore.pending", "install data", "install desktop-home", "desktop reconcile-tools",
      "sync", "touch home-checkpoint.marker", `touch ${receipt.slice("/srv/octogee/".length)}`, "rm home-restore.pending",
      "rm octogee-home-restore-xyz", "rm home-restore.gate", "sync", "desktop start",
    ]);
    expect(h.files.has(h.scope.restoreGate)).toBe(false);
    expect(vi.mocked(h.deps.log).mock.calls.map(([, fields]) => `${fields?.phase}:${fields?.status}`).slice(-2)).toEqual(["admit:running", "admit:done"]);
  });

  it("keeps the gate closed and writers off when the install fails, reports the failed phase at error, and a retry reinstalls from scratch", async () => {
    const h = freshHome();
    let failing = true;
    h.deps.fs.replaceDirectoryContents = vi.fn(async () => {
      h.order.push("install desktop-home");
      if (failing) throw new Error("no space left on device");
    });
    await expect(restoreHome(h.deps, h.scope)).rejects.toThrow("no space left on device");
    expect(h.files.has(h.scope.restoreGate)).toBe(true);
    expect(h.files.has(h.scope.restorePending)).toBe(true);
    expect(h.files.has(receipt)).toBe(false);
    expect(h.deps.desktop.run).not.toHaveBeenCalledWith("start");
    expect(h.deps.logError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      gatewayId: "b-x", builderSlug: "bob", category: "home-restore", phase: "install", status: "failed", checkpointName: NAME,
    }));

    failing = false;
    h.world.dataEntries = ["partially-restored"];
    await expect(restoreHome(h.deps, h.scope)).resolves.toMatchObject({ status: "restored" });
    expect(h.downloads()).toBe(2);
    expect(h.deps.fs.replaceDirectory).toHaveBeenCalledTimes(2);
    expect(h.files.has(h.scope.restorePending)).toBe(false);
    expect(h.files.has(receipt)).toBe(true);
    expect(h.files.has(h.scope.restoreGate)).toBe(true);
    await admitHome(h.deps, h.scope);
    expect(h.files.has(h.scope.restoreGate)).toBe(false);
    expect(h.deps.desktop.run).toHaveBeenLastCalledWith("start");
  });

  it("reinstalls the exact checkpoint after a restart in the middle of the install instead of trusting the partial home", async () => {
    const h = freshHome();
    h.files.add(h.scope.restorePending);
    h.world.dataEntries = ["partially-restored"];
    await expect(restoreHome(h.deps, h.scope)).resolves.toMatchObject({ status: "restored", name: NAME });
    expect(h.downloads()).toBe(1);
    expect(h.order.indexOf("desktop stop-home")).toBeLessThan(h.order.indexOf("install data"));
    expect(h.files.has(h.scope.restoreGate)).toBe(true);
    await admitHome(h.deps, h.scope);
    expect(h.order.slice(-3)).toEqual(["rm home-restore.gate", "sync", "desktop start"]);
  });

  it("sweeps staging an interrupted restore left on the home disk before downloading again, and only while the gate is closed", async () => {
    const leftovers = {
      "/srv/octogee/tmp": ["octogee-home-restore-old", "unrelated"],
      "/srv/octogee/volumes": ["data", ".octogee-restore-a1"],
      "/srv/octogee/desktop-home": [".config", ".octogee-restore-b2"],
      "/srv/octogee/desktop-home/.local/share": ["app", ".octogee-restore-c3"],
      "/srv/octogee/desktop-home/.ssh": ["config", ".octogee-restore-d4"],
    };
    const swept = ["/srv/octogee/tmp/octogee-home-restore-old", "/srv/octogee/volumes/.octogee-restore-a1", "/srv/octogee/desktop-home/.octogee-restore-b2",
      "/srv/octogee/desktop-home/.local/share/.octogee-restore-c3", "/srv/octogee/desktop-home/.ssh/.octogee-restore-d4"];
    const h = freshHome();
    h.files.add(h.scope.restorePending);
    h.world.dirs = { ...leftovers };
    await expect(restoreHome(h.deps, h.scope)).resolves.toMatchObject({ status: "restored" });
    expect(h.removed.slice(0, swept.length).sort()).toEqual([...swept].sort());
    expect(h.order.indexOf("tar")).toBeGreaterThan(h.order.lastIndexOf("rm .octogee-restore-d4"));

    const live = fakeHome({ dataEntries: [] }, { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: current }) });
    live.world.dirs = { ...leftovers };
    await restoreHome(live.deps, live.scope).catch(() => undefined);
    expect(live.removed.filter((path) => swept.includes(path))).toEqual([]);
  });

  it("refuses to download a checkpoint the home disk cannot hold twice, at error with its own reason, and keeps the gate", async () => {
    const h = freshHome();
    h.world.freeBytes = 2 * 2048 - 1;
    await expect(restoreHome(h.deps, h.scope)).rejects.toThrow(`needs 4096 bytes free on ${h.deps.stateRoot}, has 4095`);
    expect(h.downloads()).toBe(0);
    expect(h.order).toEqual([]);
    expect(h.files.has(h.scope.restoreGate)).toBe(true);
    expect(h.deps.logError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      category: "home-restore", phase: "check-space", status: "failed", reason: "insufficient-space", checkpointName: NAME, freeBytes: 4095, requiredBytes: 4096,
    }));
  });

  it("reports a required checkpoint it cannot select at error and touches nothing", async () => {
    const h = freshHome({ "/internal/fleet/computer-home/download-url": () => ({ status: 409, body: { error: "home_restore_checkpoint_unavailable" } }) });
    await expect(restoreHome(h.deps, h.scope)).rejects.toThrow(/HTTP 409/);
    expect(h.deps.logError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      category: "home-restore", phase: "select-checkpoint", status: "failed", checkpointName: NAME,
    }));
    expect(h.order).toEqual([]);
    expect(h.files.has(h.scope.restoreGate)).toBe(true);
  });

  it("reports a failed admission at error", async () => {
    const h = freshHome();
    h.deps.desktop.run = vi.fn(async (action) => { if (action === "start") throw new Error("octo-home-migrate failed"); });
    await expect(admitHome(h.deps, h.scope)).rejects.toThrow("octo-home-migrate failed");
    expect(h.deps.logError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ category: "home-restore", phase: "admit", status: "failed" }));
  });

  it("starts a retained home's writers exactly as before: no gate to open and no admission phase", async () => {
    const h = fakeHome();
    expect(await restoreHome(h.deps, h.scope)).toEqual({ status: "preserved" });
    await admitHome(h.deps, h.scope);
    expect(h.deps.desktop.run).toHaveBeenCalledTimes(1);
    expect(h.deps.desktop.run).toHaveBeenCalledWith("start");
    expect(h.removed).toEqual([]);
    expect(h.deps.log).not.toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ phase: "admit" }));
  });
});


describe("required disposable home restore", () => {
  const expected = { name: NAME, size: 2048, sha256: SHA, instanceId: "4242", completedAt: 1000, generation: "9007199254740993" };
  it("rejects a missing checkpoint even when the image seeded a nonempty home", async () => {
    const h = fakeHome({}, { "/internal/fleet/computer-home/download-url": () => ({ status: 404, body: { error: "no_checkpoint" } }) });
    Object.assign(h.scope, { restoreCheckpoint: expected });
    await expect(restoreHome(h.deps, h.scope)).rejects.toThrow(/checkpoint.*unavailable/);
    expect(h.deps.desktop.run).not.toHaveBeenCalled();
  });
  it.each(["generation", "instanceId", "sha256", "name", "size", "completedAt"] as const)("refuses changed %s before downloading or installing", async (field) => {
    const h = fakeHome({}, { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: { ...expected, [field]: field === "size" || field === "completedAt" ? 7 : "different", download: { url: "https://storage.example/download", method: "GET" } } }) });
    h.scope.restoreCheckpoint = expected;
    await expect(restoreHome(h.deps, h.scope)).rejects.toThrow(/invalid checkpoint|match the required checkpoint/);
    expect(h.fetches).toHaveLength(1);
    expect(h.deps.desktop.run).not.toHaveBeenCalled();
  });
  it("restores a seeded home and writes a receipt only after installation succeeds", async () => {
    const h = fakeHome({}, { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: { ...expected, download: { url: "https://storage.example/download", method: "GET" } } }) });
    h.scope.restoreCheckpoint = expected;
    expect(await restoreHome(h.deps, h.scope)).toMatchObject({ status: "restored" });
    expect(h.touched.at(-1)?.path).toContain(`home-restored-${NAME}-${expected.generation}-${SHA}.marker`);
    h.deps.fs.exists = async (path) => path.endsWith("/data") || path.includes("home-restored-");
    expect(await restoreHome(h.deps, h.scope)).toEqual({ status: "preserved" });
    expect(h.fetches).toHaveLength(2);
    h.deps.fs.exists = async (path) => path.endsWith("/data") || path.includes("home-restored-") || path === h.scope.restorePending;
    expect(await restoreHome(h.deps, h.scope)).toMatchObject({ status: "restored" });
  });

});


describe.runIf(process.platform === "linux").each([".octogee-source-doctor-diagnostics", ".octogee-carried-agent-diagnostics"])("private diagnostics checkpoint boundary: %s", (diagnosticPath) => {
  const run = promisify(execFile);
  async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "home-diagnostics-"));
    const data = path.join(root, "data"), desktop = path.join(root, "desktop-home");
    const privateFile = path.join(data, diagnosticPath, "slot-0", "stdout.bin");
    const persona = path.join(data, ".openclaw", "customers", "alice", "AGENTS.md");
    const userFile = path.join(data, "Documents", diagnosticPath, "notes.txt");
    const adjacentFile = path.join(data, diagnosticPath + "-user", "notes.txt");
    const desktopFile = path.join(desktop, "Documents", "notes.txt");
    for (const [file, contents] of [[privateFile, "operator-private-output"], [persona, "original persona"],
      [userFile, "user file with the same directory name"], [adjacentFile, "adjacent user directory"], [desktopFile, "desktop notes"]]) {
      await fs.mkdir(path.dirname(file!), { recursive: true });await fs.writeFile(file!, contents!);
    }
    const scope: HomeScope = { slug: "alice", dataDir: data, desktopDir: desktop,
      marker: path.join(root, "marker"), restorePending: path.join(root, "restore-pending"), hostToolInventory: true };
    return { root, data, scope, privateFile, persona, userFile };
  }

  it("creates an archive without operator output while preserving persona and similarly named user files", async () => {
    const f = await fixture();
    try {
      const archive = path.join(f.root, "checkpoint.tar.gz");
      await run("tar", tarCreateArgs(archive, f.scope));
      const listed = (await run("tar", ["--list", "--gzip", `--file=${archive}`])).stdout;
      expect(listed).not.toContain(`data/${diagnosticPath}/`);
      expect(listed).toContain(`data/Documents/${diagnosticPath}/notes.txt`);
      expect(listed).toContain(`data/${diagnosticPath}-user/notes.txt`);
      const restored = path.join(f.root, "restored");await fs.mkdir(restored);
      await run("tar", ["--extract", "--gzip", `--file=${archive}`, `--directory=${restored}`]);
      expect(await fs.readFile(path.join(restored, "data/.openclaw/customers/alice/AGENTS.md"), "utf8")).toBe("original persona");
      expect(await fs.readFile(path.join(restored, "desktop-home/Documents/notes.txt"), "utf8")).toBe("desktop notes");
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });

  it("does not import operator output even when an incoming archive contains it", async () => {
    const f = await fixture();
    try {
      const archive = path.join(f.root, "incoming.tar.gz");
      await run("tar", ["--create", "--gzip", `--file=${archive}`, "-C", f.root, "data", "desktop-home"]);
      expect((await run("tar", ["--list", "--gzip", `--file=${archive}`])).stdout).toContain(`data/${diagnosticPath}/slot-0/stdout.bin`);
      const restored = path.join(f.root, "restored");await fs.mkdir(restored);
      await run("tar", tarExtractArgs(archive, restored));
      await expect(fs.lstat(path.join(restored, "data", diagnosticPath))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(restored, "data/.openclaw/customers/alice/AGENTS.md"), "utf8")).toBe("original persona");
      expect(await fs.readFile(path.join(restored, `data/Documents/${diagnosticPath}/notes.txt`), "utf8")).toBe("user file with the same directory name");
      expect(await fs.readFile(path.join(restored, `data/${diagnosticPath}-user/notes.txt`), "utf8")).toBe("adjacent user directory");
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });

  it("ignores diagnostic-only changes but detects similarly named user files", async () => {
    const f = await fixture();
    try {
      const old = new Date("2020-01-01T00:00:00Z"), marker = new Date("2021-01-01T00:00:00Z"), changed = new Date("2022-01-01T00:00:00Z");
      const entries = await fs.readdir(f.data, { recursive: true });
      for (const relative of entries) await fs.utimes(path.join(f.data, relative), old, old);
      await fs.utimes(f.data, old, old);await fs.writeFile(f.scope.marker, "marker");await fs.utimes(f.scope.marker, marker, marker);
      await fs.utimes(f.privateFile, changed, changed);await fs.utimes(path.join(f.data, diagnosticPath), changed, changed);
      expect((await run("find", findDirtyArgs(f.data, f.scope.marker, true))).stdout).toBe("");
      await fs.utimes(f.userFile, changed, changed);
      expect((await run("find", findDirtyArgs(f.data, f.scope.marker, true))).stdout.trim()).toBe(f.userFile);
      await fs.utimes(f.userFile, old, old);await fs.unlink(f.persona);
      expect((await run("find", findDirtyArgs(f.data, f.scope.marker, true))).stdout.trim()).toBe(path.dirname(f.persona));
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
});
