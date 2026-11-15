import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_OWNER_RELEASE_WAIT_MS,
  prepareGatewayStateStore,
  waitForGatewayOwnerRelease,
  type StateStoreQuery,
} from "../lib/gateway-state-store-preparation.js";

const GATEWAY = "jane-s-1a2b3c4d";
const THIS_POD = `octogee-gateway-${GATEWAY}-7f9c5d8b6-new01`;
const PREVIOUS_POD = `octogee-gateway-${GATEWAY}-7f9c5d8b6-old01`;
const anchor = { storeId: "92c817cc-770f-466d-b4a6-4e9b02998363", schema: "octogee_state_92c817cc770f466d" };

function leaseStore(initial: { owner: string; heartbeatAt: number; host: string } | null) {
  let row = initial ? { ...initial } : null;
  const deletes: unknown[][] = [];
  const query: StateStoreQuery = async (_anchor, sql, values = []) => {
    if (sql.startsWith("SELECT")) {
      return row ? [{ owner: row.owner, heartbeat_at: String(row.heartbeatAt), payload_json: JSON.stringify({ owner: { pid: 42, host: row.host } }) }] : [];
    }
    deletes.push(values);
    if (row && values[0] === row.owner && values[1] === String(row.heartbeatAt)) {
      row = null;
      return [{ owner: values[0] }];
    }
    return [];
  };
  return { query, deletes, current: () => row, release: () => { row = null; }, renew: (heartbeatAt: number) => { if (row) row.heartbeatAt = heartbeatAt; } };
}

function clock(start: number) {
  let time = start;
  return { now: () => time, sleep: async (ms: number) => { time += ms; } };
}

describe("waitForGatewayOwnerRelease", () => {
  it("leaves an absent lease and one held by this pod to OpenClaw", async () => {
    const empty = leaseStore(null);
    await expect(waitForGatewayOwnerRelease({ anchor, gatewayId: GATEWAY, hostname: THIS_POD, log: () => {}, query: empty.query })).resolves.toBe("absent");
    const own = leaseStore({ owner: "o1", heartbeatAt: 0, host: THIS_POD });
    await expect(waitForGatewayOwnerRelease({ anchor, gatewayId: GATEWAY, hostname: THIS_POD, log: () => {}, query: own.query, ...clock(10 * 60_000) })).resolves.toBe("this-pod");
    expect(own.deletes).toEqual([]);
  });

  it("refuses to touch a lease held by another gateway's pod", async () => {
    const foreign = leaseStore({ owner: "o1", heartbeatAt: 0, host: "octogee-gateway-other-s-99999999-7f9c5d8b6-x1" });
    await expect(waitForGatewayOwnerRelease({ anchor, gatewayId: GATEWAY, hostname: THIS_POD, log: () => {}, query: foreign.query, ...clock(10 * 60_000) }))
      .rejects.toThrow(/not a pod of gateway/);
    expect(foreign.deletes).toEqual([]);
    expect(foreign.current()).not.toBeNull();
  });

  it("preserves an expired foreign lease of this gateway and requires explicit Native recovery", async () => {
    const start = 1_000_000;
    const departed = leaseStore({ owner: "o1", heartbeatAt: start - 10 * 60_000, host: PREVIOUS_POD });
    const logs: string[] = [];
    await expect(waitForGatewayOwnerRelease({ anchor, gatewayId: GATEWAY, hostname: THIS_POD, log: (m) => logs.push(m), query: departed.query, ...clock(start) }))
      .rejects.toThrow(/independent physical-stop proof.*openclaw gateway recover-lock --json.*--confirm/);
    expect(departed.deletes).toEqual([]);
    expect(departed.current()).toEqual({ owner: "o1", heartbeatAt: start - 10 * 60_000, host: PREVIOUS_POD });
    expect(logs.join("\n")).toContain("waiting for the state owner lease");
  });

  it("continues only after the previous holder releases its own lease", async () => {
    const start = 1_000_000;
    const recent = leaseStore({ owner: "o1", heartbeatAt: start - 10_000, host: PREVIOUS_POD });
    const time = clock(start);
    const sleep = async (ms: number) => { await time.sleep(ms); recent.release(); };
    await expect(waitForGatewayOwnerRelease({ anchor, gatewayId: GATEWAY, hostname: THIS_POD, log: () => {}, query: recent.query, now: time.now, sleep }))
      .resolves.toBe("absent");
    expect(recent.deletes).toEqual([]);
    expect(recent.current()).toBeNull();
  });

  it("refuses a holder that keeps renewing until the wait ends", async () => {
    const start = 1_000_000;
    const live = leaseStore({ owner: "o1", heartbeatAt: start, host: PREVIOUS_POD });
    const time = clock(start);
    const sleep = async (ms: number) => { await time.sleep(ms); live.renew(time.now()); };
    await expect(waitForGatewayOwnerRelease({ anchor, gatewayId: GATEWAY, hostname: THIS_POD, log: () => {}, query: live.query, now: time.now, sleep }))
      .rejects.toThrow(/independent physical-stop proof/);
    expect(time.now() - start).toBeGreaterThanOrEqual(GATEWAY_OWNER_RELEASE_WAIT_MS);
    expect(live.current()).not.toBeNull();
  });

  it("refuses unreadable ownership and propagates database failures", async () => {
    const unreadable: StateStoreQuery = vi.fn(async () => [{ payload_json: "invalid JSON" }]);
    await expect(waitForGatewayOwnerRelease({ anchor, gatewayId: GATEWAY, hostname: THIS_POD, log: () => {}, query: unreadable }))
      .rejects.toThrow(/<unreadable>/);
    const failure = new Error("database read failed");
    await expect(waitForGatewayOwnerRelease({ anchor, gatewayId: GATEWAY, hostname: THIS_POD, log: () => {}, query: async () => { throw failure; } }))
      .rejects.toBe(failure);
  });

  it("revalidates foreign gateway ownership after waiting for release", async () => {
    const previous = leaseStore({ owner: "o1", heartbeatAt: 1, host: PREVIOUS_POD });
    let moved = false;
    const query: StateStoreQuery = (selected, sql, values) => moved
      ? Promise.resolve([{ payload_json: JSON.stringify({ owner: { host: "octogee-gateway-other-s-99999999-7f9c5d8b6-x1" } }) }])
      : previous.query(selected, sql, values);
    await expect(waitForGatewayOwnerRelease({ anchor, gatewayId: GATEWAY, hostname: THIS_POD, log: () => {}, query,
      sleep: async () => { moved = true; } })).rejects.toThrow(/not a pod of gateway/);
    expect(previous.deletes).toEqual([]);
  });
});

describe("prepareGatewayStateStore", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function stateRoot(kind: "anchor" | "sqlite", credentials: boolean): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-state-store-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "state"));
    const db = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
    if (kind === "anchor") {
      db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)");
      db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(anchor.storeId, anchor.schema);
    } else {
      db.exec("CREATE TABLE cron_jobs (id TEXT)");
    }
    db.close();
    if (credentials) {
      fs.mkdirSync(path.join(root, "client"));
      fs.writeFileSync(path.join(root, "client", "credentials.sqlite"), "");
    }
    return root;
  }

  const userEnv = (root: string) => ({ GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: "cluster", GATEWAY_ID: GATEWAY, OPENCLAW_STATE_DIR: root });

  it("does nothing outside a cluster user or for SQLite state", async () => {
    const waitForOwner = vi.fn();
    const run = vi.fn();
    const anchored = stateRoot("anchor", false);
    await prepareGatewayStateStore({ log: () => {}, env: { ...userEnv(anchored), GATEWAY_RUNTIME_KIND: "gce-vm" }, waitForOwner });
    await prepareGatewayStateStore({ log: () => {}, env: { ...userEnv(anchored), GATEWAY_CLASS: "shared" }, waitForOwner });
    await prepareGatewayStateStore({ log: () => {}, env: userEnv(stateRoot("sqlite", false)), waitForOwner });
    expect(waitForOwner).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps existing local credentials after the previous owner releases", async () => {
    const waitForOwner = vi.fn(async () => "absent" as const);
    const run = vi.fn();
    await prepareGatewayStateStore({ log: () => {}, env: userEnv(stateRoot("anchor", true)), hostname: THIS_POD, waitForOwner });
    expect(waitForOwner).toHaveBeenCalledWith(expect.objectContaining({ anchor, gatewayId: GATEWAY, hostname: THIS_POD }));
    expect(run).not.toHaveBeenCalled();
  });

  it("allows normal startup with missing credentials after the previous owner releases", async () => {
    const waitForOwner = vi.fn(async () => "absent" as const);
    const logs: string[] = [];
    await prepareGatewayStateStore({ log: message => logs.push(message), env: userEnv(stateRoot("anchor", false)), waitForOwner });
    expect(waitForOwner).toHaveBeenCalledOnce();
    expect(logs.join("\n")).toContain("OpenClaw prepares new local client identities at startup");
  });

  it("does not run Doctor or rebind credentials while a foreign owner remains", async () => {
    const departed = leaseStore({ owner: "o1", heartbeatAt: 1, host: PREVIOUS_POD });
    const time = clock(1_000_000), run = vi.fn(async () => ({ code: 0, stdout: "" }));
    await expect(prepareGatewayStateStore({ log: () => {}, env: userEnv(stateRoot("anchor", false)), hostname: THIS_POD,
      waitForOwner: input => waitForGatewayOwnerRelease({ ...input, query: departed.query, ...time }) }))
      .rejects.toThrow(/independent physical-stop proof/);
    expect(run).not.toHaveBeenCalled();
    expect(departed.deletes).toEqual([]);
    expect(departed.current()).not.toBeNull();
  });
});
