import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOKEN_REFRESH_MS,
  PREEMPTION_WATCH_RETRY_MS,
  HOME_RESTORE_RETRY_MS,
  convergeOnce,
  fetchRuntimeBundle,
  initialAgentState,
  runVmGatewayAgent,
  watchPreemption,
  applyBundle,
  applyServices,
  type VmAgentDeps,
} from "../../lib/vm-gateway-agent/agent";
import type { DockerEngine } from "../../lib/vm-gateway-agent/docker-engine";
import { scratchVolumeName } from "../../lib/vm-gateway-agent/scratch.js";
import { HOME_CHECKPOINT_INTERVAL_MS } from "../../lib/vm-gateway-agent/home-checkpoint";
import { bundleFixture } from "./fixture";
import { planBundle } from "../../lib/vm-gateway-agent/plan.js";
import { createSurgeOpenClawProcessSupervisorClient } from "../../lib/surge-openclaw-process-gate.js";
import { startSurgeOpenClawSupervisor } from "../../entrypoints/surge-openclaw-supervisor.js";

const SHA = "c".repeat(64);
const DISK = { sizeBytes: 85_899_345_920, freeBytes: 32_212_254_720 };
const CHECKPOINT = { name: "20260905T101500Z.tar.gz", size: 2048, sha256: SHA, completedAt: 5, download: { url: "https://storage.example/download", method: "GET", gcsPath: "p", expiresAt: "e" } };

interface FakeDocker {
  engine: DockerEngine;
  volumes: Map<string, Record<string, unknown>>;
  containers: Map<string, { config: Record<string, unknown>; running: boolean; paused?: boolean }>;
  log: string[];
  prune: { status: number; body: unknown };
  hostBin: Set<string>;
  agentImage: string | null;
}

function fakeDocker(log: string[] = []): FakeDocker {
  const volumes = new Map<string, Record<string, unknown>>();
  const containers = new Map<string, { config: Record<string, unknown>; running: boolean; paused?: boolean }>();
  const fake = {
    prune: { status: 200, body: { ImagesDeleted: null, SpaceReclaimed: 0 } as unknown },
    hostBin: new Set(["octo-desktop-openclaw-vnc"]),
    agentImage: "sha256:agent" as string | null,
  };
  const name = (path: string) => decodeURIComponent(path.split("/")[2].split("?")[0]);
  const engine: DockerEngine = {
    async request(method, path, body) {
      log.push(`${method} ${path.split("?")[0]}`);
      if (path === "/info") return { status: 200, body: { DockerRootDir: "/var/lib/docker" } as never };
      if (path.startsWith("/volumes?")) return { status: 200, body: { Volumes: [...volumes.values()] } as never };
      if (path.startsWith("/containers/json?")) return { status: 200, body: [...containers.values()].map(container => ({ Mounts: ((container.config.HostConfig as { Binds?: string[] }).Binds ?? []).map(bind => {
        const source = bind.split(":")[0];
        return { Type: source.startsWith("/") ? "bind" : "volume", Name: source.startsWith("/") ? undefined : source, Source: source.startsWith("/") ? source : `/var/lib/docker/volumes/${source}/_data` };
      }) })) as never };
      if (path.startsWith("/volumes/")) {
        const name = decodeURIComponent(path.slice("/volumes/".length));
        if (method === "GET") return { status: volumes.has(name) ? 200 : 404, body: volumes.get(name) as never };
        volumes.delete(name);
        return { status: 204, body: "" as never };
      }
      if (method === "GET" && path === "/containers/octo-gateway-agent/json") {
        return fake.agentImage
          ? { status: 200, body: { Id: "agent", Image: fake.agentImage } as never }
          : { status: 404, body: { message: "no such container" } as never };
      }
      if (method === "GET" && path.startsWith("/images/")) {
        return { status: 200, body: { RepoDigests: [`registry.example/actual@sha256:${"a".repeat(64)}`] } as never };
      }
      if (method === "HEAD" && path.includes("/archive?")) {
        const c = containers.get(name(path))!;
        const target = new URL(`http://x${path}`).searchParams.get("path")!;
        const [bind] = (c.config.HostConfig as { Binds: string[] }).Binds;
        const [hostDir, containerDir] = bind.split(":");
        expect(hostDir).toBe("/usr/local/bin");
        return { status: fake.hostBin.has(target.slice(containerDir.length + 1)) ? 200 : 404, body: "" as never };
      }
      if (path.startsWith("/images/create")) return { status: 200, body: '{"status":"ok"}' as never };
      if (path.startsWith("/images/prune")) return { status: fake.prune.status, body: fake.prune.body as never };
      if (method === "GET" && path.endsWith("/json")) {
        const c = containers.get(name(path));
        return c
          ? { status: 200, body: { Id: name(path), Image: `sha256:${"b".repeat(64)}`, State: { Running: c.running, Paused: c.paused ?? false }, Config: { Image: c.config.Image, Labels: (c.config.Labels as Record<string, string>) } } as never }
          : { status: 404, body: { message: "no such container" } as never };
      }
      if (method === "DELETE") { containers.delete(name(path)); return { status: 204, body: "" as never }; }
      if (path.startsWith("/containers/create")) {
        const n = new URL(`http://x${path}`).searchParams.get("name")!;
        containers.set(n, { config: body as Record<string, unknown>, running: false });
        return { status: 201, body: { Id: n } as never };
      }
      if (path.endsWith("/update")) { (containers.get(name(path))!.config.HostConfig as Record<string, unknown>).RestartPolicy = (body as Record<string, unknown>).RestartPolicy; return { status: 200, body: {} as never }; }
      if (path.endsWith("/pause") || path.endsWith("/unpause")) { containers.get(name(path))!.paused = path.endsWith("/pause"); return { status: 204, body: "" as never }; }
      if (path.endsWith("/start")) { containers.get(name(path))!.running = true; return { status: 204, body: "" as never }; }
      if (path.endsWith("/wait")) { containers.get(name(path))!.running = false; return { status: 200, body: { StatusCode: 0 } as never }; }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return Object.assign(fake, { engine, containers, volumes, log });
}

type Reply = { status: number; body: unknown };

function deps(
  docker: FakeDocker,
  bundleResponse: () => Reply,
  clock: { now: number },
  opts: { routes?: Record<string, () => Reply>; home?: { entries?: string[]; dirty?: boolean; gate?: boolean }; diskUsage?: VmAgentDeps["fs"]["diskUsage"] } = {},
) {
  const files = new Map<string, { content: string; mode: number }>();
  const dirs = new Set<string>();
  const chowns: string[] = [];
  const home = { entries: opts.home?.entries ?? ["README.md"], dirty: opts.home?.dirty ?? false, gate: opts.home?.gate ?? false, marks: new Set<string>() };
  const routes: Record<string, () => Reply> = {
    "/internal/fleet/computer-home/download-url": () => ({ status: 404, body: { error: "no_checkpoint" } }),
    "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 200, body: { name: CHECKPOINT.name, upload: { url: "https://storage.example/upload", method: "PUT", gcsPath: "p", expiresAt: "e" } } }),
    "/internal/fleet/computer-home/commit": () => ({ status: 200, body: { name: CHECKPOINT.name, size: 2048, sha256: SHA, completedAt: clock.now } }),
    "/internal/fleet/computer-home/prune": () => ({ status: 200, body: { deleted: 0 } }),
    ...opts.routes,
  };
  const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path.startsWith("/internal/fleet/vm-runtime")) {
      const r = bundleResponse();
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    }
    const route = routes[path];
    if (!route) return new Response("", { status: 200 });
    const r = route();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const d: VmAgentDeps = {
    gatewayId: "b-x",
    apiUrl: "http://10.128.9.9:3001",
    stateRoot: "/srv/octogee",
    engine: docker.engine,
    holdOpenClaw: vi.fn(async () => {}),
    metadata: {
      identityToken: async (aud) => `id-${aud}`,
      accessToken: async () => "access-1",
      instanceIdentity: async () => ({ instanceId: "4242", instanceName: "octogee-gw-b-x", zone: "us-central1-a" }),
      attribute: async () => null,
      preempted: async () => false,
    },
    fetchImpl,
    fs: {
      mkdir: async (p) => { dirs.add(p); },
      writeFile: async (p, content, mode) => { files.set(p, { content, mode }); },
      readFile: async (p) => files.get(p)?.content ?? null,
      chown: async (p) => { chowns.push(p); },
      diskUsage: opts.diskUsage ?? (async () => DISK),
    },
    home: {
      desktop: { run: vi.fn(async (action) => { docker.log.push(`desktop ${action}`); }) },
      shell: {
        run: async (command, args) => {
          docker.log.push(`${command} ${args[0]}`);
          if (command === "find") return { code: 0, stdout: home.dirty ? "changed\n" : "", stderr: "" };
          if (args[0] === "--extract") home.entries = ["restored"];
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fs: {
        listDir: async () => home.entries,
        freeBytes: async () => 1024 ** 4,
        exists: async (path) => {
          if (path.endsWith("home-restore.gate")) return home.gate;
          if (path.endsWith("home-restore.pending") || path.includes("home-restored-")) return home.marks.has(path);
          return true;
        },
        mkdir: async () => {},
        replaceDirectory: async () => {},
        retainToolStorage: async () => {},
        replaceDirectoryContents: async () => {},
        fileSize: async () => 2048,
        sha256: async () => SHA,
        mkdtemp: async (prefix) => `/tmp/${prefix}1`,
        rm: async (path) => {
          home.marks.delete(path);
          if (path.endsWith("home-restore.gate")) { home.gate = false; docker.log.push("rm home-restore.gate"); }
        },
        touch: async (path) => { home.marks.add(path); home.dirty = false; },
        uploadBody: async () => "bytes",
        saveResponse: async () => {},
      },
    },
    now: () => clock.now,
    log: vi.fn(),
    logError: vi.fn(),
  };
  return { d, files, dirs, chowns, fetchImpl, home };
}

const logLines = (d: VmAgentDeps, text: string) => vi.mocked(d.log).mock.calls.map(([line]) => line).filter(line => line.includes(text));

const homeBundle = (overrides: Parameters<typeof bundleFixture>[0] = {}) => bundleFixture({
  builderIdentity: { ownerUid: "uid-bob", builderSlug: "bob" },
  ...overrides,
});

const runtimeReply = (bundle: ReturnType<typeof bundleFixture>, homeCheckpoint = { requestedAt: null as number | null, completedAt: null as number | null }): Reply =>
  ({ status: 200, body: { bundle, homeCheckpoint } });

it("retains old and orphan caches through runtime replacement and steady convergence without exclusive custody", async () => {
  const docker = fakeDocker();
  const old = scratchVolumeName("b-old", "builder-cache");
  const current = scratchVolumeName("4242", "builder-cache");
  for (const [Name, owner] of [[old, "b-old"], [current, "4242"]]) docker.volumes.set(Name, {
    Name, Driver: "local", Mountpoint: `/var/lib/docker/volumes/${Name}/_data`, Options: {},
    Labels: { "ai.octogee.computer-id": owner, "ai.octogee.storage": "ephemeral" },
  });
  docker.containers.set("octogee-gateway", { running: true, config: {
    Image: "old-image", Labels: { "ai.octogee.bundle-version": "old", "ai.octogee.gateway-id": "b-old" }, HostConfig: { Binds: [`${old}:/work/cache`] },
  } });
  const h = deps(docker, () => runtimeReply(bundleFixture()), { now: 0 });
  let state = await convergeOnce(h.d, initialAgentState());
  expect(docker.volumes.has(old)).toBe(true);
  expect(docker.volumes.has(current)).toBe(true);
  expect(docker.log).not.toContain(`DELETE /volumes/${old}`);
  expect(h.d.log).toHaveBeenCalledWith(expect.stringContaining("exclusive writer custody unavailable"));
  const orphan = scratchVolumeName("b-retired", "builder-cache");
  docker.volumes.set(orphan, { Name: orphan, Driver: "local", Mountpoint: `/var/lib/docker/volumes/${orphan}/_data`, Options: {},
    Labels: { "ai.octogee.computer-id": "b-retired", "ai.octogee.storage": "ephemeral" } });
  state = await convergeOnce(h.d, state);
  expect(docker.volumes.has(orphan)).toBe(true);
  expect(state.appliedVersion).toBe(bundleFixture().version);
});

const calls = (fetchImpl: typeof fetch, suffix: string) =>
  (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls.filter(([url]) => String(url).endsWith(suffix));

describe.each(["bundle", "services"] as const)("%s runtime replacement", (kind) => {
  function replacement() {
    const docker = fakeDocker();
    const bundle = homeBundle();
    const h = deps(docker, () => runtimeReply(bundle), { now: 0 });
    docker.containers.set("octogee-gateway", { running: true, config: { Image: "old", HostConfig: {} } });
    const plan = planBundle(bundle, { stateRoot: h.d.stateRoot, instanceId: "4242", desktopAuth: true });
    const apply = () => kind === "bundle" ? applyBundle(h.d, bundle, plan) : applyServices(h.d, bundle, plan.services);
    return { docker, h, apply, bundle, plan };
  }

  it("keeps the old container until its Native supervisor acknowledges the stop", async () => {
    const { docker, h, apply } = replacement();
    let acknowledge!: () => void;
    h.d.holdOpenClaw = vi.fn(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    const applying = apply();
    await vi.waitFor(() => expect(h.d.holdOpenClaw).toHaveBeenCalledWith("/srv/octogee/volumes/data/.openclaw"));
    expect(docker.containers.get("octogee-gateway")?.config.Image).toBe("old");
    expect(docker.log).not.toContain("DELETE /containers/octogee-gateway");
    acknowledge();
    await applying;
    expect(docker.containers.get("octogee-gateway")?.config.Image).not.toBe("old");
  });

  it("preserves the old runtime when the Native supervisor refuses a migration-owned stop", async () => {
    const { docker, h, apply } = replacement();
    h.d.holdOpenClaw = vi.fn(async () => { throw new Error("migration owns Native process"); });
    await expect(apply()).rejects.toThrow("migration owns Native process");
    expect(docker.containers.get("octogee-gateway")?.config.Image).toBe("old");
    expect(docker.log.some((line) => line.startsWith("DELETE /containers/"))).toBe(false);
  });

  it("does not contact Native for a stopped gateway or an edge-only replacement", async () => {
    const { docker, h, apply, bundle, plan } = replacement();
    await applyServices(h.d, bundle, plan.services.filter((service) => service.name !== "octogee-gateway"));
    expect(h.d.holdOpenClaw).not.toHaveBeenCalled();
    expect(docker.containers.get("octogee-gateway")?.config.Image).toBe("old");
    docker.containers.get("octogee-gateway")!.running = false;
    await apply();
    expect(h.d.holdOpenClaw).not.toHaveBeenCalled();
  });

  it("refuses a paused gateway without destroying its writer hold", async () => {
    const { docker, h, apply } = replacement();
    docker.containers.get("octogee-gateway")!.paused = true;
    await expect(apply()).rejects.toThrow("paused Native gateway");
    expect(h.d.holdOpenClaw).not.toHaveBeenCalled();
    expect(docker.log.some((line) => line.startsWith("DELETE /containers/"))).toBe(false);
  });

  it("waits for child exit through the real supervisor socket before destroying the container", async () => {
    const root = await mkdtemp(join(tmpdir(), "vm-stop-"));
    const socketPath = join(root, "s");
    const { docker, h, bundle } = replacement();
    h.d.stateRoot = root;
    const openclawDir = `${root}/volumes/data/.openclaw`;
    let alive = false;
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir, socketPath, podUid: "vm-4242", log: () => {},
      readinessReleased: async () => true,
      prepareDatabases: async () => {},
      spawnOpenClaw: () => { alive = true; return child; },
      probeHealthz: async () => alive,
      healthTimeoutMs: 100,
    });
    try {
      await vi.waitFor(async () => expect(await supervisor.state()).toMatchObject({ phase: "running" }));
      h.d.holdOpenClaw = async (dir) => { await createSurgeOpenClawProcessSupervisorClient(dir, { socketPath }).holdNormal(); };
      const plan = planBundle(bundle, { stateRoot: root, instanceId: "4242", desktopAuth: true });
      const applying = kind === "bundle" ? applyBundle(h.d, bundle, plan) : applyServices(h.d, bundle, plan.services);
      await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
      expect(docker.log).not.toContain("DELETE /containers/octogee-gateway");
      alive = false;
      child.emit("exit", 0, null);
      await applying;
      expect(await supervisor.state()).toMatchObject({ role: "normal", mode: "held", phase: "held" });
      expect(docker.containers.get("octogee-gateway")?.running).toBe(true);
    } finally {
      alive = false;
      child.emit("exit", 0, null);
      await supervisor.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runVmGatewayAgent", () => {
  const oneTick = (d: VmAgentDeps) => {
    let ticks = 0;
    return runVmGatewayAgent(d, { intervalMs: 0, sleep: async () => {}, stop: () => ticks++ > 1 });
  };

  it("forwards the host journal even when no runtime bundle can be fetched", async () => {
    const docker = fakeDocker();
    const h = deps(docker, () => ({ status: 500, body: { error: "unavailable" } }), { now: 1_000 });
    await oneTick(h.d);
    expect(docker.containers.get("octo-journal-forward")?.running).toBe(true);
    expect(docker.containers.get("octo-journal-forward")?.config.Image).toBe("sha256:agent");
    expect(h.d.log).toHaveBeenCalledWith(expect.stringContaining("converge failed"));
  });

  it("reports a forwarder it cannot start and still converges the runtime", async () => {
    const docker = fakeDocker();
    docker.agentImage = null;
    const h = deps(docker, () => ({ status: 404, body: { error: "not_rendered" } }), { now: 1_000 });
    await oneTick(h.d);
    expect(docker.containers.has("octo-journal-forward")).toBe(false);
    expect(h.d.log).toHaveBeenCalledWith(expect.stringContaining("journal forwarding unavailable"));
    expect(h.d.log).toHaveBeenCalledWith(expect.stringContaining("runtime bundle not rendered yet"));
  });
});

describe("convergeOnce", () => {
  it("writes the Desk identity into a user's home from the configured bootstrap and keeps converging when it is unavailable", async () => {
    const clock = { now: 1_000 };
    const desk = { builderName: "Bob Builder", agentName: "Scout", look: { style: "kit", color: "#0ea5e9" }, timeZone: null };
    const h = deps(fakeDocker(), () => runtimeReply(homeBundle()), clock, {
      routes: { "/internal/fleet/configured-builder-bootstrap": () => ({ status: 200, body: { bootstrap: { coachToken: "x", desk } } }) },
    });
    const state = await convergeOnce(h.d, initialAgentState());
    expect(state.appliedVersion).toBe("v1");
    expect(JSON.parse(calls(h.fetchImpl, "/internal/fleet/configured-builder-bootstrap")[0][1].body as string)).toEqual({ gatewayId: "b-x", slug: "bob", revisionId: "b-x" });
    expect(JSON.parse(h.files.get("/srv/octogee/desktop-home/.config/octogee/desk.json")!.content)).toEqual(desk);
    expect(h.files.get("/srv/octogee/desktop-home/.config/octogee/desk.svg")?.content).toContain("<svg");
    expect(h.chowns).toContain("/srv/octogee/desktop-home/.config/octogee/desk.json");

    await convergeOnce(h.d, state);
    expect(calls(h.fetchImpl, "/internal/fleet/configured-builder-bootstrap")).toHaveLength(2);
    expect([...h.files.keys()].filter((p) => p.endsWith("desk.json"))).toHaveLength(1);

    const broken = deps(fakeDocker(), () => runtimeReply(homeBundle()), clock, {
      routes: { "/internal/fleet/configured-builder-bootstrap": () => ({ status: 500, body: { error: "boom" } }) },
    });
    const converged = await convergeOnce(broken.d, initialAgentState());
    expect(converged.appliedVersion).toBe("v1");
    expect(broken.d.log).toHaveBeenCalledWith(expect.stringContaining("desk sync failed: configured-builder-bootstrap: HTTP 500"));
    expect(broken.files.has("/srv/octogee/desktop-home/.config/octogee/desk.json")).toBe(false);

    const pending = deps(fakeDocker(), () => runtimeReply(homeBundle()), clock, {
      routes: { "/internal/fleet/configured-builder-bootstrap": () => ({ status: 404, body: { error: "configured_builder_bootstrap_unavailable" } }) },
    });
    await convergeOnce(pending.d, initialAgentState());
    expect(pending.d.log).toHaveBeenCalledWith(expect.stringContaining("desk sync waiting"));

    const shared = deps(fakeDocker(), () => runtimeReply(bundleFixture()), clock);
    await convergeOnce(shared.d, initialAgentState());
    expect(calls(shared.fetchImpl, "/internal/fleet/configured-builder-bootstrap")).toEqual([]);
  });

  it("applies a bundle from a platform that predates the namespace field, and says so", async () => {
    const clock = { now: 1_000 };
    const h = deps(fakeDocker(), () => runtimeReply(homeBundle({ namespace: undefined })), clock);

    const state = await convergeOnce(h.d, initialAgentState());

    expect(state.appliedVersion).toBe("v1");
    expect((h.d.log as unknown as { mock: { calls: string[][] } }).mock.calls.map(([line]) => line)).toContainEqual(
      expect.stringContaining("carries no namespace"),
    );
  });

  it("reports actual image digests by container image ID and explicit missing or stopped services", async () => {
    const docker = fakeDocker();
    docker.containers.set("octogee-gateway", { config: { Image: "registry.example/actual:older", Env: ["SECRET=hidden"] }, running: true });
    const h = deps(docker, () => runtimeReply(bundleFixture()), { now: 1_000 });
    await fetchRuntimeBundle(h.d);
    const first = JSON.parse(String(calls(h.fetchImpl, "/internal/fleet/vm-runtime")[0][1].body));
    expect(first.images).toEqual({ containers: [
      { name: "gateway", imageReference: "registry.example/actual:older", digests: [`registry.example/actual@sha256:${"a".repeat(64)}`], running: true },
      { name: "gateway-edge", imageReference: "", digests: [], running: false },
    ] });
    expect(JSON.stringify(first)).not.toContain("hidden");
    expect(docker.log).toContain(`GET /images/sha256%3A${"b".repeat(64)}/json`);
    docker.containers.get("octogee-gateway")!.paused = true;
    docker.containers.set("octogee-gateway-edge", { config: { Image: "registry.example/edge:older" }, running: false });
    await fetchRuntimeBundle(h.d);
    const second = JSON.parse(String(calls(h.fetchImpl, "/internal/fleet/vm-runtime")[1][1].body));
    expect(second.images.containers.map((c: { running: boolean }) => c.running)).toEqual([false, false]);
  });

  it("logs an image inspection failure and polls without falsely reporting image readiness", async () => {
    const docker = fakeDocker();
    const original = docker.engine.request;
    docker.engine.request = async (method, path, ...args) => {
      if (path === "/containers/octogee-gateway/json") throw new Error("Docker unavailable");
      return original(method, path, ...args);
    };
    const h = deps(docker, () => runtimeReply(bundleFixture()), { now: 1_000 });
    await fetchRuntimeBundle(h.d);
    expect(JSON.parse(String(calls(h.fetchImpl, "/internal/fleet/vm-runtime")[0][1].body))).not.toHaveProperty("images");
    expect(h.d.log).toHaveBeenCalledWith(expect.stringContaining("image observation unavailable: Docker unavailable"));
  });

  it("reports the state root's disk usage with every bundle poll, and still polls when the measurement fails", async () => {
    const clock = { now: 1_000 };
    const reported = deps(fakeDocker(), () => runtimeReply(bundleFixture()), clock);
    await convergeOnce(reported.d, initialAgentState());
    const [, init] = calls(reported.fetchImpl, "/internal/fleet/vm-runtime")[0];
    expect(JSON.parse(String(init.body))).toMatchObject({ gatewayId: "b-x", disk: DISK, images: { containers: [{ name: "gateway", running: false }, { name: "gateway-edge", running: false }] } });

    const unmeasured = deps(fakeDocker(), () => runtimeReply(bundleFixture()), clock, { diskUsage: async path => { if (path === "/") { return DISK; } throw new Error("ENOENT: statfs"); } });
    const state = await convergeOnce(unmeasured.d, initialAgentState());
    expect(state.appliedVersion).toBe("v1");
    expect(JSON.parse(String(calls(unmeasured.fetchImpl, "/internal/fleet/vm-runtime")[0][1].body))).toMatchObject({ gatewayId: "b-x", images: { containers: [{ name: "gateway", running: false }, { name: "gateway-edge", running: false }] } });
    expect(unmeasured.d.log).toHaveBeenCalledWith(expect.stringContaining("disk usage unavailable for /srv/octogee: ENOENT: statfs"));
  });

  it("refuses new scratch preparation below 2 GiB of boot headroom without deleting retained data", async () => {
    const docker = fakeDocker();
    const bundle = bundleFixture();
    bundle.volumes.push({ name: "builder-cache", kind: "ephemeral" });
    const h = deps(docker, () => runtimeReply(bundle), { now: 1_000 }, { diskUsage: async path => path === "/" ? { ...DISK, freeBytes: 1024 ** 3 } : DISK });
    await expect(convergeOnce(h.d, initialAgentState())).rejects.toThrow("boot headroom");
    expect(docker.log.some(entry => entry.startsWith("POST /volumes/create") || entry.startsWith("POST /images/create") || entry.startsWith("DELETE /volumes/"))).toBe(false);
  });

  it.each([false, true])("restarts stopped services below boot headroom with no new scratch allocation: existing scratch %s", async (scratch) => {
    const docker = fakeDocker();
    const bundle = bundleFixture();
    const image = `registry.example/actual:deadbee@sha256:${"a".repeat(64)}`;
    bundle.init!.image = image;
    for (const container of bundle.containers) container.image = image;
    if (scratch) {
      bundle.volumes.push({ name: "builder-cache", kind: "ephemeral" });
      const Name = scratchVolumeName("4242", "builder-cache");
      docker.volumes.set(Name, { Name, Driver: "local", Mountpoint: `/var/lib/docker/volumes/${Name}/_data`, Options: {},
        Labels: { "ai.octogee.computer-id": "4242", "ai.octogee.storage": "ephemeral" } });
    }
    const h = deps(docker, () => runtimeReply(bundle), { now: 1_000 }, { diskUsage: async path => path === "/" ? { ...DISK, freeBytes: 1024 ** 3 } : DISK });
    let state = await convergeOnce(h.d, initialAgentState());
    docker.containers.get("octogee-gateway")!.running = false;
    state = await convergeOnce(h.d, state);
    expect(state.appliedVersion).toBe("v1");
    expect(docker.containers.get("octogee-gateway")!.running).toBe(true);
    expect(docker.log).not.toContain("POST /volumes/create");
  });

  it.each(["bundle", "services"])("starts preloaded immutable images without a registry pull (%s)", async kind => {
    const docker = fakeDocker();
    const bundle = bundleFixture();
    const image = `registry.example/actual:deadbee@sha256:${"a".repeat(64)}`;
    bundle.init!.image = image;
    for (const container of bundle.containers) container.image = image;
    const h = deps(docker, () => runtimeReply(bundle), { now: 1000 });
    const token = vi.spyOn(h.d.metadata, "accessToken").mockRejectedValue(new Error("registry token unavailable"));
    const plan = planBundle(bundle, { stateRoot: h.d.stateRoot, instanceId: "4242", desktopAuth: true });
    if (kind === "bundle") await applyBundle(h.d, bundle, plan);
    else await applyServices(h.d, bundle, plan.services);
    expect(token).not.toHaveBeenCalled();
    expect(docker.log.some(line => line.startsWith("POST /images/create"))).toBe(false);
    expect(docker.containers.get("octogee-gateway")?.running).toBe(true);
  });

  it("preserves running services and refuses image pulls when the boot disk lacks headroom", async () => {
    const docker = fakeDocker();
    const bundle = bundleFixture();
    const h = deps(docker, () => runtimeReply(bundle), { now: 1000 }, {
      diskUsage: async () => ({ ...DISK, freeBytes: 1024 ** 3 }),
    });
    const plan = planBundle(bundle, { stateRoot: h.d.stateRoot, instanceId: "4242", desktopAuth: true });
    await expect(applyBundle(h.d, bundle, plan)).rejects.toThrow(/boot disk.*free/);
    expect(docker.log.some(line => line.startsWith("POST /images/create"))).toBe(false);
    expect(docker.log.some(line => line.startsWith("DELETE /containers/"))).toBe(false);
  });

  it("waits while the bundle is unrendered, then writes tokens, prepares volumes, runs init, and starts the services", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    let rendered = false;
    const h = deps(docker, () => (rendered ? runtimeReply(bundleFixture()) : { status: 404, body: { error: "vm_runtime_not_rendered" } }), clock);

    let state = await convergeOnce(h.d, initialAgentState());
    expect(state).toEqual(initialAgentState());
    expect(docker.containers.size).toBe(0);
    const [, init] = (h.fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0];
    expect(init.headers).toMatchObject({ "x-k8s-sa-token": "id-octogee-api", "x-octogee-gateway-credential-token": "id-octogee-api-gateway-credentials" });

    rendered = true;
    state = await convergeOnce(h.d, state);

    expect(state).toEqual({ tokensWrittenAt: 1_000, appliedVersion: "v1", homeCheckpointCheckedAt: null, hostDesktopAuth: true });
    expect(h.files.get("/srv/octogee/tokens/gateway-broker-sa-token/token")).toEqual({ content: "id-octogee-api", mode: 0o644 });
    expect(h.files.get("/srv/octogee/tokens/k8s-api-token/token")?.content).toBe("access-1");
    expect(h.files.get("/srv/octogee/tokens/k8s-api-token/ca.crt")?.content).toBe("CA-PEM");
    expect(h.chowns).toEqual(["/srv/octogee/volumes/data", "/srv/octogee/volumes/secret-resolver", "/srv/octogee/desktop-home/Documents"]);
    expect(h.dirs.has("/srv/octogee/desktop-home/Documents")).toBe(true);
    expect([...docker.containers.keys()]).toEqual(["octogee-gateway", "octogee-gateway-edge"]);
    expect(docker.containers.get("octogee-gateway")?.running).toBe(true);
    expect(docker.log.filter((l) => l.startsWith("POST /images/create"))).toHaveLength(2);
    const initIndex = docker.log.findIndex((l) => l === "POST /containers/octogee-fix-perms/wait");
    const gatewayStart = docker.log.findIndex((l) => l === "POST /containers/octogee-gateway/start");
    expect(initIndex).toBeGreaterThan(-1);
    expect(gatewayStart).toBeGreaterThan(initIndex);
  });

  it("is a no-op while the running containers match the bundle, and replaces every container and re-runs init on an image roll", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    let bundle = bundleFixture();
    const h = deps(docker, () => runtimeReply(bundle), clock);

    let state = await convergeOnce(h.d, initialAgentState());
    const creates = () => docker.log.filter((l) => l.startsWith("POST /containers/create")).length;
    const afterFirst = creates();

    state = await convergeOnce(h.d, state);
    expect(creates()).toBe(afterFirst);
    expect(state.appliedVersion).toBe("v1");

    const rolled = bundleFixture();
    const roll = (image: string) => image.replace("main.abc", "main.def");
    bundle = {
      ...rolled,
      version: "v2",
      imageTag: "main.def",
      init: { ...rolled.init!, image: roll(rolled.init!.image) },
      containers: rolled.containers.map((container) => ({ ...container, image: roll(container.image) })),
    };
    const before = docker.log.length;
    state = await convergeOnce(h.d, state);
    expect(creates()).toBe(afterFirst + 3);
    expect(docker.log.slice(before)).toContain("POST /containers/octogee-fix-perms/wait");
    expect(state.appliedVersion).toBe("v2");
    expect((docker.containers.get("octogee-gateway")?.config.Labels as Record<string, string>)["ai.octogee.bundle-version"]).toBe("v2");
  });

  it("binds the desktop password into the gateway on a VM whose image ships the OpenClaw VNC reflector", async () => {
    const docker = fakeDocker();
    const h = deps(docker, () => runtimeReply(bundleFixture()), { now: 1_000 });

    await convergeOnce(h.d, initialAgentState());

    expect(docker.containers.get("octogee-gateway")?.config.HostConfig).toMatchObject({
      Mounts: [{ Type: "bind", Source: "/run/user/1000/octogee-openclaw-vnc", Target: "/run/octogee-desktop-vnc", ReadOnly: true }],
    });
    expect(docker.containers.has("octogee-host-probe")).toBe(false);
  });

  it("starts the gateway without the desktop password on a VM image that predates the OpenClaw VNC reflector, says so, and settles", async () => {
    const docker = fakeDocker();
    docker.hostBin.clear();
    const h = deps(docker, () => runtimeReply(bundleFixture()), { now: 1_000 });

    let state = await convergeOnce(h.d, initialAgentState());
    const creates = () => docker.log.filter((l) => l.startsWith("POST /containers/create")).length;
    const afterFirst = creates();
    state = await convergeOnce(h.d, state);

    expect(state.hostDesktopAuth).toBe(false);
    expect(docker.containers.get("octogee-gateway")?.running).toBe(true);
    expect(docker.containers.get("octogee-gateway")?.config.HostConfig).not.toHaveProperty("Mounts");
    expect(docker.containers.has("octogee-host-probe")).toBe(false);
    expect(creates()).toBe(afterFirst);
    expect(docker.log.filter((l) => l.startsWith("HEAD "))).toHaveLength(1);
    expect(h.d.log).toHaveBeenCalledWith(
      "[vm-agent] this computer's image has no /usr/local/bin/octo-desktop-openclaw-vnc, so its desktop publishes no OpenClaw VNC password; "
      + "octogee-gateway runs without /run/octogee-desktop-vnc and the OpenClaw desktop panel is unavailable on this computer",
    );
  });

  it("refuses to plan the gateway when it cannot probe the host desktop", async () => {
    const docker = fakeDocker();
    docker.agentImage = null;
    const h = deps(docker, () => runtimeReply(bundleFixture()), { now: 1_000 });

    await expect(convergeOnce(h.d, initialAgentState())).rejects.toThrow(/octo-gateway-agent container not found/);
    expect(docker.containers.has("octogee-gateway")).toBe(false);
  });

  it("reclaims images no container uses after applying a new bundle, and never while steady", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    let bundle = bundleFixture();
    const h = deps(docker, () => runtimeReply(bundle), clock);
    const prunes = () => docker.log.filter((l) => l === "POST /images/prune");

    let state = await convergeOnce(h.d, initialAgentState());
    expect(prunes()).toHaveLength(1);
    state = await convergeOnce(h.d, state);
    expect(prunes()).toHaveLength(1);

    docker.prune = { status: 200, body: { ImagesDeleted: [{ Untagged: "old" }, { Deleted: "sha256:old" }], SpaceReclaimed: 4_600_000_000 } };
    const rolled = bundleFixture();
    bundle = { ...rolled, version: "v2", containers: rolled.containers.map((c) => ({ ...c, image: c.image.replace("main.abc", "main.def") })) };
    state = await convergeOnce(h.d, state);
    expect(prunes()).toHaveLength(2);
    expect(state.appliedVersion).toBe("v2");
    expect(h.d.log).toHaveBeenCalledWith("[vm-agent] reclaimed 4600000000 bytes from 1 unused image(s) after applying bundle v2");
  });

  it("logs a failed image reclaim without failing the applied bundle", async () => {
    const docker = fakeDocker();
    docker.prune = { status: 409, body: { message: "a prune operation is already running" } };
    const h = deps(docker, () => runtimeReply(bundleFixture()), { now: 1_000 });
    const state = await convergeOnce(h.d, initialAgentState());
    expect(state.appliedVersion).toBe("v1");
    expect(h.d.log).toHaveBeenCalledWith("[vm-agent] image reclaim after applying bundle v1 failed: prune images: HTTP 409 a prune operation is already running");
  });

  it("replaces only the container whose spec changed, leaving the other services and the init step untouched", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    let bundle = bundleFixture();
    const h = deps(docker, () => runtimeReply(bundle), clock);

    let state = await convergeOnce(h.d, initialAgentState());
    const [gateway, edge] = bundle.containers;
    bundle = bundleFixture({
      version: "v2",
      containers: [{ ...gateway, env: { ...gateway.env, NODE_OPTIONS: "--max-old-space-size=8192" } }, edge],
    });

    const before = docker.log.length;
    state = await convergeOnce(h.d, state);
    const events = docker.log.slice(before);

    expect(events).toContain("DELETE /containers/octogee-gateway");
    expect(events).toContain("POST /containers/octogee-gateway/start");
    expect(events).not.toContain("DELETE /containers/octogee-gateway-edge");
    expect(events).not.toContain("POST /containers/octogee-fix-perms/wait");
    expect(events.filter((l) => l.startsWith("POST /images/create"))).toHaveLength(1);
    expect(docker.containers.get("octogee-gateway")?.config.Env).toContain("NODE_OPTIONS=--max-old-space-size=8192");
    expect(state.appliedVersion).toBe("v2");

    const settled = docker.log.length;
    await convergeOnce(h.d, state);
    expect(docker.log.slice(settled).filter((l) => l.startsWith("POST /containers/create"))).toHaveLength(0);
  });

  it("writes the bundle's user claim into the home volume before init and the services start", async () => {
    const docker = fakeDocker();
    const h = deps(docker, () => runtimeReply(homeBundle()), { now: 1_000 });
    let logAtClaim = -1;
    const writeFile = h.d.fs.writeFile;
    h.d.fs.writeFile = async (path, content, mode) => {
      if (path.endsWith("/builder-claim.json")) logAtClaim = docker.log.length;
      await writeFile(path, content, mode);
    };

    await convergeOnce(h.d, initialAgentState());

    const claim = h.files.get("/srv/octogee/volumes/data/.openclaw/builder-claim.json");
    expect(claim?.mode).toBe(0o600);
    expect(JSON.parse(claim!.content)).toEqual({
      schemaVersion: 1, gatewayId: "b-x", ownerUid: "uid-bob", builderSlug: "bob",
      leaseId: null, generation: null, claimedAt: 1_000, overlayAppliedAt: null,
    });
    expect(h.chowns).toEqual(expect.arrayContaining(["/srv/octogee/volumes/data/.openclaw", "/srv/octogee/volumes/data/.openclaw/builder-claim.json"]));
    const initStart = docker.log.indexOf("POST /containers/octogee-fix-perms/start");
    expect(logAtClaim).toBeGreaterThanOrEqual(0);
    expect(logAtClaim).toBeLessThan(initStart);
  });

  describe("an existing user claim in the home volume", () => {
    const CLAIM_PATH = "/srv/octogee/volumes/data/.openclaw/builder-claim.json";
    const existing = (overrides: Record<string, unknown>) => JSON.stringify({
      schemaVersion: 1, gatewayId: "b-x", ownerUid: "uid-bob", builderSlug: "bob",
      leaseId: null, generation: null, claimedAt: 500, overlayAppliedAt: null, ...overrides,
    });

    it.each([
      ["the same gateway and owner", {}],
      ["the owner's own VM rebound from an earlier gateway", { gatewayId: "b-old" }],
    ])("rewrites a claim for %s", async (_label, overrides) => {
      const docker = fakeDocker();
      const h = deps(docker, () => runtimeReply(homeBundle()), { now: 1_000 });
      h.files.set(CLAIM_PATH, { content: existing(overrides), mode: 0o600 });

      await convergeOnce(h.d, initialAgentState());

      expect(JSON.parse(h.files.get(CLAIM_PATH)!.content)).toMatchObject({ gatewayId: "b-x", ownerUid: "uid-bob", builderSlug: "bob", claimedAt: 1_000 });
      expect(docker.log).toContain("POST /containers/octogee-gateway/start");
    });

    it.each([
      ["another owner", { ownerUid: "uid-mallory" }, /uid-mallory/],
      ["another user slug", { builderSlug: "mallory" }, /mallory/],
      ["unreadable content", { schemaVersion: 7 }, /malformed/],
    ])("refuses to start the gateway over a claim for %s", async (_label, overrides, named) => {
      const docker = fakeDocker();
      const h = deps(docker, () => runtimeReply(homeBundle()), { now: 1_000 });
      h.files.set(CLAIM_PATH, { content: existing(overrides), mode: 0o600 });

      await expect(convergeOnce(h.d, initialAgentState())).rejects.toThrow(named);

      expect(JSON.parse(h.files.get(CLAIM_PATH)!.content)).toMatchObject({ claimedAt: 500 });
      expect(docker.log.some((line) => line.startsWith("POST /containers/") && line.endsWith("/start"))).toBe(false);
    });

    it("writes a claim when the home holds none", async () => {
      const h = deps(fakeDocker(), () => runtimeReply(homeBundle()), { now: 1_000 });
      await convergeOnce(h.d, initialAgentState());
      expect(JSON.parse(h.files.get(CLAIM_PATH)!.content)).toMatchObject({ gatewayId: "b-x", ownerUid: "uid-bob" });
    });
  });

  it("derives the claim from an older platform's rendered owner env and writes none without an owner", async () => {
    const older = bundleFixture({
      containers: bundleFixture().containers.map((c) => ({ ...c, env: { ...c.env, GATEWAY_BUILDER_SLUG: "bob", GATEWAY_OWNER_UID: "uid-bob" } })),
    });
    const withEnv = deps(fakeDocker(), () => runtimeReply(older), { now: 1_000 });
    await convergeOnce(withEnv.d, initialAgentState());
    expect(JSON.parse(withEnv.files.get("/srv/octogee/volumes/data/.openclaw/builder-claim.json")!.content)).toMatchObject({ ownerUid: "uid-bob", builderSlug: "bob" });

    const ownerless = deps(fakeDocker(), () => runtimeReply(bundleFixture()), { now: 1_000 });
    await convergeOnce(ownerless.d, initialAgentState());
    expect([...ownerless.files.keys()].some((path) => path.endsWith("builder-claim.json"))).toBe(false);
    expect(ownerless.d.log).toHaveBeenCalledWith(expect.stringContaining("carries no user identity"));
  });

  it("re-runs init and recreates every service when only the init container changed, then settles", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    let bundle = bundleFixture();
    const h = deps(docker, () => runtimeReply(bundle), clock);

    let state = await convergeOnce(h.d, initialAgentState());
    bundle = bundleFixture({
      version: "v2",
      init: { ...bundleFixture().init!, command: ["sh", "-c", "cp -rn /etc/skel/. /home/node/ && chown -R 1000:1000 /home/node"] },
    });

    const before = docker.log.length;
    state = await convergeOnce(h.d, state);
    const events = docker.log.slice(before);
    expect(events).toContain("POST /containers/octogee-fix-perms/wait");
    expect(events.filter((l) => l.startsWith("POST /containers/create"))).toHaveLength(3);
    expect(state.appliedVersion).toBe("v2");

    const settled = docker.log.length;
    await convergeOnce(h.d, state);
    expect(docker.log.slice(settled).filter((l) => l.startsWith("POST /containers/create"))).toHaveLength(0);
  });

  it("keeps native boot admission owned by the agent after creation and checkpoint resume", async () => {
    const docker = fakeDocker();
    const clock = { now: 1000 };
    const h = deps(docker, () => runtimeReply(homeBundle()), clock, { home: { dirty: true } });
    const first = await convergeOnce(h.d, initialAgentState());
    for (const service of docker.containers.values()) {
      expect(service.config.HostConfig).toMatchObject({ RestartPolicy: { Name: "on-failure" } });
    }
    await convergeOnce(h.d, first);
    for (const service of docker.containers.values()) {
      expect(service.config.HostConfig).toMatchObject({ RestartPolicy: { Name: "on-failure" } });
    }
  });

  it("refreshes token files on the refresh interval and restarts a container that died", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    const h = deps(docker, () => runtimeReply(bundleFixture()), clock);
    let state = await convergeOnce(h.d, initialAgentState());
    h.files.clear();

    clock.now = 1_000 + TOKEN_REFRESH_MS - 1;
    state = await convergeOnce(h.d, state);
    expect(h.files.size).toBe(0);

    clock.now = 1_000 + TOKEN_REFRESH_MS;
    state = await convergeOnce(h.d, state);
    expect(h.files.size).toBe(3);
    expect(state.tokensWrittenAt).toBe(clock.now);

    docker.containers.get("octogee-gateway-edge")!.running = false;
    const before = docker.log.length;
    await convergeOnce(h.d, state);
    expect(docker.log.slice(before)).toContain("POST /containers/octogee-gateway-edge/start");
  });

  it("rejects a bundle for another gateway and surfaces API failures", async () => {
    const docker = fakeDocker();
    const other = deps(docker, () => runtimeReply(bundleFixture({ gatewayId: "b-y" })), { now: 1 });
    await expect(convergeOnce(other.d, initialAgentState())).rejects.toThrow(/not this gateway/);
    const denied = deps(docker, () => ({ status: 403, body: { error: "forbidden" } }), { now: 1 });
    await expect(convergeOnce(denied.d, initialAgentState())).rejects.toThrow(/HTTP 403/);
  });

  it("restores the current home checkpoint into an empty home before the init container runs, and never into a populated one", async () => {
    const docker = fakeDocker();
    const fresh = deps(docker, () => runtimeReply(homeBundle()), { now: 1_000 }, {
      home: { entries: [] },
      routes: { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: CHECKPOINT }) },
    });
    await convergeOnce(fresh.d, initialAgentState());
    const extract = docker.log.indexOf("tar --extract");
    const init = docker.log.indexOf("POST /containers/octogee-fix-perms/start");
    expect(extract).toBeGreaterThan(-1);
    expect(init).toBeGreaterThan(extract);
    expect(calls(fresh.fetchImpl, "/download")).toHaveLength(1);
    expect(fresh.d.log).toHaveBeenCalledWith(expect.stringContaining("home restore restored 20260905T101500Z.tar.gz"));

    const populated = deps(fakeDocker(), () => runtimeReply(homeBundle({ version: "v2" })), { now: 1_000 }, {
      routes: { "/internal/fleet/computer-home/download-url": () => { throw new Error("must not ask for a checkpoint"); } },
    });
    await convergeOnce(populated.d, initialAgentState());
    expect(calls(populated.fetchImpl, "/computer-home/download-url")).toHaveLength(0);

    const bare = deps(fakeDocker(), () => runtimeReply(bundleFixture()), { now: 1_000 }, { home: { entries: [] } });
    await convergeOnce(bare.d, initialAgentState());
    expect(calls(bare.fetchImpl, "/computer-home/download-url")).toHaveLength(0);
  });

  it("requires restoration when a recovery obligation is added to already-running containers", async () => {
    const docker = fakeDocker();
    let bundle = homeBundle();
    const h = deps(docker, () => runtimeReply(bundle), { now: 1000 });
    const state = await convergeOnce(h.d, initialAgentState());
    bundle = { ...bundle, homeRestoreCheckpoint: { name: CHECKPOINT.name, size: 2048, sha256: SHA, instanceId: "previous", generation: "9007199254740995", completedAt: 1000 } };
    await expect(convergeOnce(h.d, state)).rejects.toThrow("checkpoint is unavailable");
    expect(docker.containers.size).toBe(0);
  });

  describe("fresh checkpoint-backed home", () => {
    const required = { name: CHECKPOINT.name, size: 2048, sha256: SHA, instanceId: "previous", generation: "9007199254740995", completedAt: 1000, coverage: "builder-home-v2" as const, writerProtocol: 2 as const };
    const freshBoot = (docker: FakeDocker, clock = { now: 1_000 }) => deps(docker, () => runtimeReply(homeBundle({ homeRestoreCheckpoint: required })), clock, {
      home: { entries: [], gate: true },
      routes: { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: { ...required, download: CHECKPOINT.download } }) },
    });
    const at = (docker: FakeDocker, line: string) => {
      const index = docker.log.indexOf(line);
      expect(index, line).toBeGreaterThan(-1);
      return index;
    };

    it("installs the exact checkpoint before the gate opens, then admits writers before native init and the gateway", async () => {
      const docker = fakeDocker();
      const h = freshBoot(docker);
      await convergeOnce(h.d, initialAgentState());
      const order = ["tar --extract", "desktop stop-home", "rm home-restore.gate", "desktop start", "POST /containers/octogee-fix-perms/start", "POST /containers/octogee-gateway/start"].map((line) => at(docker, line));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(h.home.gate).toBe(false);
      expect(h.d.logError).not.toHaveBeenCalled();
    });

    it("keeps the gate closed and every writer and the gateway off when the restore fails, then admits them on a clean retry", async () => {
      const docker = fakeDocker();
      const clock = { now: 1_000 };
      const h = freshBoot(docker, clock);
      h.d.home.fs.replaceDirectoryContents = vi.fn(async () => { throw new Error("no space left on device"); });
      await expect(convergeOnce(h.d, initialAgentState())).rejects.toThrow("no space left on device");
      expect(h.home.gate).toBe(true);
      expect(docker.log).not.toContain("desktop start");
      expect(docker.containers.has("octogee-gateway")).toBe(false);
      expect(h.d.logError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ category: "home-restore", phase: "install", status: "failed" }));

      h.d.home.fs.replaceDirectoryContents = vi.fn(async () => {});
      clock.now += HOME_RESTORE_RETRY_MS;
      await convergeOnce(h.d, initialAgentState());
      expect(calls(h.fetchImpl, "/download")).toHaveLength(2);
      expect(h.home.gate).toBe(false);
      expect(at(docker, "desktop start")).toBeLessThan(at(docker, "POST /containers/octogee-gateway/start"));
    });

    it("backs off after a failed restore instead of downloading the checkpoint again on every converge", async () => {
      const docker = fakeDocker();
      const clock = { now: 1_000 };
      const h = freshBoot(docker, clock);
      h.d.home.fs.sha256 = vi.fn(async () => "d".repeat(64));
      await expect(convergeOnce(h.d, initialAgentState())).rejects.toThrow("sha256 mismatch");
      clock.now += HOME_RESTORE_RETRY_MS - 1;
      await expect(convergeOnce(h.d, initialAgentState())).rejects.toThrow(/home restore failed 1 time\(s\); retrying after/);
      expect(calls(h.fetchImpl, "/download")).toHaveLength(1);

      clock.now += 1;
      await expect(convergeOnce(h.d, initialAgentState())).rejects.toThrow("sha256 mismatch");
      expect(calls(h.fetchImpl, "/download")).toHaveLength(2);
      clock.now += HOME_RESTORE_RETRY_MS;
      await expect(convergeOnce(h.d, initialAgentState())).rejects.toThrow(/failed 2 time\(s\)/);
      expect(calls(h.fetchImpl, "/download")).toHaveLength(2);

      h.d.home.fs.sha256 = vi.fn(async () => SHA);
      clock.now += HOME_RESTORE_RETRY_MS;
      await convergeOnce(h.d, initialAgentState());
      expect(calls(h.fetchImpl, "/download")).toHaveLength(3);
      expect(h.home.gate).toBe(false);
      expect(at(docker, "desktop start")).toBeLessThan(at(docker, "POST /containers/octogee-gateway/start"));
    });

    it("refuses to admit writers or start the gateway when the gate is closed but the bundle carries no user home", async () => {
      const docker = fakeDocker();
      const h = deps(docker, () => runtimeReply(bundleFixture()), { now: 1_000 }, { home: { entries: [], gate: true } });
      await expect(convergeOnce(h.d, initialAgentState())).rejects.toThrow(/checkpoint restore gate/);
      expect(h.home.gate).toBe(true);
      expect(docker.log).not.toContain("desktop start");
      expect(docker.containers.has("octogee-gateway")).toBe(false);
    });

    it("starts a retained home's writers exactly as before", async () => {
      const docker = fakeDocker();
      const h = deps(docker, () => runtimeReply(homeBundle()), { now: 1_000 });
      await convergeOnce(h.d, initialAgentState());
      expect(docker.log.filter((line) => line.startsWith("desktop ") || line.startsWith("rm "))).toEqual(["desktop thaw", "desktop start"]);
      expect(at(docker, "desktop start")).toBeLessThan(at(docker, "POST /containers/octogee-fix-perms/start"));
      expect(calls(h.fetchImpl, "/computer-home/download-url")).toHaveLength(0);
    });
  });

  it("checkpoints a dirty home once the containers are steady, waits out the interval, and checkpoints immediately when the fleet controller asks", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    let signal = { requestedAt: null as number | null, completedAt: null as number | null };
    const h = deps(docker, () => runtimeReply(homeBundle(), signal), clock, { home: { dirty: true } });
    const uploads = () => calls(h.fetchImpl, "/upload").length;

    let state = await convergeOnce(h.d, initialAgentState());
    expect(uploads()).toBe(0);
    expect(state.homeCheckpointCheckedAt).toBeNull();

    state = await convergeOnce(h.d, state);
    expect(uploads()).toBe(1);
    expect(state.homeCheckpointCheckedAt).toBe(1_000);
    expect(calls(h.fetchImpl, "/computer-home/commit")).toHaveLength(1);
    expect(calls(h.fetchImpl, "/computer-home/prune")).toHaveLength(1);

    h.home.dirty = true;
    clock.now = 1_000 + HOME_CHECKPOINT_INTERVAL_MS - 1;
    state = await convergeOnce(h.d, state);
    expect(uploads()).toBe(1);

    clock.now = 1_000 + HOME_CHECKPOINT_INTERVAL_MS;
    state = await convergeOnce(h.d, state);
    expect(uploads()).toBe(2);
    expect(state.homeCheckpointCheckedAt).toBe(clock.now);

    clock.now += 1_000;
    state = await convergeOnce(h.d, state);
    expect(uploads()).toBe(2);

    signal = { requestedAt: clock.now, completedAt: clock.now - 1 };
    clock.now += 1_000;
    state = await convergeOnce(h.d, state);
    expect(uploads()).toBe(3);
    expect(docker.log.filter((l) => l === "find /srv/octogee/volumes/data")).toHaveLength(2);

    signal = { requestedAt: signal.requestedAt, completedAt: clock.now };
    clock.now += 1_000;
    await convergeOnce(h.d, state);
    expect(uploads()).toBe(3);
  });

  it("reports live images throughout slow checkpoint compression", async () => {
    const h = deps(fakeDocker(), () => runtimeReply(homeBundle()), { now: 1_000 }, { home: { dirty: true } });
    const state = await convergeOnce(h.d, initialAgentState());
    const compressing = Promise.withResolvers<void>();
    const compressed = Promise.withResolvers<void>();
    const run = h.d.home.shell.run;
    h.d.home.shell.run = async (command, args) => {
      if (command === "tar" && args[0] === "--create") {
        compressing.resolve();
        await compressed.promise;
      }
      return run(command, args);
    };
    const reports = () => calls(h.fetchImpl, "/vm-runtime").map(([, init]) => JSON.parse(String(init.body)));

    vi.useFakeTimers();
    const convergence = convergeOnce(h.d, state);
    try {
      await compressing.promise;
      const before = reports().length;
      await vi.advanceTimersByTimeAsync(180_000);
      const during = reports().slice(before);
      expect(during).toHaveLength(6);
      for (const report of during) {
        expect(report.images.containers).toEqual([
          expect.objectContaining({ name: "gateway", running: true }),
          expect.objectContaining({ name: "gateway-edge", running: true }),
        ]);
      }
      expect(calls(h.fetchImpl, "/computer-home/commit")).toHaveLength(0);
    } finally {
      compressed.resolve();
      await convergence;
      vi.useRealTimers();
    }
    expect(calls(h.fetchImpl, "/computer-home/commit")).toHaveLength(1);
  });

  it("holds final-checkpoint writers through upload and controller handoff, releasing them when replacement is cancelled", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    const bundle = homeBundle();
    const image = `registry.example/actual:deadbee@sha256:${"a".repeat(64)}`;
    bundle.init!.image = image;
    for (const container of bundle.containers) container.image = image;
    let signal = { requestedAt: null as number | null, completedAt: null as number | null };
    const h = deps(docker, () => runtimeReply(bundle, signal), clock, { diskUsage: async path => path === "/" ? { ...DISK, freeBytes: 1024 ** 3 } : DISK });
    let state = await convergeOnce(h.d, initialAgentState());
    signal = { requestedAt: 1_000, completedAt: null };
    const original = h.d.fetchImpl;
    h.d.fetchImpl = async (input, init) => {
      if (String(input).endsWith("/upload")) expect([...docker.containers.values()].every((c) => c.paused)).toBe(true);
      return original(input, init);
    };
    state = await convergeOnce(h.d, state);
    expect([...docker.containers.values()].every((c) => c.paused)).toBe(true);
    expect(JSON.parse(String(calls(h.fetchImpl, "/computer-home/commit")[0][1].body))).toMatchObject({ requestedAt: 1_000 });
    expect(h.d.log).toHaveBeenCalledWith(expect.stringMatching(/home snapshot pausing 2 writers .*requested/));
    expect(h.d.log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      gatewayId: bundle.gatewayId, builderSlug: bundle.builderIdentity?.builderSlug,
      category: "home-checkpoint", phase: "request-observed", status: "done", requestedAt: 1_000,
    }));
    signal = { requestedAt: 1_000, completedAt: 1_000 };
    await convergeOnce(h.d, initialAgentState());
    expect([...docker.containers.values()].every((c) => c.paused)).toBe(true);
    expect(logLines(h.d, "released")).toEqual([]);
    signal = { requestedAt: null, completedAt: 1_000 };
    await convergeOnce(h.d, state);
    expect([...docker.containers.values()].some((c) => c.paused)).toBe(false);
    expect(logLines(h.d, "released 2 held home writers")).toHaveLength(1);
    await convergeOnce(h.d, state);
    expect(logLines(h.d, "released 2 held home writers")).toHaveLength(1);
    for (const service of docker.containers.values()) expect(service.config.HostConfig).toMatchObject({ RestartPolicy: { Name: "on-failure" } });
  });

  it("keeps acknowledged final writers held when a service disappears or restarts", async () => {
    const docker = fakeDocker();
    const clock = { now: 1000 };
    let signal = { requestedAt: null as number | null, completedAt: null as number | null };
    const h = deps(docker, () => runtimeReply(homeBundle(), signal), clock);
    let state = await convergeOnce(h.d, initialAgentState());
    signal = { requestedAt: 1000, completedAt: null };
    state = await convergeOnce(h.d, state);
    signal = { requestedAt: 1000, completedAt: 1000 };
    const names = [...docker.containers.keys()];
    docker.containers.delete(names[0]);
    docker.containers.get(names[1])!.paused = false;
    docker.log.length = 0;
    await convergeOnce(h.d, state);
    expect([...docker.containers.values()].every((container) => container.paused)).toBe(true);
    expect(docker.log.some((line) => line.includes("/unpause"))).toBe(false);
    expect(docker.containers.has(names[0])).toBe(false);
    expect(h.d.home.desktop.run).not.toHaveBeenLastCalledWith("thaw");
  });

  it("holds final-checkpoint writers after a lost commit reply until the controller clears the request", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    let requestedAt: number | null = 1_000;
    const h = deps(docker, () => runtimeReply(homeBundle(), { requestedAt, completedAt: null }), clock,
      { routes: { "/internal/fleet/computer-home/commit": () => ({ status: 500, body: { error: "reply lost after commit" } }) } });
    const state = await convergeOnce(h.d, initialAgentState());
    const next = await convergeOnce(h.d, state);
    expect([...docker.containers.values()].every((c) => c.paused)).toBe(true);
    expect(h.d.log).toHaveBeenCalledWith(expect.stringContaining("home checkpoint failed"));
    await convergeOnce(h.d, next);
    expect([...docker.containers.values()].every((c) => c.paused)).toBe(true);
    requestedAt = null;
    await convergeOnce(h.d, next);
    expect([...docker.containers.values()].some((c) => c.paused)).toBe(false);
    for (const service of docker.containers.values()) expect(service.config.HostConfig).toMatchObject({ RestartPolicy: { Name: "on-failure" } });
    expect(h.d.home.desktop.run).toHaveBeenLastCalledWith("thaw");
  });

  it("reports a due checkpoint it cannot take because the bundle carries no user home", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    let signal = { requestedAt: null as number | null, completedAt: null as number | null };
    const h = deps(docker, () => runtimeReply(bundleFixture(), signal), clock);
    let state = await convergeOnce(h.d, initialAgentState());
    state = await convergeOnce(h.d, state);
    expect(h.d.log).toHaveBeenCalledWith("[vm-agent] home checkpoint skipped: bundle v1 carries no user home (data emptyDir + user identity)");
    expect(state.homeCheckpointCheckedAt).toBe(1_000);
    signal = { requestedAt: 1_500, completedAt: null };
    clock.now = 2_000;
    await convergeOnce(h.d, state);
    expect(h.d.log).toHaveBeenCalledWith("[vm-agent] home checkpoint skipped (requested at 1500): bundle v1 carries no user home (data emptyDir + user identity)");
    expect(calls(h.fetchImpl, "/upload")).toHaveLength(0);
  });

  it("logs a failed periodic checkpoint and keeps converging instead of throwing", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    const h = deps(docker, () => runtimeReply(homeBundle()), clock, {
      home: { dirty: true },
      routes: { "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 502, body: { error: "signing failed" } }) },
    });
    let state = await convergeOnce(h.d, initialAgentState());
    state = await convergeOnce(h.d, state);
    expect(state.homeCheckpointCheckedAt).toBe(1_000);
    expect(h.d.log).toHaveBeenCalledWith(expect.stringContaining("home checkpoint failed: vm-home checkpoint-url: HTTP 502"));
  });
});

describe("watchPreemption", () => {
  function watching(answers: Array<boolean | Error>, replies: number[]) {
    const docker = fakeDocker();
    const h = deps(docker, () => ({ status: replies.shift() ?? 200, body: {} }), { now: 0 });
    const asked: boolean[] = [];
    h.d.metadata.preempted = vi.fn(async (waitForChange: boolean) => {
      asked.push(waitForChange);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("watched past the preemption");
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); };
    return { ...h, asked, sleeps, sleep };
  }

  it("reports the preemption to the fleet controller through the runtime channel the moment GCE announces it, then stops watching", async () => {
    const h = watching([false, true], []);

    await watchPreemption(h.d, { sleep: h.sleep });

    expect(h.asked).toEqual([false, true]);
    const reports = calls(h.fetchImpl, "/internal/fleet/vm-runtime");
    expect(reports).toHaveLength(1);
    expect(JSON.parse(String(reports[0][1].body))).toEqual({ gatewayId: "b-x", preempted: true });
    expect(h.d.log).toHaveBeenCalledWith(expect.stringMatching(/GCE announced this Spot VM's preemption/));
    expect(h.sleeps).toEqual([]);
  });

  it("keeps reporting until the API records it, and keeps watching through a metadata hiccup", async () => {
    const h = watching([new Error("metadata instance/preempted: HTTP 503"), true, true], [503]);

    await watchPreemption(h.d, { sleep: h.sleep });

    expect(h.asked).toEqual([false, false, false]);
    expect(calls(h.fetchImpl, "/internal/fleet/vm-runtime")).toHaveLength(2);
    expect(h.sleeps).toEqual([PREEMPTION_WATCH_RETRY_MS, PREEMPTION_WATCH_RETRY_MS]);
    expect(h.d.log).toHaveBeenCalledWith(expect.stringMatching(/preemption watch failed: metadata instance\/preempted: HTTP 503/));
    expect(h.d.log).toHaveBeenCalledWith(expect.stringMatching(/preemption watch failed: vm-runtime: HTTP 503/));
  });

  it("stops watching when the agent stops", async () => {
    const h = watching([], []);

    await watchPreemption(h.d, { sleep: h.sleep, stop: () => true });

    expect(h.asked).toEqual([]);
  });
});
