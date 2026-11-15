import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startSurgeOpenClawSupervisor, type StartedSurgeOpenClawSupervisor } from "../entrypoints/surge-openclaw-supervisor.js";

const pidWrite = vi.hoisted(() => ({ paused: undefined as { entered: () => void; wait: Promise<void> } | undefined, failRemoval: undefined as (() => void) | undefined }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (String(args[0]).endsWith("/.surge-openclaw-process.pid") && pidWrite.failRemoval) {
      pidWrite.failRemoval();throw new Error("owned PID removal failed");
    }
    return actual.rm(...args);
  }, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    if (String(args[0]).endsWith("/.surge-openclaw-process.pid") && pidWrite.paused) {
      pidWrite.paused.entered();await pidWrite.paused.wait;
    }
    return actual.writeFile(...args);
  } };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("owned shutdown barrier was not reached")), 2000);
  })]); } finally { clearTimeout(timer); }
}
const active: Array<{ root: string; socket: string; supervisor: StartedSurgeOpenClawSupervisor; children: ChildProcess[]; release: () => void }> = [];

async function fixture(block: "health" | "preparation" | "pid-write", nativeExit = 0) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "surge-stop-")), socket = path.join(os.tmpdir(), `gs-${randomUUID().slice(0, 12)}.sock`);
  const entered = deferred<void>(), health = deferred<boolean>(), preparation = deferred<void>(), nativeStopping = deferred<void>(), nativeReady = deferred<void>();
  if (block === "pid-write") pidWrite.paused = { entered: () => entered.resolve(), wait: preparation.promise };
  const children: ChildProcess[] = [];let healthyCalls = 0, termCount = 0, unexpectedExits = 0;
  const supervisor = await startSurgeOpenClawSupervisor({
    openclawDir: root, podUid: "owned-shutdown-pod", socketPath: socket, log: () => {}, readinessReleased: async () => true,
    prepareTarget: async () => {}, prepareDatabases: async () => {}, stopGraceMs: 1000,
    onUnexpectedChildExit: () => { unexpectedExits++; },
    bootWatcher: { beforeStart: async () => { if (block === "preparation") { entered.resolve();await preparation.promise; } }, healthy: async () => { healthyCalls++; } },
    probeHealthz: async () => {
      if (children.length === 0) return false;
      if (block === "health") { entered.resolve();return health.promise; }
      return true;
    },
    spawnOpenClaw: () => {
      const child = spawn(process.execPath, ["-e", `let stopping=false;
process.on('SIGTERM',()=>{stopping=true;process.send('stopping');${block !== "health" ? "process.exit(0);" : ""}});
process.on('message',message=>{if(stopping&&message==='finish'){process.exit(${nativeExit});}});setInterval(()=>{},1000);process.send('ready');`], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      child.on("message", message => { if (message === "ready") { nativeReady.resolve(); }if (message === "stopping") { termCount++;nativeStopping.resolve(); } });
      children.push(child);return child;
    },
  });
  const release = () => { health.resolve(false);preparation.resolve(); };
  active.push({ root, socket, supervisor, children, release });
  await bounded(entered.promise);
  if (children[0]) await bounded(nativeReady.promise);
  return { root, supervisor, children, nativeStopping: nativeStopping.promise, release, healthyCalls: () => healthyCalls, termCount: () => termCount, unexpectedExits: () => unexpectedExits };
}

afterEach(async () => {
  for (const f of active.splice(0)) {
    f.release();
    await Promise.all(f.children.map(async child => {
      if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit");child.kill("SIGKILL");await exit; }
    }));
    await bounded(f.supervisor.stop()).catch(() => {});
    await fs.rm(f.root, { recursive: true, force: true });await fs.rm(f.socket, { force: true });
  }
  pidWrite.paused = undefined;pidWrite.failRemoval = undefined;
});

it("preempts unhealthy startup and joins the detached child without waiting for its blocked health probe", async () => {
  const f = await fixture("health"), child = f.children[0]!, exit = once(child, "exit");
  const stop = f.supervisor.stop(), repeated = f.supervisor.stop();void stop.catch(() => {});void repeated.catch(() => {});
  await bounded(f.nativeStopping);
  expect(child.exitCode).toBeNull();expect(f.healthyCalls()).toBe(0);
  child.send("finish");
  await bounded(Promise.all([stop, repeated]));expect(await exit).toEqual([0, null]);
  expect(f.termCount()).toBe(1);expect(f.children).toHaveLength(1);expect(f.unexpectedExits()).toBe(0);
  await expect(fs.stat(path.join(f.root, ".surge-openclaw-process.pid"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not retry a pre-health child exit once terminal shutdown has been requested", async () => {
  const f = await fixture("health"), child = f.children[0]!, exit = once(child, "exit");
  child.kill("SIGKILL");await exit;
  await bounded(f.supervisor.stop());
  expect(f.children).toHaveLength(1);expect(f.healthyCalls()).toBe(0);expect(f.unexpectedExits()).toBe(0);
});

it("joins the in-flight owned PID write before final shutdown cleanup", async () => {
  const f = await fixture("pid-write"), child = f.children[0]!, exit = once(child, "exit");let stopped = false;
  const stop = f.supervisor.stop().then(() => { stopped = true; });void stop.catch(() => {});
  await bounded(f.nativeStopping);expect(await exit).toEqual([0, null]);
  expect(stopped).toBe(false);f.release();await bounded(stop);
  expect(f.children).toHaveLength(1);expect(f.healthyCalls()).toBe(0);
  await expect(fs.stat(path.join(f.root, ".surge-openclaw-process.pid"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not spawn or mark healthy after a pending startup preparation finishes during shutdown", async () => {
  const f = await fixture("preparation"), stop = f.supervisor.stop();void stop.catch(() => {});
  f.release();await bounded(stop);
  expect(f.children).toHaveLength(0);expect(f.healthyCalls()).toBe(0);
  await expect(fs.stat(path.join(f.root, ".surge-openclaw-process.pid"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects terminal shutdown after joining a real Native child whose cleanup exits unsuccessfully", async () => {
  const f = await fixture("health", 23), child = f.children[0]!, exit = once(child, "exit");
  const stop = f.supervisor.stop();void stop.catch(() => {});
  await bounded(f.nativeStopping);child.send("finish");
  await expect(bounded(stop)).rejects.toThrow("23");expect(await exit).toEqual([23, null]);
  expect(f.children).toHaveLength(1);expect(f.healthyCalls()).toBe(0);
  await expect(fs.stat(path.join(f.root, ".surge-openclaw-process.pid"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("joins an admitted PID writer and attempts final cleanup even when initial PID removal fails", async () => {
  const f = await fixture("pid-write"), removal = deferred<void>(), child = f.children[0]!, exit = once(child, "exit");
  let outcome = "pending", removals = 0;
  pidWrite.failRemoval = () => { if (++removals === 2) removal.resolve(); };
  const stop = f.supervisor.stop().then(() => { outcome = "resolved"; }, error => { outcome = "rejected";throw error; });void stop.catch(() => {});
  await bounded(removal.promise);expect(await exit).toEqual([0, null]);
  expect(outcome).toBe("pending");pidWrite.failRemoval = undefined;f.release();
  await expect(bounded(stop)).rejects.toThrow("owned PID removal failed");
  expect(f.children).toHaveLength(1);expect(f.healthyCalls()).toBe(0);
  await expect(fs.stat(path.join(f.root, ".surge-openclaw-process.pid"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("reports forced terminal cleanup as failure after the owned child is physically joined", async () => {
  const f = await fixture("health"), child = f.children[0]!, exit = once(child, "exit");
  const stop = f.supervisor.stop();void stop.catch(() => {});
  await bounded(f.nativeStopping);
  await expect(bounded(stop)).rejects.toThrow("SIGKILL");expect(await exit).toEqual([null, "SIGKILL"]);
  expect(f.children).toHaveLength(1);expect(f.healthyCalls()).toBe(0);
  await expect(fs.stat(path.join(f.root, ".surge-openclaw-process.pid"))).rejects.toMatchObject({ code: "ENOENT" });
});
