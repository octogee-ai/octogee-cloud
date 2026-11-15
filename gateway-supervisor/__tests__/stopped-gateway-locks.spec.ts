import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { OpenClawCommandOptions, OpenClawCommandResult } from "../lib/openclaw-cli.js";
import { recoverIsolatedPodGatewayLocks, recoverRestartedGatewayContainerLocks } from "../lib/stopped-gateway-locks.js";

const THIS_POD = "octogee-gateway-shared-0a1b2c3d4e5f-6c9f7d5b8-k2x9q";
const EARLIER_POD = "octogee-gateway-shared-0a1b2c3d4e5f-6c9f7d5b8-p7r4m";
const GATEWAY = "jane-s-1a2b3c4d";
const ISOLATED_POD = `octogee-gateway-${GATEWAY}-7f9c5d8b6-new01`;
const EVICTED_POD = `octogee-gateway-${GATEWAY}-7f9c5d8b6-old01`;
const ISOLATED = { GATEWAY_ID: GATEWAY, GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: "cluster" };
const FIRST_INSTANCE = "4026532911";
const SECOND_INSTANCE = "4026533187";
const SIBLING_CONTAINER = "4026532874";
const FINGERPRINT = "4db1f3d389c93f8f8a9b5f536ee948ea73c90ccbff923ff2c914662d937e2b4f";
const RECORD = ".gateway-container-pid-namespaces.json";

function fileHolder(host: string, pidNamespace: string): string {
  return `/home/node/.openclaw/gateway.state.lock: holder 47 at ${host}/pid-ns ${pidNamespace}, last renewed 41 s ago. `
    + "Stop the holder before retrying; if it has already stopped, run `openclaw gateway recover-lock` to inspect and explicitly recover the unchanged owner.";
}

function leaseHolder(host: string, pidNamespace: string): string {
  return `PostgreSQL Gateway owner lease: holder 47 at ${host}/pid-ns ${pidNamespace}, last renewed 44 s ago. `
    + "Stop the holder before retrying; if it has already stopped, run `openclaw gateway recover-lock` to inspect and explicitly recover the unchanged owner.";
}

function inspection(holders: string[]): string {
  return [
    "[state/sqlite] SQLite read-only snapshot for /home/node/.openclaw/state/openclaw.sqlite: 8.0 KiB, budget 301 seconds",
    JSON.stringify({ present: holders.length > 0, holders, confirmation: FINGERPRINT, command: `openclaw gateway recover-lock --confirm ${FINGERPRINT}` }, null, 2),
  ].join("\n");
}

const stateDirs: string[] = [];

afterEach(() => {
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(input: {
  holders?: string[];
  record?: unknown;
  hostname?: string;
  pidNamespace?: string;
  env?: NodeJS.ProcessEnv;
  confirmOutput?: OpenClawCommandResult;
  start?: "container" | "isolated-pod";
}) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "stopped-gateway-locks-"));
  stateDirs.push(stateDir);
  if (input.record !== undefined) {
    writeFileSync(path.join(stateDir, RECORD), typeof input.record === "string" ? input.record : JSON.stringify(input.record));
  }
  const env: NodeJS.ProcessEnv = { ...(input.env ?? { GATEWAY_CLASS: "shared" }), OPENCLAW_STATE_DIR: stateDir };
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const logs: string[] = [];
  const run = async (args: string[], options: OpenClawCommandOptions): Promise<OpenClawCommandResult> => {
    calls.push({ args, env: options.env });
    if (args.includes("--confirm")) {
      return input.confirmOutput ?? { code: 0, stdout: JSON.stringify({ recovered: true, removed: input.holders?.length ?? 0 }) };
    }
    return { code: 0, stdout: inspection(input.holders ?? []) };
  };
  const options = {
    env,
    hostname: input.hostname ?? THIS_POD,
    pidNamespace: input.pidNamespace ?? SECOND_INSTANCE,
    run,
    log: (message: string) => logs.push(message),
  };
  const recover = () => input.start === "isolated-pod"
    ? recoverIsolatedPodGatewayLocks(options)
    : recoverRestartedGatewayContainerLocks(options);
  const record = () => JSON.parse(readFileSync(path.join(stateDir, RECORD), "utf8")) as unknown;
  return { recover, calls, logs, record, stateDir };
}

describe("recoverRestartedGatewayContainerLocks", () => {
  it("records the first gateway container's PID namespace in a pod without asking OpenClaw about locks", async () => {
    const { recover, calls, record } = harness({ pidNamespace: FIRST_INSTANCE });

    await expect(recover()).resolves.toBe("first-start");

    expect(record()).toEqual({ host: THIS_POD, pidNamespaces: [FIRST_INSTANCE] });
    expect(calls).toEqual([]);
  });

  it("recovers the records an earlier gateway container in this pod left behind", async () => {
    const holders = [fileHolder(THIS_POD, FIRST_INSTANCE), leaseHolder(THIS_POD, FIRST_INSTANCE)];
    const { recover, calls, logs, record, stateDir } = harness({ holders, record: { host: THIS_POD, pidNamespaces: [FIRST_INSTANCE] } });

    await expect(recover()).resolves.toBe("recovered");

    expect(calls.map((call) => call.args)).toEqual([
      ["gateway", "recover-lock", "--json"],
      ["gateway", "recover-lock", "--confirm", FINGERPRINT, "--json"],
    ]);
    expect(calls.every((call) => call.env.OPENCLAW_STATE_DIR === stateDir)).toBe(true);
    expect(record()).toEqual({ host: THIS_POD, pidNamespaces: [FIRST_INSTANCE, SECOND_INSTANCE] });
    expect(logs.join("\n")).toContain(`pod ${THIS_POD}: recovered 2 Gateway lock record(s) whose holders stopped`);
  });

  it("records this container before it inspects, so a container killed mid-recovery is still provable", async () => {
    const { recover, record } = harness({
      holders: [fileHolder(THIS_POD, FIRST_INSTANCE)],
      record: { host: THIS_POD, pidNamespaces: [FIRST_INSTANCE] },
      confirmOutput: { code: 1, stdout: "", stderr: "lock changed" },
    });

    await expect(recover()).rejects.toThrow("Gateway lock recovery failed (exit 1): lock changed");

    expect(record()).toEqual({ host: THIS_POD, pidNamespaces: [FIRST_INSTANCE, SECOND_INSTANCE] });
  });

  it("does nothing more when the earlier container left no records", async () => {
    const { recover, calls } = harness({ holders: [], record: { host: THIS_POD, pidNamespaces: [FIRST_INSTANCE] } });

    await expect(recover()).resolves.toBe("absent");

    expect(calls.map((call) => call.args)).toEqual([["gateway", "recover-lock", "--json"]]);
  });

  it.each([
    ["this container's own namespace", [fileHolder(THIS_POD, SECOND_INSTANCE)]],
    ["a namespace this pod's gateway container never recorded", [fileHolder(THIS_POD, SIBLING_CONTAINER)]],
    ["another pod of a shared gateway, whose home is not a single-pod claim", [leaseHolder(EARLIER_POD, FIRST_INSTANCE)]],
    ["a host with no PID namespace", [leaseHolder(THIS_POD, FIRST_INSTANCE).replace(`/pid-ns ${FIRST_INSTANCE}`, "")]],
    ["an earlier container and an unproven holder together", [fileHolder(THIS_POD, FIRST_INSTANCE), leaseHolder(THIS_POD, SIBLING_CONTAINER)]],
    ["a record OpenClaw describes in a form this check does not know", ["PostgreSQL Gateway owner lease: owned elsewhere."]],
  ])("leaves the records to OpenClaw when a holder is %s", async (_name, holders) => {
    const { recover, calls, logs } = harness({ holders, record: { host: THIS_POD, pidNamespaces: [FIRST_INSTANCE] } });

    await expect(recover()).resolves.toBe("held");

    expect(calls.map((call) => call.args)).toEqual([["gateway", "recover-lock", "--json"]]);
    expect(logs.join("\n")).toContain("holder not proven stopped");
  });

  it("starts a fresh record when the home's record belongs to an earlier pod", async () => {
    const { recover, calls, record } = harness({ record: { host: EARLIER_POD, pidNamespaces: [FIRST_INSTANCE] } });

    await expect(recover()).resolves.toBe("first-start");

    expect(record()).toEqual({ host: THIS_POD, pidNamespaces: [SECOND_INSTANCE] });
    expect(calls).toEqual([]);
  });

  it("recovers an isolated pod's earlier container and earlier pod records together", async () => {
    const { recover, calls } = harness({
      hostname: ISOLATED_POD,
      holders: [fileHolder(ISOLATED_POD, FIRST_INSTANCE), leaseHolder(EVICTED_POD, FIRST_INSTANCE)],
      record: { host: ISOLATED_POD, pidNamespaces: [FIRST_INSTANCE] },
      env: ISOLATED,
    });

    await expect(recover()).resolves.toBe("recovered");

    expect(calls).toHaveLength(2);
  });

  it("leaves a VM gateway alone, whose container lifecycle Kubernetes does not own", async () => {
    const { recover, calls, stateDir } = harness({
      record: undefined,
      env: { ...ISOLATED, GATEWAY_RUNTIME_KIND: "gce-vm" },
    });

    await expect(recover()).resolves.toBe("not-a-pod");

    expect(existsSync(path.join(stateDir, RECORD))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("fails the start when the record is unreadable", async () => {
    const { recover, calls } = harness({ record: "{\"host\":" });

    await expect(recover()).rejects.toThrow(/Gateway container PID namespace record .* is unreadable/u);

    expect(calls).toEqual([]);
  });

  it("fails the start when the confirmation does not report a recovery", async () => {
    const { recover } = harness({
      holders: [fileHolder(THIS_POD, FIRST_INSTANCE)],
      record: { host: THIS_POD, pidNamespaces: [FIRST_INSTANCE] },
      confirmOutput: { code: 0, stdout: JSON.stringify({ recovered: false, removed: 0 }) },
    });

    await expect(recover()).rejects.toThrow("Gateway lock recovery did not report a recovery");
  });
});

describe("recoverIsolatedPodGatewayLocks", () => {
  it("recovers the records an earlier pod of this gateway left on its single-pod home claim", async () => {
    const { recover, calls, logs } = harness({
      start: "isolated-pod",
      hostname: ISOLATED_POD,
      holders: [fileHolder(EVICTED_POD, FIRST_INSTANCE), leaseHolder(EVICTED_POD, FIRST_INSTANCE)],
      env: ISOLATED,
    });

    await expect(recover()).resolves.toBe("recovered");

    expect(calls.map((call) => call.args)).toEqual([
      ["gateway", "recover-lock", "--json"],
      ["gateway", "recover-lock", "--confirm", FINGERPRINT, "--json"],
    ]);
    expect(logs.join("\n")).toContain(`pod ${ISOLATED_POD}: recovered 2 Gateway lock record(s) whose holders stopped`);
  });

  it("also recovers the records of an earlier gateway container in this pod, and leaves the container record as it is", async () => {
    const containers = { host: ISOLATED_POD, pidNamespaces: [FIRST_INSTANCE, SECOND_INSTANCE] };
    const { recover, calls, record } = harness({
      start: "isolated-pod",
      hostname: ISOLATED_POD,
      holders: [fileHolder(ISOLATED_POD, FIRST_INSTANCE), leaseHolder(EVICTED_POD, FIRST_INSTANCE)],
      record: containers,
      env: ISOLATED,
    });

    await expect(recover()).resolves.toBe("recovered");

    expect(calls).toHaveLength(2);
    expect(record()).toEqual(containers);
  });

  it.each([
    ["this container", fileHolder(ISOLATED_POD, SECOND_INSTANCE)],
    ["another gateway's pod", fileHolder("octogee-gateway-john-s-9f8e7d6c-7f9c5d8b6-old01", FIRST_INSTANCE)],
    ["a hostname the kubelet truncated from a longer pod name", fileHolder(`octogee-gateway-${GATEWAY}-7f9c5d8b6-ol`, FIRST_INSTANCE)],
    ["a pod of this gateway that is not a Deployment pod", fileHolder(`octogee-gateway-${GATEWAY}-old01`, FIRST_INSTANCE)],
  ])("leaves the records to OpenClaw when a holder is %s", async (_name, holder) => {
    const { recover, calls, logs } = harness({
      start: "isolated-pod",
      hostname: ISOLATED_POD,
      holders: [holder],
      record: { host: ISOLATED_POD, pidNamespaces: [SECOND_INSTANCE] },
      env: ISOLATED,
    });

    await expect(recover()).resolves.toBe("held");

    expect(calls.map((call) => call.args)).toEqual([["gateway", "recover-lock", "--json"]]);
    expect(logs.join("\n")).toContain("holder not proven stopped");
  });

  it.each([
    ["a shared gateway", { GATEWAY_CLASS: "shared" }],
    ["a VM gateway", { ...ISOLATED, GATEWAY_RUNTIME_KIND: "gce-vm" }],
  ])("leaves %s alone", async (_name, env) => {
    const { recover, calls } = harness({ start: "isolated-pod", holders: [leaseHolder(EARLIER_POD, FIRST_INSTANCE)], env });

    await expect(recover()).resolves.toBe("not-an-isolated-pod");

    expect(calls).toEqual([]);
  });

  it("refuses an isolated pod without its gateway id", async () => {
    const { recover, calls } = harness({ start: "isolated-pod", hostname: ISOLATED_POD, env: { ...ISOLATED, GATEWAY_ID: " " } });

    await expect(recover()).rejects.toThrow("GATEWAY_ID is required");

    expect(calls).toEqual([]);
  });
});
