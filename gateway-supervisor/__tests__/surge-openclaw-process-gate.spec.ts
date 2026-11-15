import { EventEmitter, once } from "node:events";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSurgeOpenClawProcessGate,
  createSurgeOpenClawProcessSupervisorClient,
  SURGE_OPENCLAW_PROCESS_GATE_FILE,
} from "../lib/surge-openclaw-process-gate.js";
import { createSurgeReadinessGate } from "../lib/surge-readiness.js";
import { createSurgeOpenClawBootWatcher, startSurgeOpenClawSupervisor } from "../entrypoints/surge-openclaw-supervisor.js";
import { createIsolatedSurgeGateWiring } from "../lib/fleet-provisioner.js";
import * as userStores from "../lib/openclaw-user-store-preflight.js";
import type { UserLifecycleAdapter } from "../lib/user-lifecycle.js";
import { stubUserClaim } from "./helpers/user-claim.js";

const roots: string[] = [];

async function temporaryOpenClawDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "octogee-surge-openclaw-process-"));
  roots.push(root);
  return root;
}

class FakeChild extends EventEmitter {
  alive = true;
  constructor(private readonly ignoresSigterm = false) {
    super();
  }
  readonly kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === "SIGTERM" && this.ignoresSigterm) return this.alive;
    if (!this.alive) return false;
    this.alive = false;
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  });
}

function healthzOf(children: FakeChild[]): () => Promise<boolean> {
  return async () => children.some((child) => child.alive);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("surge OpenClaw process gate", () => {
  it("defaults a fresh or stale-pod record to held", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);

    await expect(gate.ensure({ podUid: "pod-new", readinessReleased: false })).resolves.toMatchObject({
      podUid: "pod-new",
      role: "normal",
      mode: "held",
      phase: "held",
    });

    await fs.writeFile(
      path.join(openclawDir, SURGE_OPENCLAW_PROCESS_GATE_FILE),
      JSON.stringify({
        version: 1,
        podUid: "pod-old",
        role: "normal",
        mode: "permitted",
        phase: "running",
      }),
    );

    await expect(gate.ensure({ podUid: "pod-newer", readinessReleased: false })).resolves.toMatchObject({
      podUid: "pod-newer",
      mode: "held",
      phase: "held",
    });
  });

  it("persists source stopping before target transfer and resumes any held source", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid: "source-pod", readinessReleased: true });
    const request = {
      podUid: "source-pod",
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await expect(gate.hold(request)).resolves.toMatchObject({
      role: "source",
      mode: "held",
      phase: "stopping",
    });
    await expect(gate.markHeld(request)).resolves.toMatchObject({ phase: "held" });
    await expect(gate.resumeSource({ ...request, migrationId: "surge-gateway-replaced" }))
      .resolves.toMatchObject({
        role: "source",
        mode: "permitted",
        phase: "starting",
      });
  });

  it("retains completion-started evidence across a target rehold and supervisor restart", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    const request = { podUid: "target-pod", migrationId: "surge-gateway-target", slug: "ceckert-test", targetPodUid: "target-pod" };
    await gate.ensure({ podUid: "target-pod", readinessReleased: false });
    await gate.hydrateTarget(request);
    expect(await gate.claimTargetCompletion(request)).toMatchObject({ completionStarted: true });
    await gate.permitTarget(request);
    await gate.reholdTarget(request);
    await gate.markHeld(request);
    expect(await createSurgeOpenClawProcessGate(openclawDir).read()).toMatchObject({
      role: "target", mode: "held", phase: "held", completionStarted: true,
    });
    await gate.reholdTarget(request);
    expect(await gate.finalizeTargetCancellation(request)).toMatchObject({
      terminalTarget: { migrationId: request.migrationId, slug: request.slug, targetPodUid: request.targetPodUid, completionStarted: true },
    });
  });

  it("settles a completed migration back to a normal record and refuses to settle a held one", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid: "target-pod", readinessReleased: false });
    const request = {
      podUid: "target-pod",
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await gate.hydrateTarget(request);
    await expect(gate.settle({ podUid: "target-pod" })).rejects.toThrow(
      "cannot settle a held surge OpenClaw process gate",
    );
    await gate.claimTargetCompletion(request);
    await gate.permitTarget(request);
    await gate.markRunning({ podUid: "target-pod", migrationId: request.migrationId });
    await expect(gate.settle({ podUid: "target-pod" })).resolves.toEqual({
      version: 1,
      podUid: "target-pod",
      role: "normal",
      mode: "permitted",
      phase: "running",
    });
  });

  it("lets a new migration hold through an unsettled finished one but never an active start", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid: "target-pod", readinessReleased: false });
    const finished = {
      podUid: "target-pod",
      migrationId: "surge-gateway-finished",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };
    const next = { ...finished, migrationId: "surge-gateway-next", targetPodUid: "other-target" };

    await gate.hydrateTarget(finished);
    await gate.claimTargetCompletion(finished);
    await gate.permitTarget(finished);
    await expect(gate.hold(next)).rejects.toThrow("belongs to surge-gateway-finished");
    await gate.markRunning({ podUid: "target-pod", migrationId: finished.migrationId });
    await expect(gate.hold(next)).resolves.toMatchObject({
      role: "source",
      mode: "held",
      phase: "stopping",
      migrationId: "surge-gateway-next",
    });
  });

  it("keeps a target reservation across unreserve mismatches and clears only its own", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid: "target-pod", readinessReleased: false });
    const request = {
      podUid: "target-pod",
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await gate.hydrateTarget(request);
    await expect(gate.unreserveTarget({ ...request, migrationId: "other" })).rejects.toThrow(
      "does not reserve this target migration",
    );
    await expect(gate.unreserveTarget(request)).resolves.toEqual({
      version: 1,
      podUid: "target-pod",
      role: "normal",
      mode: "held",
      phase: "held",
      terminalTarget: { migrationId: request.migrationId, slug: request.slug, targetPodUid: request.targetPodUid, completionStarted: false },
    });
    await expect(gate.unreserveTarget(request)).resolves.toMatchObject({ role: "normal" });
  });

  it("refuses a stale target permit after its matching unreserve", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid: "target-pod", readinessReleased: false });
    const request = {
      podUid: "target-pod",
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await gate.hydrateTarget(request);
    await gate.unreserveTarget(request);

    await expect(gate.permitTarget(request)).rejects.toThrow(
      "does not reserve this target migration",
    );
    await expect(gate.reholdTarget(request)).rejects.toThrow(
      "does not reserve this target migration",
    );
    await expect(gate.read()).resolves.toEqual({
      version: 1,
      podUid: "target-pod",
      role: "normal",
      mode: "held",
      phase: "held",
      terminalTarget: { migrationId: request.migrationId, slug: request.slug, targetPodUid: request.targetPodUid, completionStarted: false },
    });
  });

  it("restarts a released pod serving and keeps held records held except healed normal residue", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    const request = {
      podUid: "pod-a",
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "pod-a",
    };

    await gate.ensure({ podUid: "pod-a", readinessReleased: false });
    await gate.hydrateTarget(request);
    await expect(gate.ensure({ podUid: "pod-a", readinessReleased: true })).resolves.toMatchObject({
      role: "target",
      mode: "held",
      migrationId: request.migrationId,
    });

    await gate.claimTargetCompletion(request);
    await gate.permitTarget(request);
    await expect(gate.ensure({ podUid: "pod-a", readinessReleased: false })).resolves.toMatchObject({
      role: "target",
      mode: "held",
      phase: "held",
    });

    await gate.claimTargetCompletion(request);
    await gate.permitTarget(request);
    await expect(gate.ensure({ podUid: "pod-a", readinessReleased: true })).resolves.toEqual({
      version: 1,
      podUid: "pod-a",
      role: "normal",
      mode: "permitted",
      phase: "starting",
      terminalTarget: {
        migrationId: request.migrationId,
        slug: request.slug,
        targetPodUid: request.targetPodUid,
        completionStarted: true,
      },
    });
    await expect(gate.hold(request)).rejects.toThrow("target migration already released");

    await gate.holdNormal({ podUid: "pod-a" });
    await expect(gate.ensure({ podUid: "pod-a", readinessReleased: true })).resolves.toMatchObject({
      role: "normal",
      mode: "permitted",
      phase: "starting",
    });
  });

  it("cancels a matching target permit before it can release readiness", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid: "target-pod", readinessReleased: false });
    const request = {
      podUid: "target-pod",
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await gate.hydrateTarget(request);
    await gate.claimTargetCompletion(request);
    await gate.permitTarget(request);
    await expect(gate.hold(request)).resolves.toMatchObject({
      role: "target",
      mode: "held",
      phase: "cancelling",
      migrationId: request.migrationId,
    });
  });

  it("preserves a target cancellation across restart and clears it only through its finalizer", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    const request = {
      podUid: "target-pod",
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };
    await gate.ensure({ podUid: request.podUid, readinessReleased: false });
    await gate.hydrateTarget(request);
    await gate.claimTargetCompletion(request);
    await expect(gate.hold(request)).resolves.toMatchObject({
      role: "target",
      mode: "held",
      phase: "cancelling",
    });
    await expect(gate.claimTargetCompletion(request)).rejects.toThrow("target completion is not held");
    await expect(gate.unreserveTarget(request)).rejects.toThrow("cannot unreserve a claimed");
    await expect(gate.ensure({ podUid: request.podUid, readinessReleased: false })).resolves.toMatchObject({
      role: "target",
      mode: "held",
      phase: "cancelling",
    });
    await expect(gate.finalizeTargetCancellation(request)).resolves.toEqual({
      version: 1,
      podUid: request.podUid,
      role: "normal",
      mode: "held",
      phase: "held",
      terminalTarget: { migrationId: request.migrationId, slug: request.slug, targetPodUid: request.targetPodUid, completionStarted: true },
    });
  });

  it("permits a proven no-sibling user without inventing a migration identity", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid: "pod-self", readinessReleased: false });

    await expect(gate.permitNormal({ podUid: "pod-self" })).resolves.toEqual({
      version: 1,
      podUid: "pod-self",
      role: "normal",
      mode: "permitted",
      phase: "starting",
    });
  });
});

describe("surge OpenClaw process supervisor", () => {

  it("prepares SQLite journals before every cold start and source resume", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const children: FakeChild[] = [];
    const order: string[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir, podUid: "source-pod", log: () => undefined, socketPath,
      readinessReleased: async () => true,
      prepareDatabases: async () => { order.push("journals"); },
      spawnOpenClaw: () => { order.push("spawn"); const child = new FakeChild(); children.push(child); return child; },
      probeHealthz: healthzOf(children), healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = { migrationId: "migration-journals", slug: "jefe", targetPodUid: "target-pod" };
    try {
      await vi.waitFor(() => expect(children).toHaveLength(1));
      await client.hold(request);
      await client.resume(request);
      expect(order).toEqual(["journals", "spawn", "journals", "spawn"]);
    } finally { await supervisor.stop(); }
  });

  describe("what the supervisor records", () => {
    it("logs each process gate transition once, with the migration that owns it", async () => {
      const openclawDir = await temporaryOpenClawDir();
      const logs: string[] = [];
      const gate = createSurgeOpenClawProcessGate(openclawDir, line => { logs.push(line); });
      await gate.ensure({ podUid: "pod-1", readinessReleased: true });
      await gate.holdNormal({ podUid: "pod-1" });
      await gate.holdNormal({ podUid: "pod-1" });
      expect(logs).toEqual([
        "[surge-openclaw] process gate none -> normal/permitted/starting pod=pod-1",
        "[surge-openclaw] process gate normal/permitted/starting -> normal/held/stopping pod=pod-1",
      ]);
      await gate.hold({ podUid: "pod-1", migrationId: "migration-1", slug: "jefe", targetPodUid: "target-pod" });
      expect(logs.at(-1)).toContain("migration=migration-1 slug=jefe");
    });

    it("logs the boot decision, OpenClaw's start and health timing, each request, and how it stopped", async () => {
      const openclawDir = await temporaryOpenClawDir();
      const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
      const children: FakeChild[] = [], logs: string[] = [];
      const supervisor = await startSurgeOpenClawSupervisor({
        openclawDir, podUid: "source-pod", log: line => { logs.push(line); }, socketPath, readinessReleased: async () => true,
        spawnOpenClaw: () => { const child = new FakeChild(); children.push(child); return child; },
        probeHealthz: healthzOf(children), healthTimeoutMs: 100,
      });
      const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
      try {
        await vi.waitFor(() => expect(logs.join("\n")).toMatch(/OpenClaw healthy after \d+ms/));
        await client.hold({ migrationId: "migration-1", slug: "jefe", targetPodUid: "target-pod" });
        const text = logs.join("\n");
        expect(text).toMatch(/boot gate pod=source-pod prior=none readinessReleased=true prelaunchBoot=false activation=none hold=false/);
        expect(text).toMatch(/OpenClaw spawned pid=/);
        expect(text).toMatch(/gate request hold migration=migration-1 slug=jefe/);
        expect(text).toMatch(/OpenClaw exited code=0 signal=none after \d+ms/);
        expect(text).toMatch(/OpenClaw stopped in \d+ms/);
      } finally { await supervisor.stop(); }
    });

    it("does not log routine status reads", async () => {
      const openclawDir = await temporaryOpenClawDir();
      const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
      const children: FakeChild[] = [], logs: string[] = [];
      const supervisor = await startSurgeOpenClawSupervisor({
        openclawDir, podUid: "source-pod", log: line => { logs.push(line); }, socketPath, readinessReleased: async () => true,
        spawnOpenClaw: () => { const child = new FakeChild(); children.push(child); return child; },
        probeHealthz: healthzOf(children), healthTimeoutMs: 100,
      });
      const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
      try {
        await vi.waitFor(() => expect(logs.join("\n")).toMatch(/OpenClaw healthy/));
        await client.status();
        expect(logs.filter(line => line.includes("gate request"))).toEqual([]);
      } finally { await supervisor.stop(); }
    });
  });

  describe("a failed first start", () => {
    async function supervisorFailingFirstStarts(failures: number, retryWait: (ms: number) => Promise<void>) {
      const sleep = (ms: number) => ms >= 5_000 ? retryWait(ms) : new Promise<void>(resolve => { setTimeout(resolve, ms); });
      const openclawDir = await temporaryOpenClawDir(), socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
      const children: FakeChild[] = [], logs: string[] = [];
      const spawnOpenClaw = vi.fn(() => { const child = new FakeChild(); children.push(child); return child; });
      let attempts = 0;
      const prepareDatabases = vi.fn(async () => {
        attempts += 1;
        if (attempts <= failures) throw new Error("Connection terminated due to connection timeout");
      });
      const supervisor = await startSurgeOpenClawSupervisor({
        openclawDir, podUid: "builder-pod", socketPath, log: line => { logs.push(line); }, readinessReleased: async () => true,
        prepareTarget: async () => undefined, prepareDatabases, spawnOpenClaw, probeHealthz: healthzOf(children), healthTimeoutMs: 100, stopGraceMs: 1_000, sleep,
      });
      return { client: createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath }), supervisor, spawnOpenClaw, prepareDatabases, logs };
    }

    function pausedRetryWait() {
      let entered = false, release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      return { reached: () => vi.waitFor(() => expect(entered).toBe(true)), release, sleep: () => { entered = true; return released; } };
    }

    it("starts OpenClaw once the failure clears", async () => {
      const delays: number[] = [];
      const f = await supervisorFailingFirstStarts(2, async ms => { delays.push(ms); });
      try {
        await vi.waitFor(async () => expect(await f.client.status()).toMatchObject({ mode: "permitted", phase: "running" }));
        expect(f.prepareDatabases).toHaveBeenCalledTimes(3);
        expect(f.spawnOpenClaw).toHaveBeenCalledTimes(1);
        expect(delays).toEqual([5_000, 10_000]);
        expect(f.logs.filter(line => line.includes("initial permitted start failed"))).toHaveLength(2);
      } finally { await f.supervisor.stop(); }
    });

    it("backs off to a one-minute retry while the failure persists", async () => {
      const delays: number[] = [];
      const f = await supervisorFailingFirstStarts(6, async ms => { delays.push(ms); });
      try {
        await vi.waitFor(async () => expect(await f.client.status()).toMatchObject({ phase: "running" }));
        expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
      } finally { await f.supervisor.stop(); }
    });

    it("stays held and never starts OpenClaw while the failure persists", async () => {
      const wait = pausedRetryWait();
      const f = await supervisorFailingFirstStarts(Number.POSITIVE_INFINITY, wait.sleep);
      try {
        await wait.reached();
        expect(f.spawnOpenClaw).not.toHaveBeenCalled();
        await expect(f.client.status()).resolves.toMatchObject({ mode: "held", phase: "held" });
      } finally { await f.supervisor.stop(); wait.release(); }
    });

    it("leaves a hold requested during the retry wait in place", async () => {
      const wait = pausedRetryWait();
      const f = await supervisorFailingFirstStarts(1, wait.sleep);
      try {
        await wait.reached();
        await f.client.holdNormal();
        wait.release();
        await f.client.holdNormal();
        expect(f.prepareDatabases).toHaveBeenCalledTimes(1);
        expect(f.spawnOpenClaw).not.toHaveBeenCalled();
        await expect(f.client.status()).resolves.toMatchObject({ mode: "held", phase: "held" });
      } finally { await f.supervisor.stop(); }
    });

    it("stops retrying when the supervisor stops", async () => {
      const wait = pausedRetryWait();
      const f = await supervisorFailingFirstStarts(1, wait.sleep);
      try {
        await wait.reached();
        await f.supervisor.stop();
        wait.release();
        await new Promise(resolve => setImmediate(resolve));
        expect(f.prepareDatabases).toHaveBeenCalledTimes(1);
        expect(f.spawnOpenClaw).not.toHaveBeenCalled();
      } finally { await f.supervisor.stop(); }
    });
  });

  it("keeps a user boot held until a migration releases it", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const spawnOpenClaw = vi.fn(() => new FakeChild());
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir, podUid: "owned-pod", log: () => undefined, socketPath,
      prepareTarget: async () => undefined, prepareDatabases: async () => undefined,
      spawnOpenClaw, probeHealthz: async () => false, healthTimeoutMs: 100,
    });
    try {
      await expect(supervisor.state()).resolves.toMatchObject({ mode: "held" });
      await expect(createSurgeReadinessGate(openclawDir, "owned-pod").released()).resolves.toBe(false);
      expect(spawnOpenClaw).not.toHaveBeenCalled();
    } finally { await supervisor.stop(); }
  });

  it("keeps OpenClaw held when journal integrity preparation fails", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const spawnOpenClaw = vi.fn(() => new FakeChild());
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir, podUid: "source-pod", log: () => undefined, socketPath,
      readinessReleased: async () => false,
      prepareTarget: async () => undefined,
      prepareDatabases: async () => { throw new Error("database integrity refused"); },
      spawnOpenClaw, probeHealthz: async () => false, healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    try {
      await expect(client.permitNormal()).rejects.toThrow("database integrity refused");
      expect(spawnOpenClaw).not.toHaveBeenCalled();
      await expect(client.status()).resolves.toMatchObject({ phase: "held" });
    } finally { await supervisor.stop(); }
  });
  it("validates configured user anchors before normal startup on a new build", async () => {
    const openclawDir = await temporaryOpenClawDir(), socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const order: string[] = [], children: FakeChild[] = [];
    const inspection = vi.spyOn(userStores, "inspectConfiguredUserAgentStores")
      .mockImplementationOnce(async () => { expect(children).toHaveLength(0); order.push("inspect"); return "exact"; });
    const bootWatcher = createSurgeOpenClawBootWatcher({
      openclawDir, releaseKey: "isolated-release", log: () => {}, env: { GATEWAY_CLASS: "isolated", OPENCLAW_CONFIG_PATH: path.join(openclawDir, "system_config/openclaw.json") },
      client: { claimOpenClawBoot: vi.fn().mockResolvedValue({ action: "start" }), completeOpenClawBoot: vi.fn(), completeOpenClawDoctor: vi.fn() },
      installedOpenClawBuild: async () => "b".repeat(40),
    });
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir, podUid: "builder-pod", socketPath, log: () => {}, readinessReleased: async () => false,
      prepareSystemStore: async (assertStopped) => { await assertStopped(); expect(children).toHaveLength(0); order.push("system"); },
      prepareTarget: async () => { order.push("target"); }, prepareDatabases: async () => {}, bootWatcher,
      spawnOpenClaw: () => { order.push("spawn"); const child = new FakeChild(); children.push(child); return child; },
      probeHealthz: healthzOf(children), healthTimeoutMs: 100,
    });
    try {
      await createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath }).permitNormal();
      expect(order).toEqual(["system", "target", "inspect", "spawn"]);
      expect(inspection).toHaveBeenCalledWith({ stateDir: openclawDir, configPath: path.join(openclawDir, "system_config/openclaw.json") });
    } finally { await supervisor.stop(); inspection.mockRestore(); }
  });

  it("keeps the user process held when configured-store inspection refuses startup", async () => {
    const openclawDir = await temporaryOpenClawDir(), socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const inspection = vi.spyOn(userStores, "inspectConfiguredUserAgentStores").mockRejectedValue(new Error("newer store schema refused"));
    const spawnOpenClaw = vi.fn(() => new FakeChild());
    const bootWatcher = createSurgeOpenClawBootWatcher({ openclawDir, releaseKey: "isolated-release", log: () => {}, env: { GATEWAY_CLASS: "isolated" },
      client: { claimOpenClawBoot: vi.fn().mockResolvedValue({ action: "start" }), completeOpenClawBoot: vi.fn(), completeOpenClawDoctor: vi.fn() } });
    const supervisor = await startSurgeOpenClawSupervisor({ openclawDir, podUid: "builder-pod", socketPath, log: () => {},
      readinessReleased: async () => false, prepareTarget: async () => {}, prepareDatabases: async () => {}, bootWatcher, spawnOpenClaw, probeHealthz: async () => false });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    try { await expect(client.permitNormal()).rejects.toThrow("newer store schema refused"); expect(spawnOpenClaw).not.toHaveBeenCalled();
      await expect(client.status()).resolves.toMatchObject({ phase: "held" });
    } finally { await supervisor.stop(); inspection.mockRestore(); }
  });

  it("keeps the user held when native system-store maintenance refuses startup", async () => {
    const openclawDir = await temporaryOpenClawDir(), socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const spawnOpenClaw = vi.fn(() => new FakeChild()), prepareTarget = vi.fn(async () => {});
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir, podUid: "builder-pod", socketPath, log: () => {}, readinessReleased: async () => false,
      prepareSystemStore: async () => { throw new Error("native system-store maintenance refused"); },
      prepareTarget, prepareDatabases: async () => {}, spawnOpenClaw, probeHealthz: async () => false,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    try {
      await expect(client.permitNormal()).rejects.toThrow("native system-store maintenance refused");
      expect(spawnOpenClaw).not.toHaveBeenCalled(); expect(prepareTarget).not.toHaveBeenCalled();
      await expect(client.status()).resolves.toMatchObject({ phase: "held" });
    } finally { await supervisor.stop(); }
  });

  it("does not apply user configured-store inspection to a Shared supervisor", async () => {
    const inspection = vi.spyOn(userStores, "inspectConfiguredUserAgentStores");
    try { await createSurgeOpenClawBootWatcher({ openclawDir: "/unused/shared", releaseKey: "shared-release", log: () => {}, env: { GATEWAY_CLASS: "shared" },
      client: { claimOpenClawBoot: vi.fn().mockResolvedValue({ action: "start" }), completeOpenClawBoot: vi.fn(), completeOpenClawDoctor: vi.fn() } }).beforeStart();
      expect(inspection).not.toHaveBeenCalled();
    } finally { inspection.mockRestore(); }
  });

  it.each(["retry", "cancel"] as const)("retains failed user database admission for an explicit %s", async scenario => {
    stubUserClaim("ceckert-test");
    vi.stubEnv("POD_UID", "target-pod");
    const openclawDir = await temporaryOpenClawDir();
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const readiness = createSurgeReadinessGate(openclawDir, "target-pod");
    const request = { migrationId: "surge-admission-retry", slug: "ceckert-test", targetPodUid: "target-pod" };
    const children: FakeChild[] = [];
    const credentials = path.join(openclawDir, "synthetic-client-credentials");
    const prepareDatabases = vi.fn(async () => {
      if (prepareDatabases.mock.calls.length === 1) {
        await fs.writeFile(credentials, "rebound");
        throw new Error("Doctor interrupted after credential rebind");
      }
      expect(await fs.readFile(credentials, "utf8")).toBe("rebound");
    });
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir, podUid: request.targetPodUid, socketPath, log: () => undefined,
      readinessReleased: readiness.released,
      prepareTarget: async () => undefined, prepareDatabases,
      bootWatcher: { beforeStart: async () => undefined, healthy: async () => undefined },
      spawnOpenClaw: () => { const child = new FakeChild(); children.push(child); return child; },
      probeHealthz: healthzOf(children), healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const adapter = {
      isIsolatedGateway: () => true,
      isConfiguredUser: (slug: string) => slug === request.slug,
      configuredUserOverlayPresent: () => true,
      listLocalUserSlugs: () => [request.slug], userMountMarked: () => true,
      hasWorkspaceGitDir: () => true, hasGitRemote: () => true,
    } as unknown as UserLifecycleAdapter;
    const waitForGatewayReady = vi.fn(async () => {
      expect(await client.status()).toMatchObject({ role: "target", mode: "permitted", phase: "running", ...request });
      expect(await readiness.released()).toBe(false);
      expect(prepareDatabases).toHaveBeenCalledTimes(2);
    });
    const wiring = createIsolatedSurgeGateWiring({
      openclawDir, adapter, processGate: client, surgeReadiness: readiness, log: () => undefined,
      provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() },
      attachConfiguredUserBeforeOpenClaw: async () => request.slug,
      waitForGatewayHealthy: async () => undefined, waitForGatewayReady,
    });
    try {
      await client.hydrate(request);
      await expect(wiring.releaseSurgeReadiness(request)).rejects.toThrow("Doctor interrupted after credential rebind");
      expect(children).toHaveLength(0);
      expect(waitForGatewayReady).not.toHaveBeenCalled();
      await expect(client.status()).resolves.toEqual({ version: 1, podUid: request.targetPodUid,
        role: "target", mode: "held", phase: "held", completionStarted: true, ...request });
      expect(await readiness.released()).toBe(false);

      if (scenario === "cancel") {
        await expect(wiring.unreserveSurgeTarget(request)).resolves.toMatchObject({
          role: "normal", mode: "held", phase: "held", terminalTarget: request,
        });
        await expect(wiring.releaseSurgeReadiness(request)).rejects.toThrow("not reserved by this migration");
        expect(prepareDatabases).toHaveBeenCalledOnce();
        expect(children).toHaveLength(0);
        expect(await readiness.released()).toBe(false);
        return;
      }
      await wiring.releaseSurgeReadiness(request);
      expect(prepareDatabases).toHaveBeenCalledTimes(2);
      expect(children).toHaveLength(1);
      expect(waitForGatewayReady).toHaveBeenCalledOnce();
      expect(await readiness.released()).toBe(true);
      await expect(client.status()).resolves.toMatchObject({ role: "normal", mode: "permitted", phase: "running", terminalTarget: request });
    } finally {
      await supervisor.stop();
      vi.unstubAllEnvs();
    }
  });

  it("permits startup after the supervisor closes an idle socket during blocked setup", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const socketPath = path.join(openclawDir, "supervisor.sock");
    const closed = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(`
      const http = require("node:http");
      const { parentPort, workerData } = require("node:worker_threads");
      let socket;
      const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => res.end(JSON.stringify({
          version: 1, podUid: "target-pod", role: "normal", mode: "held", phase: "held",
        })));
      });
      server.on("connection", (connected) => { socket = connected; });
      server.listen(workerData.socketPath, () => parentPort.postMessage("ready"));
      parentPort.on("message", () => {
        socket.destroy();
        setImmediate(() => {
          Atomics.store(workerData.closed, 0, 1);
          Atomics.notify(workerData.closed, 0);
        });
      });
    `, { eval: true, workerData: { socketPath, closed } });
    try {
      await once(worker, "message");
      const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
      await client.status();
      await new Promise<void>((resolve) => setImmediate(resolve));
      worker.postMessage("expire-idle-connection");
      expect(Atomics.wait(closed, 0, 0, 5_000)).not.toBe("timed-out");

      await expect(client.permitNormal()).resolves.toMatchObject({ podUid: "target-pod" });
    } finally {
      await worker.terminate();
    }
  });

  it("refuses an unsupervised OpenClaw before preparing target state it could still be writing", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const prepareTarget = vi.fn(async () => undefined);
    const prepareDatabases = vi.fn(async () => undefined);
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "target-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => false,
      prepareTarget,
      prepareDatabases,
      spawnOpenClaw: () => new FakeChild(),
      probeHealthz: async () => true,
      healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = { migrationId: "surge-gateway-orphan", slug: "ceckert-test", targetPodUid: "target-pod" };
    try {
      await client.hydrate(request);
      await client.claimTargetCompletion(request);

      await expect(client.permit(request)).rejects.toThrow(/refusing to start a second gateway/u);
      expect(prepareTarget).not.toHaveBeenCalled();
      expect(prepareDatabases).not.toHaveBeenCalled();
    } finally {
      await supervisor.stop();
    }
  });

  it("owns a target child only after permit, prepares it after transfer, and returns it held on abort", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const prepareTarget = vi.fn(async () => undefined);
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "target-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => false,
      prepareTarget,
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      probeHealthz: healthzOf(children),
      healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await expect(client.status()).resolves.toMatchObject({ mode: "held", phase: "held" });
    await client.hydrate(request);
    await client.claimTargetCompletion(request);
    await expect(client.permit(request)).resolves.toMatchObject({
      role: "target",
      mode: "permitted",
      phase: "running",
    });
    expect(prepareTarget).toHaveBeenCalledOnce();
    expect(children).toHaveLength(1);

    await expect(client.hold(request)).resolves.toMatchObject({
      role: "target",
      mode: "held",
      phase: "cancelling",
    });
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(client.releaseTarget(request)).rejects.toThrow("does not permit this target migration");
    await expect(createSurgeReadinessGate(openclawDir, "target-pod").released()).resolves.toBe(false);
    await supervisor.stop();
  });

  it("rejects a delayed matching target hold after target release commits", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "target-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => false,
      prepareTarget: async () => undefined,
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      probeHealthz: healthzOf(children),
      healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await client.hydrate(request);
    await client.claimTargetCompletion(request);
    await client.permit(request);
    await expect(client.releaseTarget(request)).resolves.toMatchObject({
      role: "normal",
      mode: "permitted",
      terminalTarget: request,
    });
    await expect(createSurgeReadinessGate(openclawDir, "target-pod").released()).resolves.toBe(true);

    await expect(client.hold(request)).rejects.toThrow("target migration already released");
    expect(children[0]!.kill).not.toHaveBeenCalled();
    await expect(client.status()).resolves.toMatchObject({
      role: "normal",
      mode: "permitted",
      terminalTarget: request,
    });
    await supervisor.stop();
  });

  it("rolls back only the named released target and keeps it held across restart before retry", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const options = {
      openclawDir, podUid: "target-pod", socketPath,
      log: () => undefined,
      prepareTarget: async () => undefined,
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      probeHealthz: healthzOf(children), healthTimeoutMs: 100,
    };
    let supervisor = await startSurgeOpenClawSupervisor(options);
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = { migrationId: "activation-1", slug: "chris", targetPodUid: "target-pod" };
    try {
      await client.hydrate(request);
      await client.claimTargetCompletion(request);
      await client.permit(request);
      await client.releaseTarget(request);
      for (const mismatch of [
        { ...request, migrationId: "stale-activation" },
        { ...request, slug: "someone-else" },
        { ...request, targetPodUid: "old-pod" },
      ]) {
        await expect(client.reholdReleasedTarget(mismatch)).rejects.toThrow("released target does not match");
      }
      expect(children[0]!.alive).toBe(true);
      await expect(createSurgeReadinessGate(openclawDir).released()).resolves.toBe(true);

      await expect(client.reholdReleasedTarget(request)).resolves.toMatchObject({
        role: "target", mode: "held", phase: "cancelling",
      });
      expect(children[0]!.alive).toBe(false);
      await expect(createSurgeReadinessGate(openclawDir).released()).resolves.toBe(false);
      await client.finalizeTargetCancellation(request);
      await supervisor.stop();
      supervisor = await startSurgeOpenClawSupervisor(options);
      await expect(client.status()).resolves.toMatchObject({ role: "normal", mode: "held", phase: "held" });
      expect(children).toHaveLength(1);
      await expect(client.hydrate({ ...request, migrationId: "activation-2" })).resolves.toMatchObject({
        role: "target", mode: "held", migrationId: "activation-2",
      });
      await expect(client.reholdReleasedTarget(request)).rejects.toThrow("released target does not match");
    } finally {
      await supervisor.stop();
    }
  });

  it("retries one target child exit before health and reports an exit only after the retry is healthy", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const prepareTarget = vi.fn(async () => undefined);
    const onUnexpectedChildExit = vi.fn();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const bootWatcher = {
      beforeStart: vi.fn(async () => undefined),
      healthy: vi.fn(async () => undefined),
    };
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "target-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => false,
      prepareTarget,
      onUnexpectedChildExit,
      bootWatcher,
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        if (children.length === 1) {
          queueMicrotask(() => {
            child.alive = false;
            child.emit("exit", 1, null);
          });
        }
        return child;
      },
      probeHealthz: async () => children.at(-1)?.alive === true,
      healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await client.hydrate(request);
    await client.claimTargetCompletion(request);
    await expect(client.permit(request)).resolves.toMatchObject({
      role: "target",
      mode: "permitted",
      phase: "running",
    });
    expect(prepareTarget).toHaveBeenCalledTimes(2);
    expect(children).toHaveLength(2);
    expect(bootWatcher.beforeStart).toHaveBeenCalledTimes(2);
    expect(bootWatcher.healthy).toHaveBeenCalledOnce();
    expect(onUnexpectedChildExit).not.toHaveBeenCalled();

    children[1]!.alive = false;
    children[1]!.emit("exit", 1, null);
    expect(onUnexpectedChildExit).toHaveBeenCalledOnce();
    await supervisor.stop();
  });

  it("holds the target and reports the second pre-health child exit", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const prepareTarget = vi.fn(async () => undefined);
    const onUnexpectedChildExit = vi.fn();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "target-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => false,
      prepareTarget,
      onUnexpectedChildExit,
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      probeHealthz: async () => {
        const newest = children.at(-1);
        if (newest?.alive) {
          newest.alive = false;
          newest.emit("exit", 1, null);
        }
        return false;
      },
      healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await client.hydrate(request);
    await client.claimTargetCompletion(request);
    await expect(client.permit(request)).rejects.toThrow("OpenClaw exited before becoming healthy");
    expect(prepareTarget).toHaveBeenCalledTimes(2);
    expect(onUnexpectedChildExit).toHaveBeenCalledOnce();
    await expect(client.status()).resolves.toMatchObject({ mode: "held", phase: "held" });
    await supervisor.stop();
  });

  it("stops and restarts a source only through its matching durable hold", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "source-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => true,
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      probeHealthz: healthzOf(children),
      healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await vi.waitFor(() => expect(children).toHaveLength(1));
    await expect(client.hold(request)).resolves.toMatchObject({ role: "source", phase: "held" });
    await expect(client.resume(request)).resolves.toMatchObject({
      role: "normal",
      mode: "permitted",
      phase: "running",
    });
    expect(children).toHaveLength(2);
    await expect(client.hold({ ...request, migrationId: "surge-gateway-next" }))
      .resolves.toMatchObject({
        role: "source",
        mode: "held",
        phase: "held",
        migrationId: "surge-gateway-next",
      });
    await supervisor.stop();
  });

  it("answers status while a permit is still cloning and starting OpenClaw", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    let enteredPrepare = () => {};
    let releasePrepare = () => {};
    const prepareEntered = new Promise<void>((resolve) => { enteredPrepare = resolve; });
    const prepareBlocked = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "target-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => false,
      prepareTarget: async () => {
        enteredPrepare();
        await prepareBlocked;
      },
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      probeHealthz: healthzOf(children),
      healthTimeoutMs: 1_000,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await client.hydrate(request);
    await client.claimTargetCompletion(request);
    const permit = client.permit(request);
    await prepareEntered;

    await expect(client.status()).resolves.toMatchObject({ mode: "permitted" });

    releasePrepare();
    await expect(permit).resolves.toMatchObject({ phase: "running" });
    await supervisor.stop();
  });

  it("escalates to SIGKILL when OpenClaw ignores SIGTERM past the stop grace", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "source-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => true,
      spawnOpenClaw: () => {
        const child = new FakeChild(true);
        children.push(child);
        return child;
      },
      probeHealthz: healthzOf(children),
      healthTimeoutMs: 100,
      stopGraceMs: 10,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    await vi.waitFor(() => expect(children).toHaveLength(1));

    await expect(client.holdNormal()).resolves.toMatchObject({ mode: "held", phase: "held" });
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    expect(children[0]!.alive).toBe(false);
    await supervisor.stop();
  });

  it("refuses to start beside an unsupervised OpenClaw already answering healthz", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "target-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => false,
      prepareTarget: async () => undefined,
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      probeHealthz: async () => true,
      healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });

    await expect(client.permitNormal()).rejects.toThrow(/refusing to start a second gateway/);
    expect(children).toHaveLength(0);
    await expect(client.status()).resolves.toMatchObject({ role: "normal", mode: "held" });
    await supervisor.stop();
  });
});

describe("Native prelaunch boot mode", () => {
  it("holds startup when prelaunch authority changes during retained-store preparation", async () => {
    const openclawDir = await temporaryOpenClawDir(), podUid = "native-pod";
    const spawnOpenClaw = vi.fn(() => new FakeChild());
    const authority = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("authority changed"));
    await expect(startSurgeOpenClawSupervisor({ openclawDir, podUid, log: () => {},
      socketPath: path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`), prelaunchBoot: true,
      assertPrelaunchAuthority: authority, preparePrelaunch: async assertHeld => { await assertHeld(); }, spawnOpenClaw, probeHealthz: async () => false,
    })).rejects.toThrow("authority changed");
    expect(spawnOpenClaw).not.toHaveBeenCalled();
    await expect(createSurgeOpenClawProcessGate(openclawDir).read()).resolves.toMatchObject({ mode: "held", phase: "held" });
  });
  it("boots an unassigned safe runtime during verified prelaunch", async () => {
    const openclawDir = await temporaryOpenClawDir(), podUid = "native-pod";
    const readiness = createSurgeReadinessGate(openclawDir, podUid);
    await readiness.release({ targetPodUid: podUid });
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid, readinessReleased: true });
    const spawnOpenClaw = vi.fn(() => new FakeChild());
    const supervisor = await startSurgeOpenClawSupervisor({ openclawDir, podUid, log: () => {},
      socketPath: path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`), prelaunchBoot: true, preparePrelaunch: async () => {}, prepareDatabases: async () => {}, spawnOpenClaw, probeHealthz: async () => spawnOpenClaw.mock.results.at(-1)?.value.alive === true });
    try {
      await vi.waitFor(async () => expect((await supervisor.state()).phase).toBe("running"));
      expect(spawnOpenClaw).toHaveBeenCalledOnce();
      await expect(readiness.released()).resolves.toBe(true);
    } finally { await supervisor.stop(); }
  });
});

it("restarts a released target only for its currently authorized activation", async () => {
  const openclawDir = await temporaryOpenClawDir(), podUid = "native-target", children: FakeChild[] = [];
  const readiness = createSurgeReadinessGate(openclawDir, podUid), gate = createSurgeOpenClawProcessGate(openclawDir);
  await gate.ensure({ podUid, readinessReleased: false });
  const request = { podUid, migrationId: "mig-current", slug: "alice", targetPodUid: podUid };
  await gate.hydrateTarget(request); await gate.claimTargetCompletion(request); await gate.permitTarget(request);
  await gate.markRunning({ podUid, migrationId: request.migrationId }); await readiness.release({ targetPodUid: podUid });
  const supervisor = await startSurgeOpenClawSupervisor({ openclawDir, podUid, log: () => {}, activationMigrationId: request.migrationId,
    socketPath: path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`), prepareTarget: async () => {}, prepareDatabases: async () => {},
    spawnOpenClaw: () => { const child = new FakeChild(); children.push(child); return child; }, probeHealthz: healthzOf(children) });
  try { await vi.waitFor(() => expect(children).toHaveLength(1)); await expect(supervisor.state()).resolves.toMatchObject({ mode: "permitted", terminalTarget: { migrationId: request.migrationId } }); }
  finally { await supervisor.stop(); }
});

it("holds an old released target receipt when a different activation starts", async () => {
  const openclawDir = await temporaryOpenClawDir(), podUid = "native-target";
  const readiness = createSurgeReadinessGate(openclawDir, podUid), gate = createSurgeOpenClawProcessGate(openclawDir);
  await gate.ensure({ podUid, readinessReleased: false });
  const request = { podUid, migrationId: "mig-old", slug: "alice", targetPodUid: podUid };
  await gate.hydrateTarget(request); await gate.claimTargetCompletion(request); await gate.permitTarget(request);
  await gate.markRunning({ podUid, migrationId: request.migrationId }); await readiness.release({ targetPodUid: podUid });
  const spawnOpenClaw = vi.fn(() => new FakeChild());
  const supervisor = await startSurgeOpenClawSupervisor({ openclawDir, podUid, log: () => {}, activationMigrationId: "mig-new",
    socketPath: path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`), spawnOpenClaw, probeHealthz: async () => false });
  try {
    await expect(supervisor.state()).resolves.toMatchObject({ role: "normal", mode: "held", terminalTarget: { migrationId: "mig-old" } });
    expect(spawnOpenClaw).not.toHaveBeenCalled();
    await expect(gate.hydrateTarget({ ...request, migrationId: "mig-new" })).resolves.toMatchObject({ role: "target", mode: "held" });
  } finally { await supervisor.stop(); }
});

it("preserves a held source fence during a returning lease restart", async () => {
  const openclawDir = await temporaryOpenClawDir(), podUid = "native-source";
  const gate = createSurgeOpenClawProcessGate(openclawDir), readiness = createSurgeReadinessGate(openclawDir, podUid);
  await gate.ensure({ podUid, readinessReleased: true });
  const request = { podUid, migrationId: "return-1", slug: "alice", targetPodUid: "shared-target" };
  await gate.hold(request); await gate.markHeld(request); await readiness.release({ targetPodUid: podUid });
  const spawnOpenClaw = vi.fn(() => new FakeChild());
  const supervisor = await startSurgeOpenClawSupervisor({ openclawDir, podUid, log: () => {},
    socketPath: path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`), spawnOpenClaw });
  try {
    await expect(supervisor.state()).resolves.toMatchObject({ role: "source", mode: "held", migrationId: request.migrationId });
    expect(spawnOpenClaw).not.toHaveBeenCalled();
  } finally { await supervisor.stop(); }
});


describe("held user store migration", () => {
  it("stops the source and serializes repair ahead of a concurrent permit", async () => {
    const openclawDir = await temporaryOpenClawDir(), children: FakeChild[] = [];
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const migrateUserStores = vi.fn(async (assertHeld: () => Promise<void>) => {
      await assertHeld(); expect(children[0]!.alive).toBe(false); entered(); await blocked; await assertHeld();
    });
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({ openclawDir, podUid: "source-pod", socketPath,
      log: () => {}, readinessReleased: async () => true, prepareTarget: async () => {}, prepareDatabases: async () => {},
      migrateUserStores, spawnOpenClaw: () => { const child = new FakeChild(); children.push(child); return child; },
      probeHealthz: healthzOf(children),
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    try {
      await vi.waitFor(() => expect(children).toHaveLength(1));
      const repair = client.migrateUserStores("source-pod");
      await started;
      const permit = client.permitNormal();
      await expect(client.status()).resolves.toMatchObject({ mode: "held", phase: "held" });
      expect(children).toHaveLength(1);
      release(); await repair; await permit;
      expect(children).toHaveLength(2);
    } finally { release(); await supervisor.stop(); }
  });

  it("rejects another allocation or a migration-owned target before running repair", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const migrateUserStores = vi.fn(async () => {});
    const supervisor = await startSurgeOpenClawSupervisor({ openclawDir, podUid: "target-pod", socketPath,
      log: () => {}, readinessReleased: async () => false, migrateUserStores, probeHealthz: async () => false,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    try {
      await expect(client.migrateUserStores("other-pod")).rejects.toThrow("allocation");
      await expect(client.migrateUserStores("target-pod")).rejects.toThrow("retained source");
      await client.hold({ migrationId: "migration", slug: "alice", targetPodUid: "target-pod" });
      await expect(client.migrateUserStores("target-pod")).rejects.toThrow("normal");
      expect(migrateUserStores).not.toHaveBeenCalled();
    } finally { await supervisor.stop(); }
  });

  it("keeps the source held after repair failure", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid: "source-pod", readinessReleased: true });
    await gate.holdNormal({ podUid: "source-pod" });
    await gate.markHeld({ podUid: "source-pod" });
    const supervisor = await startSurgeOpenClawSupervisor({ openclawDir, podUid: "source-pod", socketPath,
      log: () => {}, readinessReleased: async () => true, probeHealthz: async () => false,
      migrateUserStores: async () => { throw new Error("retained workboard"); },
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    try {
      await expect(client.migrateUserStores("source-pod")).rejects.toThrow("retained workboard");
      await expect(client.status()).resolves.toMatchObject({ role: "normal", mode: "held", phase: "held" });
    } finally { await supervisor.stop(); }
  });
});


it("keeps initial user startup held when store migration was deferred", async () => {
  const openclawDir = await temporaryOpenClawDir();
  const configPath = path.join(openclawDir, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify({ database: { engine: "sqlite", families: { state: { engine: "postgres" }, agent: { engine: "postgres" } } } }));
  vi.stubEnv("GATEWAY_CLASS", "isolated"); vi.stubEnv("OPENCLAW_STATE_DIR", openclawDir); vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  const log = vi.fn(), spawnOpenClaw = vi.fn(() => new FakeChild());
  const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
  const supervisor = await startSurgeOpenClawSupervisor({ openclawDir, podUid: "source-pod", socketPath,
    log, readinessReleased: async () => true, prepareTarget: async () => {}, spawnOpenClaw, probeHealthz: async () => false,
  });
  try {
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("before startup")));
    await expect(supervisor.state()).resolves.toMatchObject({ mode: "held", phase: "held" });
    expect(spawnOpenClaw).not.toHaveBeenCalled();
  } finally { await supervisor.stop(); vi.unstubAllEnvs(); }
});

it("does not permit startup while a failed durable repair is pending", async () => {
  const openclawDir = await temporaryOpenClawDir();
  await fs.writeFile(path.join(openclawDir, ".builder-store-migration.json"), JSON.stringify({ gatewayId: "source", slug: "alice" }));
  const spawnOpenClaw = vi.fn(() => new FakeChild());
  const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
  const supervisor = await startSurgeOpenClawSupervisor({ openclawDir, podUid: "source-pod", socketPath,
    log: () => {}, readinessReleased: async () => false, prepareTarget: async () => {}, prepareDatabases: async () => {}, spawnOpenClaw, probeHealthz: async () => false,
  });
  try {
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    await expect(client.permitNormal()).rejects.toThrow("migration is incomplete");
    expect(spawnOpenClaw).not.toHaveBeenCalled();
    await expect(client.status()).resolves.toMatchObject({ mode: "held", phase: "held" });
  } finally { await supervisor.stop(); }
});


it("stops a timed-out normal boot before spending its one repair attempt", async () => {
  const openclawDir = await temporaryOpenClawDir(), children: FakeChild[] = [];
  const beforeStart = vi.fn(async () => { expect(children.every(child => !child.alive)).toBe(true); });
  const supervisor = await startSurgeOpenClawSupervisor({
    openclawDir, podUid: "timeout-target", socketPath: path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`), log: () => {},
    readinessReleased: async () => false, prepareTarget: async () => {}, prepareDatabases: async () => {}, healthTimeoutMs: 5,
    bootWatcher: { beforeStart, healthy: vi.fn() },
    spawnOpenClaw: () => { const child = new FakeChild(); children.push(child); return child; },
    probeHealthz: async () => children.length === 2 && children[1]!.alive,
  });
  try {
    await createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath: supervisor.socketPath }).permitNormal();
    expect(beforeStart).toHaveBeenCalledTimes(2);
    expect(children[0]!.alive).toBe(false);
    expect(children[1]!.alive).toBe(true);
  } finally { await supervisor.stop(); }
});
