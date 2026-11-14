import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import type { KubectlSubprocess } from "../fleet-ingress.js";
import {
  ISOLATED_POD_HOME_PENDING_LIMIT_MS,
  ensureIsolatedPodHome,
  observeIsolatedPodBlockers,
  readIsolatedPodBlocker,
} from "../isolated-pod-home.js";

const NAMESPACE = "octogee";
const GATEWAY = "lin-s-0a1b2c3d";
const CLAIM = `octogee-gateway-${GATEWAY}-data`;
const NOW = Date.parse("2026-11-13T12:00:00Z");
const NO_AMD64 = "the isolated gateway image is linux/amd64 only, and this cluster has no amd64 node";

type Reply = { stdout?: string; stderr?: string; code?: number };
type Call = { args: string[]; stdin?: string };

const notFound = (kind: string, name: string): Reply =>
  ({ code: 1, stderr: `Error from server (NotFound): ${kind} "${name}" not found` });
const json = (value: unknown): Reply => ({ stdout: JSON.stringify(value) });

function kubectl(routes: Record<string, Reply>): { run: KubectlSubprocess; calls: Call[] } {
  const calls: Call[] = [];
  const run: KubectlSubprocess = async (args, opts) => {
    calls.push({ args, ...(opts?.stdin === undefined ? {} : { stdin: opts.stdin }) });
    const key = Object.keys(routes).find((prefix) => args.join(" ").startsWith(prefix));
    if (key === undefined) throw new Error(`unexpected kubectl ${args.join(" ")}`);
    const reply = routes[key]!;
    return { stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", code: reply.code ?? 0 };
  };
  return { run, calls };
}

const claim = (phase: string, createdAt = NOW - 60_000, accessModes = ["ReadWriteOncePod"]) =>
  json({ metadata: { name: CLAIM, creationTimestamp: new Date(createdAt).toISOString() }, spec: { accessModes }, status: { phase } });
const events = (...items: Array<{ type: string; reason: string; message: string; at: number }>) =>
  json({ items: items.map((event) => ({
    type: event.type, reason: event.reason, message: event.message, lastTimestamp: new Date(event.at).toISOString(),
  })) });
const pods = (...conditions: Array<Record<string, string>>) =>
  json({ items: [{ metadata: { name: `octogee-gateway-${GATEWAY}-abc` }, status: { conditions } }] });
const unschedulable = (message: string) =>
  pods({ type: "PodScheduled", status: "False", reason: "Unschedulable", message });
const nodes = (count: number) => json({ items: Array.from({ length: count }, (_, index) => ({ metadata: { name: `node-${index}` } })) });

const GET_CLAIM = `get pvc ${CLAIM} -n ${NAMESPACE}`;
const GET_EVENTS = `get events -n ${NAMESPACE}`;
const GET_PODS = `get pods -n ${NAMESPACE}`;
const GET_NODES = "get nodes";

describe("ensuring an isolated pod gateway's home claim", () => {
  const ensure = (run: KubectlSubprocess, served = false) =>
    ensureIsolatedPodHome({ runKubectl: run, namespace: NAMESPACE, log: vi.fn() }, { gatewayId: GATEWAY, homeSizeGiB: 10, served });

  it("creates the claim the chart mounts, sized from the pod profile and mountable by one pod at a time", async () => {
    const k = kubectl({ [GET_CLAIM]: notFound("persistentvolumeclaims", CLAIM), [`create -n ${NAMESPACE} -f -`]: {} });

    await ensure(k.run);

    const create = k.calls.find((call) => call.args[0] === "create")!;
    expect(JSON.parse(create.stdin!)).toEqual({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: CLAIM,
        namespace: NAMESPACE,
        labels: { "app.kubernetes.io/managed-by": "glm-controller", "octogee.ai/gateway-id": GATEWAY },
      },
      spec: { accessModes: ["ReadWriteOncePod"], resources: { requests: { storage: "10Gi" } } },
    });
  });

  it("leaves an existing claim as it is", async () => {
    const k = kubectl({ [GET_CLAIM]: claim("Bound") });

    await ensure(k.run, true);

    expect(k.calls.map((call) => call.args[0])).toEqual(["get"]);
  });

  it.each([
    ["ReadWriteOnce", ["ReadWriteOnce"]],
    ["no access mode", []],
  ])("refuses to serve an isolated pod from a claim with %s, which more than one pod can mount", async (_name, accessModes) => {
    const k = kubectl({ [GET_CLAIM]: claim("Bound", NOW - 60_000, accessModes) });

    await expect(ensure(k.run, true)).rejects.toThrow(
      `isolated gateway ${GATEWAY} home claim ${CLAIM} is not ReadWriteOncePod`,
    );
    expect(k.calls.map((call) => call.args[0])).toEqual(["get"]);
  });

  it("refuses to replace the home of a gateway that has served with an empty one", async () => {
    const k = kubectl({ [GET_CLAIM]: notFound("persistentvolumeclaims", CLAIM) });

    await expect(ensure(k.run, true)).rejects.toThrow(`isolated gateway ${GATEWAY} has served from home claim ${CLAIM}, which is missing`);
    expect(k.calls.map((call) => call.args[0])).toEqual(["get"]);
  });

  it.each([
    ["the claim cannot be read", { [GET_CLAIM]: { code: 1, stderr: "Error from server (Forbidden): forbidden" } }, "Forbidden"],
    ["the claim cannot be created", {
      [GET_CLAIM]: notFound("persistentvolumeclaims", CLAIM),
      [`create -n ${NAMESPACE} -f -`]: { code: 1, stderr: "admission webhook denied the request" },
    }, "admission webhook denied the request"],
  ])("fails loudly when %s", async (_name, routes, cause) => {
    await expect(ensure(kubectl(routes).run)).rejects.toThrow(cause);
  });
});

describe("reading why an isolated pod gateway is not running", () => {
  const read = (routes: Record<string, Reply>) =>
    readIsolatedPodBlocker({ runKubectl: kubectl(routes).run, namespace: NAMESPACE }, { gatewayId: GATEWAY, now: NOW });

  it("finds nothing when the claim is bound and the pod is scheduled", async () => {
    await expect(read({
      [GET_CLAIM]: claim("Bound"),
      [GET_PODS]: pods({ type: "PodScheduled", status: "True" }),
    })).resolves.toBeNull();
  });

  it("names a missing claim", async () => {
    await expect(read({ [GET_CLAIM]: notFound("persistentvolumeclaims", CLAIM) }))
      .resolves.toBe(`home claim ${CLAIM} is missing`);
  });

  it("names the newest warning on a pending claim, such as a storage class that does not exist", async () => {
    await expect(read({
      [GET_CLAIM]: claim("Pending"),
      [GET_EVENTS]: events(
        { type: "Normal", reason: "WaitForFirstConsumer", message: "waiting for first consumer", at: NOW - 50_000 },
        { type: "Warning", reason: "ProvisioningFailed", message: "an older failure", at: NOW - 40_000 },
        { type: "Warning", reason: "ProvisioningFailed", message: "storageclass.storage.k8s.io \"fast\" not found", at: NOW - 30_000 },
      ),
    })).resolves.toBe(`home claim ${CLAIM} cannot bind: ProvisioningFailed: storageclass.storage.k8s.io "fast" not found`);
  });

  it("says the cluster has no amd64 node when that is why the pod cannot be scheduled", async () => {
    await expect(read({
      [GET_CLAIM]: claim("Pending"),
      [GET_EVENTS]: events({ type: "Normal", reason: "WaitForFirstConsumer", message: "waiting for first consumer", at: NOW - 50_000 }),
      [GET_PODS]: unschedulable("0/1 nodes are available: 1 node(s) didn't match Pod's node affinity/selector."),
      [GET_NODES]: nodes(0),
    })).resolves.toBe(NO_AMD64);
  });

  it("passes on the scheduler's reason when amd64 nodes exist", async () => {
    await expect(read({
      [GET_CLAIM]: claim("Bound"),
      [GET_PODS]: unschedulable("0/3 nodes are available: 3 Insufficient memory."),
      [GET_NODES]: nodes(3),
    })).resolves.toBe("the gateway pod cannot be scheduled: 0/3 nodes are available: 3 Insufficient memory.");
  });

  it("names a claim that has been pending past the limit, with its newest event", async () => {
    await expect(read({
      [GET_CLAIM]: claim("Pending", NOW - ISOLATED_POD_HOME_PENDING_LIMIT_MS - 120_000),
      [GET_EVENTS]: events({
        type: "Normal", reason: "FailedBinding", message: "no persistent volumes available for this claim and no storage class is set", at: NOW - 10_000,
      }),
      [GET_PODS]: pods({ type: "PodScheduled", status: "True" }),
    })).resolves.toBe(`home claim ${CLAIM} has been pending for 7 minutes: no persistent volumes available for this claim and no storage class is set`);
  });

  it("finds nothing while a claim is pending within the limit", async () => {
    await expect(read({
      [GET_CLAIM]: claim("Pending", NOW - 60_000),
      [GET_EVENTS]: events(),
      [GET_PODS]: json({ items: [] }),
    })).resolves.toBeNull();
  });

  it("fails loudly when the nodes cannot be read", async () => {
    await expect(read({
      [GET_CLAIM]: claim("Bound"),
      [GET_PODS]: unschedulable("0/1 nodes are available"),
      [GET_NODES]: { code: 1, stderr: "Error from server (Forbidden): nodes is forbidden" },
    })).rejects.toThrow("nodes is forbidden");
  });
});

describe("recording why isolated pod gateways are not running", () => {
  const OTHER = "max-s-0a1b2c3d";

  function root(gatewayId: string, extra: Record<string, unknown> = {}) {
    return {
      gatewayId, createdAt: 1, createdBy: "operator", updatedAt: 1, updatedBy: "operator",
      latestRelease: 1, desiredRelease: 1, liveRelease: null, desiredStatus: "running", configSchemaVersion: 1,
      profile: null, gatewayClass: "isolated", imageProfile: "isolated", sizingTier: "s", gcpProject: null,
      gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
      ownerUid: "uid-lin", builderSlug: "lin", modelBrokerLimits: null, preemption: null, coOwnerUids: [],
      ...extra,
    };
  }

  function runtimeRecord(gatewayId: string, extra: Record<string, unknown> = {}) {
    return {
      docKind: "runtime", gatewayId, release: 1, lifecycle: "provisioning", createdAt: 1, createdByOperationId: null,
      helm: {}, heartbeat: {}, lastError: { message: null, at: null }, runtime: "cluster", ...extra,
    };
  }

  function harness(seed: Record<string, Record<string, unknown>>, blockers: Record<string, string | null | Error>) {
    const records = new Map(Object.entries(seed));
    const log = vi.fn();
    const readBlocker = vi.fn(async (gatewayId: string) => {
      const blocker = blockers[gatewayId];
      if (blocker instanceof Error) throw blocker;
      return blocker ?? null;
    });
    const observe = () => observeIsolatedPodBlockers({ store: createDocumentFixtureStore(records), readBlocker, now: () => NOW, log });
    return { records, log, readBlocker, observe };
  }

  it("records the blocker as the gateway's last error and logs it once", async () => {
    const h = harness({ [`gateways/${GATEWAY}`]: root(GATEWAY), [`glmGateways/${GATEWAY}`]: runtimeRecord(GATEWAY) }, { [GATEWAY]: NO_AMD64 });

    await h.observe();
    await h.observe();

    expect(h.records.get(`glmGateways/${GATEWAY}`)).toMatchObject({ lastError: { message: NO_AMD64, at: NOW } });
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledWith(`[isolated-pod] ${GATEWAY} is not running: ${NO_AMD64}`);
  });

  it("records a blocker whose event text spans lines on one line, and only once", async () => {
    const event = `home claim ${CLAIM} cannot bind: ProvisioningFailed: failed to provision volume:\n  rpc error: code = ResourceExhausted\tdesc = quota exceeded\n`;
    const h = harness({ [`gateways/${GATEWAY}`]: root(GATEWAY), [`glmGateways/${GATEWAY}`]: runtimeRecord(GATEWAY) }, { [GATEWAY]: event });

    await h.observe();
    await h.observe();

    const oneLine = `home claim ${CLAIM} cannot bind: ProvisioningFailed: failed to provision volume: rpc error: code = ResourceExhausted desc = quota exceeded`;
    expect(h.records.get(`glmGateways/${GATEWAY}`)).toMatchObject({ lastError: { message: oneLine, at: NOW } });
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledWith(`[isolated-pod] ${GATEWAY} is not running: ${oneLine}`);
  });

  it("clears the last error once nothing blocks the gateway", async () => {
    const h = harness({
      [`gateways/${GATEWAY}`]: root(GATEWAY),
      [`glmGateways/${GATEWAY}`]: runtimeRecord(GATEWAY, { lastError: { message: NO_AMD64, at: NOW - 1 } }),
    }, { [GATEWAY]: null });

    await h.observe();

    expect(h.records.get(`glmGateways/${GATEWAY}`)).toMatchObject({ lastError: { message: null, at: null } });
    expect(h.log).toHaveBeenCalledWith(`[isolated-pod] ${GATEWAY} is no longer blocked`);
  });

  it("reads only running isolated gateways that run as pods", async () => {
    const h = harness({
      [`gateways/${GATEWAY}`]: root(GATEWAY, { desiredStatus: "paused" }),
      [`glmGateways/${GATEWAY}`]: runtimeRecord(GATEWAY),
      [`gateways/${OTHER}`]: root(OTHER),
      [`glmGateways/${OTHER}`]: runtimeRecord(OTHER, { runtime: "gce-vm" }),
      ["gateways/shared-a"]: root("shared-a", { gatewayClass: "shared", imageProfile: "standard", ownerUid: null, builderSlug: null }),
      ["glmGateways/shared-a"]: runtimeRecord("shared-a"),
    }, {});

    await h.observe();

    expect(h.readBlocker).not.toHaveBeenCalled();
  });

  it("logs a gateway whose blocker cannot be read and still records the others", async () => {
    const h = harness({
      [`gateways/${GATEWAY}`]: root(GATEWAY),
      [`glmGateways/${GATEWAY}`]: runtimeRecord(GATEWAY),
      [`gateways/${OTHER}`]: root(OTHER, { ownerUid: "uid-max", builderSlug: "max" }),
      [`glmGateways/${OTHER}`]: runtimeRecord(OTHER),
    }, { [GATEWAY]: new Error("nodes is forbidden"), [OTHER]: NO_AMD64 });

    await h.observe();

    expect(h.log).toHaveBeenCalledWith(`[isolated-pod] ⚠ ${GATEWAY}: blocker unreadable: nodes is forbidden`);
    expect(h.records.get(`glmGateways/${OTHER}`)).toMatchObject({ lastError: { message: NO_AMD64, at: NOW } });
  });
});
