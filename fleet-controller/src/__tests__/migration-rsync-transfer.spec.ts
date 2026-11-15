import http from "node:http";
import { MIGRATION_IMPORT_FINISH_TIMEOUT_MS } from "@octogee/shared/types/fleet-controller";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import type {SourceTransferExecution} from "@octogee/shared/types/glm";
import { describe, expect, it, vi } from "vitest";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { createJournalFixtureStore, journalRowsIn } from "@octogee/core/testing/journal-store";
import { GLM_MIGRATION_TRANSFER_TASKS_COLLECTION } from "@octogee/shared/types/glm";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";
import { readTransferAttemptForCleanup } from "../lib/migration-transfer-lease.js";
import {
  createRsyncMigrationTransfer,
  migrationTransferTaskId,
  resolveMigrationRecoveryUrl,
  type CommandRunner,
} from "../lib/migration-rsync-transfer";

type Store = Record<string, Record<string, unknown>>;

const SOURCE_POD_IP = ["10", "1", "0", "10"].join(".");
const TARGET_POD_IP = ["10", "1", "0", "20"].join(".");
const IPV6_TARGET_POD_IP = "fd00::20";
const FLEET_CONTROLLER_PORT = "3003";

describe("migration recovery transport", () => {
  it("reaches a held target directly even while its Service excludes it", async () => {
    const runCommand: CommandRunner = async (command, args) => {
      expect(command).toBe("kubectl");
      expect(args).toEqual(["-n", "octogee-test", "get", "pods", "-l", "app=octogee-gateway,gateway-instance=alice-s-target", "-o", "json"]);
      return { code: 0, stderr: "", stdout: await runningPod("target", false, IPV6_TARGET_POD_IP).text() };
    };
    await expect(resolveMigrationRecoveryUrl({ namespace: "octogee-test", gatewayId: "alice-s-target", port: FLEET_CONTROLLER_PORT,
      runCommand, resolveGatewayVm: async () => null,
    })).resolves.toBe(`http://[${IPV6_TARGET_POD_IP}]:3003`);
  });

  it("refuses an ambiguous set of held target pods", async () => {
    const pod = { metadata: { name: "target" }, status: { phase: "Running", podIP: TARGET_POD_IP } };
    await expect(resolveMigrationRecoveryUrl({ namespace: "octogee-test", gatewayId: "alice-s-target", port: FLEET_CONTROLLER_PORT,
      runCommand: async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ items: [pod, pod] }) }), resolveGatewayVm: async () => null,
    })).rejects.toThrow("expected exactly one ready pod");
  });

  it("uses a native target's recorded address without selecting cluster pods", async () => {
    await expect(resolveMigrationRecoveryUrl({ namespace: "octogee-test", gatewayId: "alice-m-target", port: FLEET_CONTROLLER_PORT,
      runCommand: async () => { throw new Error("must not select cluster pods"); },
      resolveGatewayVm: async () => ({ instanceName: "native-target", internalIp: "172.20.0.9" }),
    })).resolves.toBe("http://172.20.0.9:3003");
  });
});

function makeStore(tasks: Store): PlatformStateStore {
  const taskId = (path: string) => {
    const [collection, id, ...rest] = path.split("/");
    if (collection !== GLM_MIGRATION_TRANSFER_TASKS_COLLECTION || id === undefined || rest.length > 0) throw new Error(`unexpected document ${path}`);
    return id;
  };
  return createJournalFixtureStore(journalRowsIn({}), { documents: {
    get: (path) => tasks[taskId(path)],
    set: (path, row) => { tasks[taskId(path)] = row; },
    delete: (path) => { delete tasks[taskId(path)]; },
    children: (collectionPath) => { throw new Error(`unexpected collection listing ${collectionPath}`); },
    group: (collectionId) => { throw new Error(`unexpected collection group ${collectionId}`); },
  } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function runningPod(name: string, ready = true, podIP?: string): Response {
  return jsonResponse({
    items: [
      {
        metadata: { name, uid: name === "gw-to-pod" ? "target-uid" : "source-uid" },
        status: {
          phase: "Running",
          podIP: podIP ?? (name === "gw-from-pod" ? SOURCE_POD_IP : TARGET_POD_IP),
          conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
        },
      },
    ],
  });
}

function readyPod(name: string): Response {
  return runningPod(name);
}

const TARGET_CERTIFICATE_PEM = "-----BEGIN CERTIFICATE-----\nTUlHUkFUSU9O\n-----END CERTIFICATE-----\n";

function makeFetch(
  calls: string[],
  targetPodIP = TARGET_POD_IP,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) return jsonResponse({ status: "ready", rsyncAttemptFencing: true });
    if (url.endsWith("/surge-ready")) return jsonResponse({ ready: false }, 503);
    calls.push(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as { migrationId: string; slug: string };
    if (url.includes("/prepare-rsync-import/")) {
      expect(body).toMatchObject({
        transferUser: "migration",
        sourcePodIp: SOURCE_POD_IP,
      });
      return jsonResponse({
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
        host: "0.0.0.0",
        port: 30873,
        module: "state",
        certificatePem: TARGET_CERTIFICATE_PEM,
      });
    }
    if (url.includes("/push-rsync-state/")) {
      expect(body).toMatchObject({
        targetHost: targetPodIP,
        targetPort: 30873,
        targetCertificatePem: TARGET_CERTIFICATE_PEM,
        transferUser: "migration",
      });
      return jsonResponse({ migrationId: body.migrationId, slug: body.slug, imported: true });
    }
    if (url.includes("/finish-rsync-import/")) {
      return jsonResponse({ migrationId: body.migrationId, slug: body.slug, imported: true });
    }
    if (url.includes("/abort-rsync-import/")) {
      return jsonResponse({ migrationId: body.migrationId, slug: body.slug, imported: true });
    }
    return new Response("unexpected", { status: 404 });
  }) as typeof fetch;
}

function makeCommandRunner(calls: Array<{ command: string; args: string[] }>): CommandRunner {
  return async (command, args) => {
    calls.push({ command, args });
    if (command === "kubectl") {
      const selector = args[args.indexOf("-l") + 1] ?? "";
      if (selector.includes("gateway-instance=gw-from")) {
        return { stdout: await readyPod("gw-from-pod").text(), stderr: "", code: 0 };
      }
      if (selector.includes("gateway-instance=gw-to")) {
        return { stdout: await readyPod("gw-to-pod").text(), stderr: "", code: 0 };
      }
    }
    return { stdout: "", stderr: "", code: 0 };
  };
}

describe("migrationTransferTaskId", () => {
  it("is deterministic per migration phase and Firestore-doc safe", () => {
    expect(migrationTransferTaskId({ migrationId: "mig/1", mode: "final" })).toBe(
      "mig_1__final",
    );
  });
});

describe("createRsyncMigrationTransfer", () => {
  const evictedTask = () => ({
    kind: "gateway-rsync-transfer", migrationId: "evicted", slug: "alice", mode: "final",
    sourceGatewayId: "gw-from", targetGatewayId: "gw-to", status: "running", attempt: 1,
    leaseOwner: "old-process", leasePod: { name: "old-controller", uid: "old-pod-uid" },
    attemptId: "old-attempt", leaseExpiresAt: 4_000_000, createdAt: 1, updatedAt: 1, startedAt: 1,
  });

  function evictionFixture(observe: () => Promise<{ stdout: string; stderr: string; code: number }>, supportsFencing = true) {
    const store: Store = { evicted__final: evictedTask() };
    const calls: string[] = [];
    const fallback = makeCommandRunner([]);
    const runCommand: CommandRunner = async (command, args, options) => {
      if (args.includes("old-controller")) return observe();
      if (args.includes("new-controller")) return { stdout: JSON.stringify({ metadata: { name: "new-controller", uid: "new-pod-uid" }, status: { containerStatuses: [{ name: "glm-controller", restartCount: 0 }] } }), stderr: "", code: 0 };
      return fallback(command, args, options);
    };
    const transfer = createRsyncMigrationTransfer({
      store: makeStore(store), namespace: "octogee-test", privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT, resolveGatewayUrl: id => `http://${id}`,
      fetch: (async (url, init) => !supportsFencing && String(url).endsWith("/health") ? jsonResponse({ status: "ready" }) : makeFetch(calls)(url, init)) as typeof globalThis.fetch,
      runCommand, now: () => 10_000,
      controllerPod: { name: "new-controller", uid: "new-pod-uid" },
    });
    const run = () => transfer({ migrationId: "evicted", fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode: "final" });
    return { store, calls, run };
  }

  it.each(["", JSON.stringify({ metadata: { name: "old-controller", uid: "replacement-uid" } })])("recovers an unexpired transfer when its exact controller pod is gone (%s)", async stdout => {
    const h = evictionFixture(async () => ({ stdout, stderr: "", code: 0 }));
    await expect(h.run()).resolves.toMatchObject({ imported: true });
    expect(h.store.evicted__final).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(h.calls.some(url => url.includes("/finish-rsync-import/"))).toBe(true);
  });

  it("does not prepare a reclaimed final import after the target released the same migration", async () => {
    const store: Store = { evicted__final: evictedTask() };
    const calls: string[] = [];
    const fetch = (async (url, init) => {
      if (String(url).endsWith("/surge-ready")) return jsonResponse({ terminalTarget: { migrationId: "evicted", slug: "alice", targetPodUid: "target-uid", completionStarted: true } });
      return makeFetch(calls)(url, init);
    }) as typeof globalThis.fetch;
    const fallback = makeCommandRunner([]);
    const runCommand: CommandRunner = async (command, args, options) => args.includes("old-controller")
      ? { stdout: "", stderr: "", code: 0 } : args.includes("new-controller")
        ? { stdout: JSON.stringify({ metadata: { name: "new-controller", uid: "new-pod-uid" }, status: { containerStatuses: [{ name: "glm-controller", restartCount: 0 }] } }), stderr: "", code: 0 }
        : fallback(command, args, options);
    const transfer = createRsyncMigrationTransfer({ store: makeStore(store), namespace: "test", privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT, resolveGatewayUrl: id => `http://${id}`, fetch, runCommand, now: () => 10_000,
      controllerPod: { name: "new-controller", uid: "new-pod-uid" } });
    await expect(transfer({ migrationId: "evicted", fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode: "final" }))
      .rejects.toThrow("target import already released for migration evicted on gw-to");
    expect(calls.some(url => url.includes("/prepare-rsync-import/"))).toBe(false);
    expect(calls.some(url => url.includes("/abort-rsync-import/"))).toBe(false);
  });

  it.each([
    { terminalTarget: { migrationId: "other", slug: "alice", targetPodUid: "target-uid" } },
    { terminalTarget: { migrationId: "evicted", slug: "other", targetPodUid: "target-uid" } },
    { terminalTarget: { migrationId: "evicted", slug: "alice", targetPodUid: "" } },
    { terminalTarget: { migrationId: "evicted", slug: "alice", targetPodUid: "old-target-uid" } },
  ])("fences a reclaimed transfer when terminal target identity differs: %j", async state => {
    const calls: string[] = [];
    const store: Store = { evicted__final: evictedTask() };
    const fallback = makeCommandRunner([]);
    const runCommand: CommandRunner = async (command, args, options) => args.includes("old-controller")
      ? { stdout: "", stderr: "", code: 0 } : args.includes("new-controller")
        ? { stdout: JSON.stringify({ metadata: { name: "new-controller", uid: "new-pod-uid" }, status: { containerStatuses: [{ name: "glm-controller", restartCount: 0 }] } }), stderr: "", code: 0 }
        : fallback(command, args, options);
    const transfer = createRsyncMigrationTransfer({ store: makeStore(store), namespace: "test", privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT, resolveGatewayUrl: id => `http://${id}`,
      fetch: (async (url, init) => String(url).endsWith("/surge-ready") ? jsonResponse(state, 503) : makeFetch(calls)(url, init)) as typeof globalThis.fetch,
      runCommand, now: () => 10_000, controllerPod: { name: "new-controller", uid: "new-pod-uid" } });
    await expect(transfer({ migrationId: "evicted", fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode: "final" }))
      .rejects.toThrow("terminal identity does not match");
    expect(calls).toEqual([]);
  });

  it.each([
    ["g4", "123", 200, false, "target import already released"],
    ["g4", "123", 503, true, "target import already released"],
    ["g4", "999", 200, false, "terminal identity does not match"],
    ["g3", "999", 503, true, "terminal identity does not match"],
    ["g5", "123", 503, true, "terminal identity does not match"],
    ["g3", "123", 503, false, "terminal identity does not match"],
    ["g3", "123", 200, false, null],
    ["g3", "123", 503, true, null],
  ])("checks release receipt %s on VM %s (HTTP %s, held=%s) when reclaiming g4", async (generation, vmId, status, processHeld, error) => {
    const migrationId = "mig-builder-activate-gw-to-g4";
    const store: Store = { [`${migrationId}__final`]: { ...evictedTask(), migrationId } };
    const calls: string[] = [];
    const fallback = makeCommandRunner([]);
    const runCommand: CommandRunner = async (command, args, options) => args.includes("old-controller")
      ? { stdout: "", stderr: "", code: 0 } : args.includes("new-controller")
        ? { stdout: JSON.stringify({ metadata: { name: "new-controller", uid: "new-pod-uid" }, status: { containerStatuses: [{ name: "glm-controller", restartCount: 0 }] } }), stderr: "", code: 0 }
        : fallback(command, args, options);
    const transfer = createRsyncMigrationTransfer({ store: makeStore(store), namespace: "test", privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT, resolveGatewayUrl: id => `http://${id}`,
      resolveGatewayVm: async id => id === "gw-to" ? { instanceName: "vm", internalIp: "172.20.0.9", instanceId: "123" } : null,
      fetch: (async (url, init) => {
        if (!String(url).endsWith("/surge-ready")) return makeFetch(calls, "172.20.0.9")(url, init);
        if (calls.some(call => call.includes("/finish-rsync-import/"))) return jsonResponse({ ready: true });
        return jsonResponse({ terminalTarget: {
          migrationId: `mig-builder-activate-gw-to-${generation}`, slug: "alice",
          targetPodUid: `octogee-gateway-gw-to-vm-${vmId}`, processHeld,
        } }, status);
      }) as typeof globalThis.fetch,
      runCommand, now: () => 10_000, controllerPod: { name: "new-controller", uid: "new-pod-uid" } });
    const result = transfer({ migrationId, fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode: "final" });
    if (error) {
      await expect(result).rejects.toThrow(error);
      expect(calls).toEqual([]);
    } else {
      await expect(result).resolves.toMatchObject({ imported: true });
      expect(calls.some(url => url.includes("/finish-rsync-import/"))).toBe(true);
    }
  });

  it.each([{}, { deletionTimestamp: "2026-11-02T03:05:34Z" }])("preserves a transfer whose owner pod still exists, including termination (%j)", async metadata => {
    const h = evictionFixture(async () => ({ stdout: JSON.stringify({ metadata: { name: "old-controller", uid: "old-pod-uid", ...metadata } }), stderr: "", code: 0 }));
    await expect(h.run()).rejects.toThrow("already running");
    expect(h.store.evicted__final).toEqual(evictedTask());
    expect(h.calls).toEqual([]);
  });

  it("does not reclaim an expired transfer while its controller pod still exists", async () => {
    const h = evictionFixture(async () => ({ stdout: JSON.stringify({ metadata: { name: "old-controller", uid: "old-pod-uid" } }), stderr: "", code: 0 }));
    h.store.evicted__final.leaseExpiresAt = 1;
    await expect(h.run()).rejects.toThrow("already running");
    expect(h.store.evicted__final.attempt).toBe(1);
    expect(h.calls).toEqual([]);
  });

  it.each([0, 1])("only reclaims a same-pod transfer after its controller container restarts (restart count %i)", async restartCount => {
    const h = evictionFixture(async () => ({ stdout: JSON.stringify({ metadata: { name: "old-controller", uid: "old-pod-uid" },
      status: { containerStatuses: [{ name: "glm-controller", restartCount }] } }), stderr: "", code: 0 }));
    h.store.evicted__final.leaseRestartCount = 0;
    if (restartCount === 0) await expect(h.run()).rejects.toThrow("already running");
    else await expect(h.run()).resolves.toMatchObject({ imported: true });
  });

  it("fences expired running transfers with no owner identity", async () => {
    const h = evictionFixture(async () => ({ stdout: "", stderr: "", code: 0 }));
    delete h.store.evicted__final.leasePod;
    h.store.evicted__final.leaseExpiresAt = 1;
    await expect(h.run()).rejects.toThrow("owner identity unavailable");
    await expect(readTransferAttemptForCleanup({ store: makeStore(h.store), now: () => 10_000, namespace: "test", runCommand: makeCommandRunner([]) },
      { migrationId: "evicted", slug: "alice", gatewayId: "gw-to", mode: "final" })).rejects.toThrow("owner may still be running");
    expect(h.calls).toEqual([]);
  });

  it("refuses cleanup of an expired transfer while its controller pod still exists", async () => {
    const store: Store = { evicted__final: { ...evictedTask(), leaseExpiresAt: 1 } };
    const runCommand = vi.fn(async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ metadata: evictedTask().leasePod }) }));
    await expect(readTransferAttemptForCleanup({ store: makeStore(store), now: () => 10_000, namespace: "test", runCommand },
      { migrationId: "evicted", slug: "alice", gatewayId: "gw-to", mode: "final" })).rejects.toThrow("owner may still be running");
  });

  it.each([{ stdout: "", stderr: "API unavailable", code: 1 }, { stdout: "{}", stderr: "", code: 0 }])("fails closed when controller absence cannot be established (%j)", async result => {
    const h = evictionFixture(async () => result);
    await expect(h.run()).rejects.toThrow(/controller pod|owner pod/);
    expect(h.store.evicted__final).toEqual(evictedTask());
    expect(h.calls).toEqual([]);
  });

  it.each(["running", "succeeded", "failed"])("rechecks the lease after observing the owner pod even if a competing claim is %s", async status => {
    const h = evictionFixture(async () => {
      h.store.evicted__final = { ...evictedTask(), status, attempt: 2, attemptId: "competing-attempt" };
      if (status !== "running") delete h.store.evicted__final.leaseExpiresAt;
      return { stdout: "", stderr: "", code: 0 };
    });
    await expect(h.run()).rejects.toThrow(/changed|already running/);
    expect(h.store.evicted__final.attemptId).toBe("competing-attempt");
    expect(h.calls).toEqual([]);
  });

  it.each(["gone", "present", "changed", "failed", "wrong-target", "untracked"])("resolves recovery cleanup ownership only for the abandoned attempt: %s", async owner => {
    const store: Store = owner === "untracked" ? {} : { evicted__final: evictedTask() };
    if (owner === "failed") store.evicted__final.status = "failed";
    if (owner === "wrong-target") store.evicted__final.targetGatewayId = "another-target";
    const runCommand = vi.fn(async () => {
      if (owner === "changed") store.evicted__final = { ...evictedTask(), attemptId: "replacement" };
      return { code: 0, stderr: "", stdout: owner === "present" ? JSON.stringify({ metadata: evictedTask().leasePod }) : "" };
    });
    const result = readTransferAttemptForCleanup({ store: makeStore(store), now: () => 10_000, namespace: "test", runCommand },
      { migrationId: "evicted", slug: "alice", gatewayId: "gw-to", mode: "final" });
    if (["present", "changed", "wrong-target"].includes(owner)) await expect(result).rejects.toThrow(/owner|claim|identity/);
    else await expect(result).resolves.toBe(owner === "untracked" ? undefined : "old-attempt");
    if (["failed", "untracked", "wrong-target"].includes(owner)) expect(runCommand).not.toHaveBeenCalled();
  });

  it.each(["completion", "failure"])("does not overwrite or abort a newer attempt when an old %s arrives", async outcome => {
    const store: Store = {};
    const calls: string[] = [];
    const baseFetch = makeFetch(calls);
    const fetch = (async (url, init) => {
      if (String(url).includes("/finish-rsync-import/")) {
        store.evicted__final = { ...store.evicted__final, attempt: 2, attemptId: "newer-attempt", leaseOwner: "newer-worker" };
        if (outcome === "failure") throw new Error("old request failed");
      }
      return baseFetch(url, init);
    }) as typeof globalThis.fetch;
    const transfer = createRsyncMigrationTransfer({ store: makeStore(store), namespace: "octogee-test", privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT, resolveGatewayUrl: id => `http://${id}`, fetch, runCommand: makeCommandRunner([]) });
    await expect(transfer({ migrationId: "evicted", fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode: "final" })).rejects.toThrow(/ownership|claim|attempt/);
    expect(store.evicted__final).toMatchObject({ status: "running", attemptId: "newer-attempt", leaseOwner: "newer-worker" });
    expect(calls.some(url => url.includes("/abort-rsync-import/"))).toBe(false);
  });

  it("does not reclaim, prepare or abort an import on a target without attempt fencing", async () => {
    const h = evictionFixture(async () => ({ stdout: "", stderr: "", code: 0 }), false);
    await expect(h.run()).rejects.toThrow("does not support fenced transfer attempts");
    expect(h.store.evicted__final).toEqual(evictedTask());
    expect(h.calls).toEqual([]);
  });

  it.each([false, true])("binds every target mutation to the stored attempt and pod (failed=%s)", async failed => {
    const store: Store = {};
    const bodies: Array<Record<string, unknown>> = [];
    let clock = 100;
    const reportImport = vi.fn(async () => undefined);
    const baseFetch = makeFetch([]);
    const fetch = (async (url, init) => {
      if (init?.method === "POST" && !String(url).includes("/push-rsync-state/")) {
        const body = JSON.parse(String(init.body));
        expect(store.binding__final.leasePod).toEqual({ name: "current-controller", uid: "current-uid" });
        expect(body.transferAttemptId).toBe(store.binding__final.attemptId);
        bodies.push(body);
        if (String(url).includes("/finish-rsync-import/")) {
          expect(reportImport).toHaveBeenCalledExactlyOnceWith("running", 100);
          clock += 70;
          if (failed) throw new Error("target failed");
        }
      }
      return baseFetch(url, init);
    }) as typeof globalThis.fetch;
    const transfer = createRsyncMigrationTransfer({ store: makeStore(store), namespace: "octogee-test", privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT, resolveGatewayUrl: id => `http://${id}`, fetch, runCommand: async (command, args, options) =>
        args.includes("current-controller") ? { stdout: JSON.stringify({ metadata: { name: "current-controller", uid: "current-uid" }, status: { containerStatuses: [{ name: "glm-controller", restartCount: 0 }] } }), stderr: "", code: 0 }
          : makeCommandRunner([])(command, args, options),
      controllerPod: { name: "current-controller", uid: "current-uid" }, now: () => clock });
    const result = transfer({ migrationId: "binding", fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode: "final", reportImport });
    if (failed) await expect(result).rejects.toThrow("target failed");
    else await result;
    expect(bodies.map(body => body.rpcPhase)).toEqual(failed ? ["prepare-rsync-import", "finish-rsync-import", "abort-rsync-import"] : ["prepare-rsync-import", "finish-rsync-import"]);
    expect(reportImport.mock.calls).toEqual([["running", 100], [failed ? "failed" : "done", 170]]);
  });

  it.each(["keys", "pre", "final"] as const)("prepares ownership after detach and before adoption only for final import (%s)", async mode => {
    const calls: string[] = [];
    const prepareAgentStores = vi.fn(async (gatewayId: string, slug: string) => {
      expect({ gatewayId, slug }).toEqual({ gatewayId: "gw-to", slug: "alice" });
      expect(calls.at(-1)).toContain("/push-rsync-state/");
      expect(calls.some(url => url.includes("/finish-rsync-import/"))).toBe(false);
    });
    const transfer = createRsyncMigrationTransfer({ store: makeStore({}), namespace: "octogee-test", privateKey: FLEET_KEY_PAIR.privateKey, fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: id => `http://${id}`, runCommand: makeCommandRunner([]), fetch: makeFetch(calls), prepareAgentStores });
    await transfer({ migrationId: "ownership-1", fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode });
    expect(prepareAgentStores).toHaveBeenCalledTimes(mode === "final" ? 1 : 0);
  });

  it("aborts the target without adopting when ownership transfer fails", async () => {
    const calls: string[] = [];
    const transfer = createRsyncMigrationTransfer({ store: makeStore({}), namespace: "octogee-test", privateKey: FLEET_KEY_PAIR.privateKey, fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: id => `http://${id}`, runCommand: makeCommandRunner([]), fetch: makeFetch(calls),
      prepareAgentStores: async () => { throw new Error("ownership failed"); } });
    await expect(transfer({ migrationId: "ownership-1", fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode: "final" })).rejects.toThrow("ownership failed");
    expect(calls.some(url => url.includes("/finish-rsync-import/"))).toBe(false);
    expect(calls.at(-1)).toContain("/abort-rsync-import/");
  });

  it("uses a private dispatcher to outlast the production fetch header deadline", async () => {
    const original = getGlobalDispatcher();
    const shortHeaders = new Agent({ headersTimeout: 10 });
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        const reply = () => {
          res.setHeader("content-type", "application/json");
          if (req.url === "/health") {
            res.end(JSON.stringify({ rsyncAttemptFencing: true }));
            return;
          }
          res.end(JSON.stringify(req.url!.includes("prepare-rsync-import")
            ? { ...body, port: 30873, certificatePem: TARGET_CERTIFICATE_PEM }
            : { migrationId: body.migrationId, slug: body.slug, imported: true }));
        };
        if (req.url === "/slow" || req.url!.includes("finish-rsync-import")) setTimeout(reply, 1_500);
        else reply();
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      setGlobalDispatcher(shortHeaders);
      await expect(globalThis.fetch(base + "/slow")).rejects.toThrow("fetch failed");
      const runner = makeCommandRunner([]);
      const transfer = createRsyncMigrationTransfer({ store: makeStore({}), namespace: "octogee-test", privateKey: FLEET_KEY_PAIR.privateKey,
        fleetControllerPort: String(port), resolveGatewayUrl: () => base,
        runCommand: async (...args) => { const result = await runner(...args); return { ...result, stdout: result.stdout.replaceAll(SOURCE_POD_IP, "127.0.0.1").replaceAll(TARGET_POD_IP, "127.0.0.1") }; } });
      await expect(transfer({ migrationId: "production-dispatcher", fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode: "final" })).resolves.toMatchObject({ imported: true });
      expect(getGlobalDispatcher()).toBe(shortHeaders);
    } finally {
      setGlobalDispatcher(original);
      await shortHeaders.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 10_000);

  it("keeps the cold user finish request and transfer claim alive beyond five minutes", async () => {
    vi.useFakeTimers();
    const store: Store = {};
    const baseFetch = makeFetch([]);
    let ready!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    let finish!: () => void;
    let signal!: AbortSignal;
    const fetch = (async (url, init) => {
      if (!String(url).includes("/finish-rsync-import/")) return baseFetch(url, init);
      signal = init!.signal!;
      ready();
      await new Promise<void>((resolve, reject) => {
        finish = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return baseFetch(url, init);
    }) as typeof globalThis.fetch;
    try {
      const transfer = createRsyncMigrationTransfer({
        store: makeStore(store), namespace: "octogee-test", privateKey: FLEET_KEY_PAIR.privateKey,
        fleetControllerPort: FLEET_CONTROLLER_PORT, resolveGatewayUrl: id => `http://${id}`,
        fetch, runCommand: makeCommandRunner([]), now: () => Date.now(),
      });
      const completion = transfer({ migrationId: "slow-start", fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode: "final" });
      await entered;
      expect(signal).toBeInstanceOf(AbortSignal);
      await vi.advanceTimersByTimeAsync(600_001);
      expect(signal.aborted).toBe(false);
      expect(store["slow-start__final"].leaseExpiresAt).toBeGreaterThan(Date.now());
      finish();
      await expect(completion).resolves.toMatchObject({ imported: true });
      expect(store["slow-start__final"].status).toBe("succeeded");
    } finally { vi.useRealTimers(); }
  });



  it("retains transfer ownership through bounded failure cleanup after slow control phases", async () => {
    vi.useFakeTimers();
    const store: Store = {};
    const baseFetch = makeFetch([]);
    const fetch = (async (url, init) => {
      const finish = String(url).includes("/finish-rsync-import/");
      await vi.advanceTimersByTimeAsync(finish ? 1_529_999 : 329_999);
      expect(store["cleanup-budget__final"].leaseExpiresAt).toBeGreaterThan(Date.now());
      if (finish) throw new Error("finish failed before deadline");
      return baseFetch(url, init);
    }) as typeof globalThis.fetch;
    try {
      const transfer = createRsyncMigrationTransfer({ store: makeStore(store), namespace: "octogee-test", privateKey: FLEET_KEY_PAIR.privateKey,
        fleetControllerPort: FLEET_CONTROLLER_PORT, resolveGatewayUrl: id => `http://${id}`, fetch, runCommand: makeCommandRunner([]), now: () => Date.now() });
      await expect(transfer({ migrationId: "cleanup-budget", fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode: "final" })).rejects.toThrow("finish failed before deadline");
      expect(store["cleanup-budget__final"].status).toBe("failed");
    } finally { vi.useRealTimers(); }
  });

  it.each(["headers", "body"] as const)("aborts a stalled finish %s within the explicit import budget", async (phase) => {
    vi.useFakeTimers();
    const store: Store = {};
    const baseFetch = makeFetch([]);
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const fetch = (async (url, init) => {
      if (!String(url).includes("/finish-rsync-import/")) return baseFetch(url, init);
      const stall = () => new Promise<never>((_, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        entered();
      });
      if (phase === "headers") return stall();
      return { ok: true, json: stall } as unknown as Response;
    }) as typeof globalThis.fetch;
    try {
      const transfer = createRsyncMigrationTransfer({ store: makeStore(store), namespace: "octogee-test", privateKey: FLEET_KEY_PAIR.privateKey,
        fleetControllerPort: FLEET_CONTROLLER_PORT, resolveGatewayUrl: id => `http://${id}`, fetch, runCommand: makeCommandRunner([]) });
      const completion = transfer({ migrationId: "stalled", fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode: "final" });
      const rejection = expect(completion).rejects.toThrow(`timed out after ${MIGRATION_IMPORT_FINISH_TIMEOUT_MS}ms`);
      await waiting;
      await vi.advanceTimersByTimeAsync(MIGRATION_IMPORT_FINISH_TIMEOUT_MS);
      await rejection;
      expect(store["stalled__final"].status).toBe("failed");
    } finally { vi.useRealTimers(); }
  });

  it("waits for the cold target Pod to become Ready after final import before reporting success", async () => {
    const store: Store = {};
    const calls: string[] = [];
    const baseRunner = makeCommandRunner([]);
    let finishWait!: () => void;
    let enteredWait!: () => void;
    const waiting = new Promise<void>((resolve) => { enteredWait = resolve; });
    const ready = new Promise<void>((resolve) => { finishWait = resolve; });
    const runCommand: CommandRunner = async (command, args, opts) => {
      if (args.includes("wait")) {
        expect(calls.at(-1)).toContain("/finish-rsync-import/gw-to");
        expect(args).toEqual(["-n", "octogee-test", "wait", "--for=condition=Ready", "pod/gw-to-pod", "--timeout=60s"]);
        expect(opts?.timeoutMs).toBe(65_000);
        enteredWait();
        await ready;
        return { stdout: "condition met", stderr: "", code: 0 };
      }
      return baseRunner(command, args, opts);
    };
    const transfer = createRsyncMigrationTransfer({
      store: makeStore(store), namespace: "octogee-test", privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT, resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch(calls), runCommand,
    });
    const completion = transfer({
      migrationId: "cold-user", fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode: "final",
    });
    await waiting;
    expect(store["cold-user__final"].status).toBe("running");
    finishWait();
    await expect(completion).resolves.toMatchObject({ imported: true });
    expect(store["cold-user__final"].status).toBe("succeeded");
  });

  it("fails final transfer when the activated target never becomes Ready", async () => {
    const store: Store = {};
    const calls: string[] = [];
    const baseRunner = makeCommandRunner([]);
    const transfer = createRsyncMigrationTransfer({
      store: makeStore(store), namespace: "octogee-test", privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT, resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch(calls),
      runCommand: (command, args, opts) => args.includes("wait")
        ? Promise.resolve({ stdout: "", stderr: "timed out", code: 1 })
        : baseRunner(command, args, opts),
    });
    await expect(transfer({
      migrationId: "unready-user", fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode: "final",
    })).rejects.toThrow("target gw-to-pod did not become Ready");
    expect(store["unready-user__final"].status).toBe("failed");
    expect(calls.at(-1)).toContain("/abort-rsync-import/gw-to");
  });

  it("uses a running target transport while restore convergence intentionally holds Pod readiness", async () => {
    const store: Store = {};
    const fetchCalls: string[] = [];
    const runCommand: CommandRunner = async (_command, args) => {
      const selector = args[args.indexOf("-l") + 1] ?? "";
      const response = selector.includes("gateway-instance=gw-to")
        ? runningPod("gw-to-pod", false, IPV6_TARGET_POD_IP)
        : readyPod("gw-from-pod");
      return { stdout: await response.text(), stderr: "", code: 0 };
    };
    const transfer = createRsyncMigrationTransfer({
      store: makeStore(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: "7443",
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch(fetchCalls, IPV6_TARGET_POD_IP),
      runCommand,
    });

    await expect(transfer({
      migrationId: "mig-target-restoring",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "pre",
    })).resolves.toMatchObject({ imported: true });
    expect(fetchCalls).toEqual([
      `http://[${IPV6_TARGET_POD_IP}]:7443/prepare-rsync-import/gw-to`,
      "http://gw-from/push-rsync-state/gw-from",
      `http://[${IPV6_TARGET_POD_IP}]:7443/finish-rsync-import/gw-to`,
    ]);
  });

  it("keeps an import the target committed but could not finish verifying", async () => {
    const store: Store = {};
    const fetchCalls: string[] = [];
    const logs: string[] = [];
    const baseFetch = makeFetch(fetchCalls);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const response = await baseFetch(input, init);
      if (!url.includes("/finish-rsync-import/")) return response;
      const body = await response.json() as Record<string, unknown>;
      return jsonResponse({
        ...body,
        verificationPending: "connect response timed out after 30000ms",
      });
    }) as typeof fetch;
    const transfer = createRsyncMigrationTransfer({
      store: makeStore(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: fetchImpl,
      runCommand: makeCommandRunner([]),
      log: (message) => logs.push(message),
    });

    await expect(transfer({
      migrationId: "mig-pending-verify",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "final",
    })).resolves.toMatchObject({ imported: true });

    expect(fetchCalls.some((url) => url.includes("/abort-rsync-import/"))).toBe(false);
    expect(logs.some((line) => line.includes("verification pending"))).toBe(true);
  });

  it("requires the source transport to be Ready before it serves the state push", async () => {
    const store: Store = {};
    const runCommand: CommandRunner = async (_command, args) => {
      const selector = args[args.indexOf("-l") + 1] ?? "";
      const response = selector.includes("gateway-instance=gw-from")
        ? runningPod("gw-from-pod", false)
        : readyPod("gw-to-pod");
      return { stdout: await response.text(), stderr: "", code: 0 };
    };
    const transfer = createRsyncMigrationTransfer({
      store: makeStore(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch([]),
      runCommand,
    });

    await expect(transfer({
      migrationId: "mig-source-not-ready",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "pre",
    })).rejects.toMatchObject({
      message: "expected exactly one ready pod for transport=gw-from; found 0",
      retryable: true,
    });
  });

  it("rejects an ambiguous target transport instead of selecting an arbitrary pod", async () => {
    const store: Store = {};
    const runCommand: CommandRunner = async (_command, args) => {
      const selector = args[args.indexOf("-l") + 1] ?? "";
      if (selector.includes("gateway-instance=gw-to")) {
        return {
          stdout: JSON.stringify({
            items: [
              {
                metadata: { name: "gw-to-pod-a" },
                status: { phase: "Running", podIP: TARGET_POD_IP },
              },
              {
                metadata: { name: "gw-to-pod-b" },
                status: { phase: "Running", podIP: "10.1.0.21" },
              },
            ],
          }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: await readyPod("gw-from-pod").text(), stderr: "", code: 0 };
    };
    const transfer = createRsyncMigrationTransfer({
      store: makeStore(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch([]),
      runCommand,
    });

    await expect(transfer({
      migrationId: "mig-ambiguous-target",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "pre",
    })).rejects.toMatchObject({
      message: "expected exactly one ready pod for transport=gw-to; found 0",
      retryable: true,
    });
  });

  it("selects the sole Ready target during a surge overlap", async () => {
    const store: Store = {};
    const fetchCalls: string[] = [];
    const runCommand: CommandRunner = async (_command, args) => {
      const selector = args[args.indexOf("-l") + 1] ?? "";
      if (selector.includes("gateway-instance=gw-to")) {
        return {
          stdout: JSON.stringify({
            items: [
              {
                metadata: { name: "gw-to-serving" },
                status: {
                  phase: "Running",
                  podIP: TARGET_POD_IP,
                  conditions: [{ type: "Ready", status: "True" }],
                },
              },
              {
                metadata: { name: "gw-to-candidate" },
                status: {
                  phase: "Running",
                  podIP: "10.1.0.21",
                  conditions: [{ type: "Ready", status: "False" }],
                },
              },
            ],
          }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: await readyPod("gw-from-pod").text(), stderr: "", code: 0 };
    };
    const transfer = createRsyncMigrationTransfer({
      store: makeStore(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch(fetchCalls),
      runCommand,
    });

    await transfer({
      migrationId: "mig-surge-target",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "pre",
    });

    expect(fetchCalls[0]).toBe(
      `http://${TARGET_POD_IP}:${FLEET_CONTROLLER_PORT}/prepare-rsync-import/gw-to`,
    );
  });

  it("signals a missing source pod as retryable so a preempted shared gateway can recover in place", async () => {
    const store: Store = {};
    const runCommand: CommandRunner = async (_command, args) => {
      const selector = args[args.indexOf("-l") + 1] ?? "";
      if (selector.includes("gateway-instance=gw-to")) {
        return { stdout: await readyPod("gw-to-pod").text(), stderr: "", code: 0 };
      }
      return { stdout: JSON.stringify({ items: [] }), stderr: "", code: 0 };
    };
    const transfer = createRsyncMigrationTransfer({
      store: makeStore(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch([]),
      runCommand,
    });

    await expect(transfer({
      migrationId: "mig-preempted-source",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "pre",
    })).rejects.toMatchObject({
      message: "expected exactly one ready pod for transport=gw-from; found 0",
      retryable: true,
    });
  });

  it("uses revision transport ids for same-gateway drain pod selection and control URLs", async () => {
    const store: Store = {};
    const fetchCalls: string[] = [];
    const commandCalls: Array<{ command: string; args: string[] }> = [];
    const runCommand: CommandRunner = async (command, args) => {
      commandCalls.push({ command, args });
      const selector = args[args.indexOf("-l") + 1] ?? "";
      if (selector.includes("gateway-instance=default-r2")) {
        return { stdout: await readyPod("gw-from-pod").text(), stderr: "", code: 0 };
      }
      if (selector.includes("gateway-instance=default-r3")) {
        return { stdout: await readyPod("gw-to-pod").text(), stderr: "", code: 0 };
      }
      return { stdout: JSON.stringify({ items: [] }), stderr: "", code: 0 };
    };
    const transfer = createRsyncMigrationTransfer({
      store: makeStore(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch(fetchCalls),
      runCommand,
    });

    await transfer({
      migrationId: "mig-drain",
      fromGatewayId: "default",
      toGatewayId: "default",
      fromTransportId: "default-r2",
      toTransportId: "default-r3",
      slug: "alice",
      mode: "pre",
    });

    expect(commandCalls.map((call) => call.args[call.args.indexOf("-l") + 1])).toEqual([
      "app=octogee-gateway,gateway-instance=default-r2",
      "app=octogee-gateway,gateway-instance=default-r3",
    ]);
    expect(fetchCalls).toEqual([
      `http://${TARGET_POD_IP}:3003/prepare-rsync-import/default`,
      "http://default-r2/push-rsync-state/default",
      `http://${TARGET_POD_IP}:3003/finish-rsync-import/default`,
    ]);
  });

  it("re-runs a succeeded transfer because rollback can remove the target copy", async () => {
    const store: Store = {};
    const fetchCalls: string[] = [];
    const commandCalls: Array<{ command: string; args: string[] }> = [];
    let now = 10_000;
    const transfer = createRsyncMigrationTransfer({
      store: makeStore(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch(fetchCalls),
      runCommand: makeCommandRunner(commandCalls),
      now: () => now++,
      workerId: "worker-1",
    });

    await transfer({
      migrationId: "mig-1",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "pre",
      includeActivationManifest: true,
    });

    expect(store["mig-1__pre"]).toMatchObject({
      status: "succeeded",
      attempt: 1,
      sourceGatewayId: "gw-from",
      targetGatewayId: "gw-to",
    });
    expect(fetchCalls).toEqual([
      `http://${TARGET_POD_IP}:3003/prepare-rsync-import/gw-to`,
      "http://gw-from/push-rsync-state/gw-from",
      `http://${TARGET_POD_IP}:3003/finish-rsync-import/gw-to`,
    ]);
    expect(commandCalls.filter((c) => c.command === "kubectl")).toHaveLength(2);
    expect(commandCalls.filter((c) => c.command === "rsync")).toHaveLength(0);

    await transfer({
      migrationId: "mig-1",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "pre",
      includeActivationManifest: true,
    });

    expect(store["mig-1__pre"]).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(fetchCalls).toHaveLength(6);
    expect(commandCalls.filter((c) => c.command === "kubectl")).toHaveLength(4);
  });

  it("marks a failed direct push task failed, aborts target import, and retries it with the next attempt", async () => {
    const store: Store = {};
    const fetchCalls: string[] = [];
    const commandCalls: Array<{ command: string; args: string[] }> = [];
    let failPush = true;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.includes("/push-rsync-state/") && failPush) {
        return new Response("network reset", { status: 500 });
      }
      return makeFetch([])(input, init);
    }) as typeof globalThis.fetch;
    const transfer = createRsyncMigrationTransfer({
      store: makeStore(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch,
      runCommand: makeCommandRunner(commandCalls),
      now: () => Date.now(),
      workerId: "worker-1",
    });

    const input = {
      migrationId: "mig-2",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "final" as const,
      includeActivationManifest: false,
    };

    await expect(transfer(input)).rejects.toThrow(/network reset/);
    expect(store["mig-2__final"]).toMatchObject({ status: "failed", attempt: 1 });
    expect(fetchCalls).toContain(
      `http://${TARGET_POD_IP}:3003/abort-rsync-import/gw-to`,
    );

    failPush = false;
    await transfer(input);
    expect(store["mig-2__final"]).toMatchObject({ status: "succeeded", attempt: 2 });
  });

  it("never asks the source to push when the target offers no pinned TLS certificate", async () => {
    const store: Store = {};
    const fetchCalls: string[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.includes("/prepare-rsync-import/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { migrationId: string; slug: string };
        return jsonResponse({ migrationId: body.migrationId, slug: body.slug, imported: true, host: "0.0.0.0", port: 30873, module: "state" });
      }
      return makeFetch([])(input, init);
    }) as typeof globalThis.fetch;
    const transfer = createRsyncMigrationTransfer({
      store: makeStore(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch,
      runCommand: makeCommandRunner([]),
      now: () => Date.now(),
      workerId: "worker-1",
    });

    await expect(transfer({
      migrationId: "mig-no-pin",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "final",
      includeActivationManifest: false,
    })).rejects.toThrow("did not return a migration TLS certificate");
    expect(fetchCalls.some((url) => url.includes("/push-rsync-state/"))).toBe(false);
    expect(fetchCalls).toContain(`http://${TARGET_POD_IP}:3003/abort-rsync-import/gw-to`);
  });
});

describe("createRsyncMigrationTransfer with a VM target", () => {
  const VM_IP = ["172", "20", "0", "9"].join(".");

  function vmTransfer(store: Store, calls: string[], fetchImpl: typeof fetch, kubectlCalls: Array<{ command: string; args: string[] }>) {
    return createRsyncMigrationTransfer({
      store: makeStore(store), namespace: "octogee-test", privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT, resolveGatewayUrl: (id) => `http://${id}`,
      fetch: fetchImpl,
      runCommand: makeCommandRunner(kubectlCalls),
      resolveGatewayVm: async (transportId) => transportId === "gw-to"
        ? { instanceName: "octogee-gw-gw-to", internalIp: VM_IP }
        : null,
      wait: async () => {},
      now: () => Date.now(),
    });
  }

  it("addresses the target by its VM IP, never lists its pods, and waits on its fleet endpoint after a final import", async () => {
    const store: Store = {};
    const calls: string[] = [];
    const kubectlCalls: Array<{ command: string; args: string[] }> = [];
    const base = makeFetch(calls, VM_IP);
    let readyPolls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `http://${VM_IP}:${FLEET_CONTROLLER_PORT}/surge-ready`) {
        readyPolls += 1;
        return new Response(readyPolls < 3 ? "not yet" : "ok", { status: readyPolls < 3 ? 503 : 200 });
      }
      return base(input, init);
    }) as typeof fetch;

    await expect(vmTransfer(store, calls, fetchImpl, kubectlCalls)({
      migrationId: "to-vm", fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode: "final",
    })).resolves.toMatchObject({ imported: true });

    expect(calls.filter((url) => url.includes("/prepare-rsync-import/"))).toEqual([
      `http://${VM_IP}:${FLEET_CONTROLLER_PORT}/prepare-rsync-import/gw-to`,
    ]);
    expect(readyPolls).toBe(3);
    const selectors = kubectlCalls.map((c) => c.args[c.args.indexOf("-l") + 1] ?? "");
    expect(selectors.some((s) => s.includes("gateway-instance=gw-from"))).toBe(true);
    expect(selectors.some((s) => s.includes("gateway-instance=gw-to"))).toBe(false);
    expect(kubectlCalls.some((c) => c.args.includes("wait"))).toBe(false);
    expect(store["to-vm__final"].status).toBe("succeeded");
  });

  it("fails a final import when the VM's fleet endpoint never answers", async () => {
    const store: Store = {};
    const calls: string[] = [];
    const base = makeFetch(calls, VM_IP);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/surge-ready")) throw new Error("ECONNREFUSED");
      return base(input, init);
    }) as typeof fetch;
    let clock = 0;
    const transfer = createRsyncMigrationTransfer({
      store: makeStore(store), namespace: "octogee-test", privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT, resolveGatewayUrl: (id) => `http://${id}`,
      fetch: fetchImpl, runCommand: makeCommandRunner([]),
      resolveGatewayVm: async (id) => id === "gw-to" ? { instanceName: "octogee-gw-gw-to", internalIp: VM_IP } : null,
      wait: async () => { clock += 30_000; },
      now: () => clock,
    });
    await expect(transfer({
      migrationId: "to-vm-unready", fromGatewayId: "gw-from", toGatewayId: "gw-to", slug: "alice", mode: "final",
    })).rejects.toThrow("target octogee-gw-gw-to did not become Ready: ECONNREFUSED");
    expect(calls.some((url) => url.includes("/abort-rsync-import/"))).toBe(true);
  });
});


describe("retained source final transfer",()=>{
  it.each(["pending","complete","stale"])("keeps normal target protocol without lease or source push when helper is %s",async outcome=>{
    const store:Store={};const calls:string[]=[];const commands:Array<{command:string;args:string[]}>=[];
    const prepareAgentStores = vi.fn(async () => { expect(calls.some(url => url.includes("/finish-rsync-import/"))).toBe(false); });
    const transfer=createRsyncMigrationTransfer({
      prepareAgentStores,
      store:makeStore(store),namespace:"octogee-test",privateKey:FLEET_KEY_PAIR.privateKey,
      fleetControllerPort:FLEET_CONTROLLER_PORT,resolveGatewayUrl:id=>`http://${id}`,
      fetch:makeFetch(calls),runCommand:makeCommandRunner(commands),
      retainedSource:{assertActiveClaim:async()=>{if(outcome==="stale")throw new Error("active claim changed");},settledTarget:async()=>undefined,acknowledgeCleanup:async record=>record,observe:async()=>undefined,execute:async ({target,prepare})=>{
        const push=await prepare(SOURCE_POD_IP);
        expect(push).toMatchObject({mode:"final",includeActivationManifest:true,targetCertificatePem:TARGET_CERTIFICATE_PEM});
        if(outcome==="pending")throw new Error("source transfer observation pending");
        return {status:"transferred",targetGatewayId:"gw-to",targetName:target.name,targetIp:target.podIP,targetVm:target.vm} as SourceTransferExecution;
      }},
    });
    const result=transfer({migrationId:"retained-1",fromGatewayId:"gw-from",toGatewayId:"gw-to",slug:"alice",mode:"final",includeActivationManifest:true});
    if(outcome==="pending")await expect(result).rejects.toThrow("observation pending");
    else if(outcome==="stale")await expect(result).rejects.toThrow("active claim changed");
    else await expect(result).resolves.toMatchObject({imported:true});
    expect(prepareAgentStores).toHaveBeenCalledTimes(outcome === "complete" ? 1 : 0);
    expect(store).toEqual({});
    expect(calls.some(url=>url.includes("/push-rsync-state/")||url.includes("/abort-rsync-import/"))).toBe(false);
    expect(calls.filter(url=>url.includes("/finish-rsync-import/"))).toHaveLength(outcome==="complete"?1:0);
    expect(commands.some(command=>command.args.some(arg=>arg.includes("gateway-instance=gw-from")))).toBe(false);
  });
});
