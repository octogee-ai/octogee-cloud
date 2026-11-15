import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stagedSecretOwnersOnly, unassignedConfiguredAgents } from "../lib/shared-broker-profile-readiness.js";
import type { DegradedSecretOwner } from "../lib/gateway-rpc.js";
import { mattermostAccountSecretRef, updateMattermostAccountSecrets } from "../lib/mattermost-account-secrets.js";
import { clearUserClaim, stubUserClaim } from "./helpers/user-claim.js";

import { DatabaseSync } from "node:sqlite";

import { OpenClawSecretsApplyError } from "@octogee/core/agent-model-token-materializer";
import {
  _resetBrokerProfileLogStateForTests,
  brokerProfileRoster,
  materializeDeferredBrokerProfiles,
} from "../lib/fleet-provisioner.js";

/** The store openclaw creates at startup, reduced to the ownership stamp our
 *  auth-profile reads require — a bare file would pass a test against state
 *  the gateway rejects. */
function seedAgentStore(agentsDir: string, agentId: string): void {
  const dir = path.join(agentsDir, agentId, "agent");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "openclaw-agent.sqlite"));
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
       CREATE TABLE IF NOT EXISTS schema_meta (meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL, agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
       PRAGMA user_version = 16;`,
    );
    db.prepare(
      `INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
       VALUES ('primary', 'agent', 16, ?, 0, 0) ON CONFLICT(meta_key) DO NOTHING`,
    ).run(agentId);
  } finally {
    db.close();
  }
}

/** Mirrors what openclaw's secrets.apply persists, so the next sweep's
 *  idempotency read settles. */
function writeAppliedProfiles(
  agentsDir: string,
  plan: {
    targets: Array<{ path: string; agentId: string; authProfileProvider: string; ref: unknown }>;
  },
): void {
  for (const target of plan.targets) {
    const dir = path.join(agentsDir, target.agentId, "agent");
    const db = new DatabaseSync(path.join(dir, "openclaw-agent.sqlite"));
    try {
      const row = db
        .prepare("SELECT store_json AS v FROM auth_profile_store WHERE store_key = 'primary'")
        .get() as { v?: string } | undefined;
      const store = (row?.v ? JSON.parse(row.v) : {}) as { profiles?: Record<string, unknown> };
      const profiles = store.profiles ?? {};
      profiles[target.path.replace(/^profiles\./, "").replace(/\.key$/, "")] = {
        type: "api_key",
        provider: target.authProfileProvider,
        keyRef: target.ref,
        key: "resolved",
      };
      db.prepare(
        `INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES ('primary', ?, 0)
         ON CONFLICT(store_key) DO UPDATE SET store_json = excluded.store_json`,
      ).run(JSON.stringify({ ...store, profiles }));
    } finally {
      db.close();
    }
  }
}

/**
 * Only openclaw writes an agent's auth-profile store, and its `secrets apply`
 * can refuse at any moment a one-shot materialization happens to run — leaving
 * the catalog written but the broker profile absent, so the agent's first turn
 * fails on credentials. This sweep is therefore retried on a timer until every
 * rostered agent has its profile, and must stay quiet once it has nothing left
 * to do.
 */
describe("broker profile retry (level-triggered)", () => {
  const AGENT = "octogee-alice-coach";
  let agentsDir: string;
  let logs: string[];
  let applyOutcome: "refuse" | "accept";
  let apply: ReturnType<typeof vi.fn>;
  let reloadFails: boolean;
  let reload: ReturnType<typeof vi.fn>;
  const readConfig = () => ({ agents: { entries: { [AGENT]: { model: "house" } } } });
  const sweep = () =>
    materializeDeferredBrokerProfiles((m) => logs.push(m), {
      agentsDir,
      readConfig,
      secretsApply: { apply },
      secretsReload: { secretsReload: reload },
    });

  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-bpr-"));
    logs = [];
    applyOutcome = "refuse";
    reloadFails = false;
    apply = vi.fn(async (plan: Parameters<typeof writeAppliedProfiles>[1]) => {
      if (applyOutcome === "refuse") {
        throw new OpenClawSecretsApplyError("secret provider unavailable", 1);
      }
      writeAppliedProfiles(agentsDir, plan);
      return { mode: "write", changed: true };
    });
    reload = vi.fn(async () => {
      if (reloadFails) throw new Error("snapshot reload unavailable");
      return { ok: true, warningCount: 0 };
    });
    _resetBrokerProfileLogStateForTests();
  });
  afterEach(() => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  });

  it("applies the profiles through openclaw's standard secrets apply", async () => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";

    await sweep();

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ generatedBy: "manual", targets: expect.any(Array) }),
    );
  });

  it("materializes every user agent whose store the final import replaced, without a pre-boot pass", async () => {
    const userAgents = [AGENT, "octogee-alice-proj-orbit-coach"];
    for (const agentId of userAgents) seedAgentStore(agentsDir, agentId);
    applyOutcome = "accept";

    const readiness = await materializeDeferredBrokerProfiles((m) => logs.push(m), {
      agentsDir,
      readConfig: () => ({ agents: { entries: Object.fromEntries(userAgents.map((id) => [id, { model: "house" }])) } }),
      secretsApply: { apply },
      secretsReload: { secretsReload: reload },
    });

    const appliedAgents = new Set(
      apply.mock.calls.flatMap(([plan]) => (plan as { targets: Array<{ agentId: string }> }).targets.map((t) => t.agentId)),
    );
    expect([...appliedAgents].sort()).toEqual([...userAgents].sort());
    expect(readiness).toMatchObject({ settled: true, deferred: [] });
    expect(logs).toContain("[agent-model-token] post-boot sweep materialized 2 agent(s)");
  });

  it("reloads the active secret snapshot after profiles are accepted", async () => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";

    await sweep();

    expect(reload).toHaveBeenCalledOnce();
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0]);
  });

  it.each([
    { owner: "none", settled: true },
    { owner: "staged", settled: true },
    { owner: "serving", settled: false },
  ])("handles inactive-account warnings with $owner degraded secret owners", async ({ owner, settled }) => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    const staged = "octogee-bravo-coach";
    const owners: DegradedSecretOwner[] = owner === "none" ? [] : [{
      ownerKind: "account",
      ownerId: JSON.stringify([path.join(agentsDir, owner === "staged" ? staged : AGENT, "agent", "openclaw-agent.sqlite"), "anthropic:default"]),
      state: "unavailable", paths: ["profiles.anthropic:default.key"], reason: "secret provider failed",
    }];
    reload.mockResolvedValue({ ok: true, warningCount: 2 + owners.length });
    const scoped = () => materializeDeferredBrokerProfiles((m) => logs.push(m), {
      agentsDir,
      readConfig: () => ({
        agents: { entries: { [AGENT]: {}, [staged]: {} } },
        channels: { mattermost: { accounts: {
          "alice-coach": { enabled: false, botToken: mattermostAccountSecretRef("alice-coach") },
          "alice-proj-orbit": { enabled: false, botToken: mattermostAccountSecretRef("alice-proj-orbit") },
        } } },
      }),
      readAssignedSlugs: async () => ["alice"],
      secretsApply: { apply },
      secretsReload: { secretsReload: reload, degradedSecretsStatus: async () => owners },
    });

    expect((await scoped()).settled).toBe(settled);
    expect((await scoped()).settled).toBe(settled);
    expect(reload).toHaveBeenCalledTimes(settled ? 1 : 2);
  });

  it("shares one in-flight sweep across overlapping startup and retry callers", async () => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    let releaseApply!: () => void;
    const applyBlocked = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    apply = vi.fn(async (plan: Parameters<typeof writeAppliedProfiles>[1]) => {
      await applyBlocked;
      writeAppliedProfiles(agentsDir, plan);
      return { mode: "write", changed: true };
    });

    const startup = sweep();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    const retryTimer = sweep();

    expect(retryTimer).toBe(startup);
    expect(apply).toHaveBeenCalledOnce();

    releaseApply();
    const [startupResult, retryResult] = await Promise.all([startup, retryTimer]);

    expect(startupResult).toBe(retryResult);
    expect(startupResult).toEqual({ settled: true, deferred: [] });
    expect(apply).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();

    const afterSettlement = sweep();
    expect(afterSettlement).not.toBe(startup);
    await expect(afterSettlement).resolves.toEqual({ settled: true, deferred: [] });
  });

  it("clears a failed in-flight sweep so a later caller can retry", async () => {
    const failed = materializeDeferredBrokerProfiles(() => {
      throw new Error("log sink unavailable");
    }, {
      agentsDir,
      readConfig: () => {
        throw new Error("config unavailable");
      },
    });

    await expect(failed).rejects.toThrow("log sink unavailable");

    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    await expect(sweep()).resolves.toEqual({ settled: true, deferred: [] });
    expect(apply).toHaveBeenCalledOnce();
  });

  it("retries a failed snapshot reload after the profile store has settled", async () => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    reloadFails = true;

    await sweep();
    reloadFails = false;
    await sweep();

    expect(apply).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("reports a deferral while openclaw refuses the apply", async () => {
    await sweep();

    expect(logs.some((m) => m.includes("still deferred") && m.includes(AGENT))).toBe(true);
  });

  it("stays quiet while the deferral is unchanged — it runs on a timer", async () => {
    await sweep();
    const afterFirst = logs.length;

    await sweep();
    await sweep();

    expect(logs.length).toBe(afterFirst);
  });

  it("settles on a later pass once openclaw accepts the apply", async () => {
    await sweep();
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    logs = [];

    await sweep();

    expect(logs.some((m) => m.includes("settled"))).toBe(true);
    expect(logs.some((m) => m.includes("still deferred"))).toBe(false);
  });

  it("stops calling the gateway once every profile has settled", async () => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    await sweep();
    const afterFirst = apply.mock.calls.length;

    await sweep();

    expect(apply.mock.calls.length).toBe(afterFirst);
  });

  it("survives an unreadable config rather than killing the timer", async () => {
    await materializeDeferredBrokerProfiles((m) => logs.push(m), {
      agentsDir,
      secretsApply: { apply },
      readConfig: () => {
        throw new Error("config gone");
      },
    });

    expect(logs.some((m) => m.includes("config unreadable"))).toBe(true);
  });
  it("settles Shared readiness for eight staged unassigned Bravo owners without granting their profiles", async () => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    const staged = ["octogee-bravo-coach", "octogee-bravo-proj-timer-coach"];
    const owners = staged.flatMap((agent) => [
      { ownerKind: "capability", ownerId: `memory-provider:${agent}`, state: "unavailable", degradationState: "cold", paths: ["memorySearch.remote.apiKey"], reason: "secret provider failed" },
      ...["anthropic:default", "platform-openrouter:default", "platform-openai:default"].map((profile) => ({
        ownerKind: "account", ownerId: JSON.stringify([path.join(agentsDir, agent, "agent", "openclaw-agent.sqlite"), profile]),
        state: "unavailable", degradationState: "stale", paths: [`profiles.${profile}.key`], reason: "secret provider failed",
      })),
    ]);
    const result = await materializeDeferredBrokerProfiles((m) => logs.push(m), {
      agentsDir,
      readConfig: () => ({ agents: { entries: Object.fromEntries([AGENT, ...staged].map((id) => [id, { model: "house" }])) } }),
      readAssignedSlugs: async () => ["alice"],
      secretsApply: { apply },
      secretsReload: { secretsReload: async () => ({ ok: true, warningCount: 8 }), degradedSecretsStatus: async () => owners },
    });
    expect(result).toEqual({ settled: true, deferred: [] });
    expect(apply.mock.calls.flatMap(([plan]) => plan.targets).every((target) => target.agentId === AGENT)).toBe(true);
    expect(logs.some((m) => m.includes("no blocking owners"))).toBe(true);
  });

  it.each(["serving", "unknown", "wrong-path", "wrong-profile", "wrong-reason", "duplicate"])("keeps %s degraded secret owners blocking", (failure) => {
    const staged = "octogee-bravo-coach";
    const owners: DegradedSecretOwner[] = [{ ownerKind: "account", ownerId: JSON.stringify([path.join(agentsDir, staged, "agent", "openclaw-agent.sqlite"), "anthropic:default"]), state: "unavailable", paths: ["profiles.anthropic:default.key"], reason: "secret provider failed" }];
    const excluded = unassignedConfiguredAgents([AGENT, staged, "octogee-unmatched-route"], ["alice"]);
    if (failure === "serving") owners[0]!.ownerId = JSON.stringify([path.join(agentsDir, AGENT, "agent", "openclaw-agent.sqlite"), "anthropic:default"]);
    if (failure === "unknown") owners[0]!.ownerKind = "gateway";
    if (failure === "wrong-path") owners[0]!.ownerId = JSON.stringify([path.join(agentsDir, staged, "agent", "..", "other.sqlite"), "anthropic:default"]);
    if (failure === "wrong-profile") owners[0]!.ownerId = JSON.stringify([path.join(agentsDir, staged, "agent", "openclaw-agent.sqlite"), "foreign:default"]);
    if (failure === "wrong-reason") owners[0]!.reason = "auth profile migration required";
    if (failure === "duplicate") owners.push(owners[0]!);
    expect(stagedSecretOwnersOnly({ owners, excluded, agentsDir })).toBe(false);
    expect(excluded.has("octogee-unmatched-route")).toBe(false);
  });

  it("rechecks assignment after diagnostics and on later sweeps", async () => {
    seedAgentStore(agentsDir, AGENT);
    const staged = "octogee-bravo-coach";
    seedAgentStore(agentsDir, staged);
    applyOutcome = "accept";
    const readAssignedSlugs = vi.fn().mockResolvedValueOnce(["alice"]).mockResolvedValue(["alice", "bravo"]);
    const scoped = () => materializeDeferredBrokerProfiles((m) => logs.push(m), {
      agentsDir,
      readConfig: () => ({ agents: { entries: { [AGENT]: {}, [staged]: {} } } }),
      readAssignedSlugs,
      secretsApply: { apply },
      secretsReload: {
        secretsReload: async () => ({ ok: true, warningCount: 1 }),
        degradedSecretsStatus: async () => [{ ownerKind: "capability", ownerId: `memory-provider:${staged}`, state: "unavailable", paths: [], reason: "secret provider failed" }],
      },
    });
    expect((await scoped()).settled).toBe(false);
    expect((await scoped()).settled).toBe(false);
    expect(apply.mock.calls.flatMap(([plan]) => plan.targets).some((target) => target.agentId === staged)).toBe(true);
  });

  describe("project accounts the user reconciler retires", () => {
    const retiredAccount = "alice-proj-old";
    const retiredOwner: DegradedSecretOwner = {
      ownerKind: "account", ownerId: `mattermost:${retiredAccount}`, state: "unavailable", degradationState: "cold",
      paths: [`channels.mattermost.accounts.${retiredAccount}.botToken`], reason: "secret reference was not found",
    };
    const userConfig = () => ({
      agents: { entries: { [AGENT]: { model: "house" } } },
      channels: { mattermost: { accounts: { [retiredAccount]: { botToken: mattermostAccountSecretRef(retiredAccount) } } } },
    });
    let openclawDir: string;
    let reloadWithWarning: ReturnType<typeof vi.fn>;
    const scoped = () => materializeDeferredBrokerProfiles((m) => logs.push(m), {
      agentsDir, openclawDir, readConfig: userConfig,
      readAssignedSlugs: async () => ["alice"],
      secretsApply: { apply },
      secretsReload: { secretsReload: reloadWithWarning, degradedSecretsStatus: async () => [retiredOwner] },
    });

    beforeEach(() => {
      openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-bpr-oc-"));
      seedAgentStore(agentsDir, AGENT);
      applyOutcome = "accept";
      reloadWithWarning = vi.fn(async () => ({ ok: true, warningCount: 1 }));
    });
    afterEach(() => {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    });

    it("settles once instead of reloading every 20s while a retired project account still names a missing secret", async () => {
      expect(await scoped()).toEqual({ settled: true, deferred: [] });
      expect(await scoped()).toEqual({ settled: true, deferred: [] });
      expect(reloadWithWarning).toHaveBeenCalledOnce();
      expect(logs.some((m) => m.includes(retiredAccount))).toBe(true);
    });

    it("keeps the warning blocking once that account's secret is materialized", async () => {
      await updateMattermostAccountSecrets(openclawDir, { set: { [retiredAccount]: "old-pat" } });
      expect((await scoped()).settled).toBe(false);
      expect((await scoped()).settled).toBe(false);
    });

    it("keeps a project account of an unassigned slug or a foreign owner blocking", () => {
      const excluded = unassignedConfiguredAgents([AGENT], ["alice"]);
      const unmaterializedProjectAccountIds = new Set([retiredAccount]);
      expect(stagedSecretOwnersOnly({ owners: [retiredOwner], excluded, agentsDir, unmaterializedProjectAccountIds })).toBe(true);
      expect(stagedSecretOwnersOnly({ owners: [retiredOwner], excluded, agentsDir })).toBe(false);
      expect(stagedSecretOwnersOnly({ owners: [{ ...retiredOwner, ownerId: "mattermost:bravo-proj-old" }], excluded, agentsDir, unmaterializedProjectAccountIds })).toBe(false);
      expect(stagedSecretOwnersOnly({ owners: [{ ...retiredOwner, ownerKind: "route" }], excluded, agentsDir, unmaterializedProjectAccountIds })).toBe(false);
      expect(stagedSecretOwnersOnly({ owners: [retiredOwner, retiredOwner], excluded, agentsDir, unmaterializedProjectAccountIds })).toBe(false);
    });
  });

  describe("broker profile roster per gateway class", () => {
    afterEach(() => clearUserClaim());

    it("reads the Shared assignment roster and the user's claimed slug, and an empty roster before a claim", async () => {
      const readDesiredSlugs = async () => ["alice", "bravo"];
      await expect(brokerProfileRoster({ gatewayId: "shared-a", readDesiredSlugs })!()).resolves.toEqual(["alice", "bravo"]);
      const user = brokerProfileRoster({ gatewayId: "alice-s-abc", readDesiredSlugs })!;
      await expect(user()).resolves.toEqual([]);
      stubUserClaim("alice");
      await expect(user()).resolves.toEqual(["alice"]);
    });
  });

  it("retains strict warning refusal without a Shared assignment reader", async () => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    reload.mockResolvedValue({ ok: true, warningCount: 8 });
    expect((await sweep()).settled).toBe(false);
  });

  it("does not reload unchanged settled Shared profiles but reloads a changed assignment", async () => {
    seedAgentStore(agentsDir, AGENT);
    applyOutcome = "accept";
    let assigned = ["alice"];
    const scoped = () => materializeDeferredBrokerProfiles(() => {}, {
      agentsDir, readConfig, readAssignedSlugs: async () => assigned,
      secretsApply: { apply }, secretsReload: { secretsReload: reload },
    });
    expect((await scoped()).settled).toBe(true);
    expect((await scoped()).settled).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    assigned = ["alice", "bravo"];
    expect((await scoped()).settled).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("recognizes the four staged project owners observed in c0 status", () => {
    const owners: DegradedSecretOwner[] = [
  {
    "ownerKind": "capability",
    "ownerId": "memory-provider:octogee-bravo-proj-timer-coach",
    "state": "unavailable",
    "degradationState": "cold",
    "paths": [
      "agents.entries.octogee-bravo-proj-timer-coach.memory.search.remote.apiKey"
    ],
    "reason": "secret provider failed"
  },
  {
    "ownerKind": "account",
    "ownerId": "[\"/home/node/.openclaw/agents/octogee-bravo-proj-timer-coach/agent/openclaw-agent.sqlite\",\"anthropic:default\"]",
    "state": "unavailable",
    "degradationState": "cold",
    "paths": [
      "/home/node/.openclaw/agents/octogee-bravo-proj-timer-coach/agent.auth-profiles.anthropic:default.key"
    ],
    "reason": "secret provider failed"
  },
  {
    "ownerKind": "account",
    "ownerId": "[\"/home/node/.openclaw/agents/octogee-bravo-proj-timer-coach/agent/openclaw-agent.sqlite\",\"platform-openrouter:default\"]",
    "state": "unavailable",
    "degradationState": "cold",
    "paths": [
      "/home/node/.openclaw/agents/octogee-bravo-proj-timer-coach/agent.auth-profiles.platform-openrouter:default.key"
    ],
    "reason": "secret provider failed"
  },
  {
    "ownerKind": "account",
    "ownerId": "[\"/home/node/.openclaw/agents/octogee-bravo-proj-timer-coach/agent/openclaw-agent.sqlite\",\"platform-openai:default\"]",
    "state": "unavailable",
    "degradationState": "stale",
    "paths": [
      "/home/node/.openclaw/agents/octogee-bravo-proj-timer-coach/agent.auth-profiles.platform-openai:default.key"
    ],
    "reason": "secret provider failed"
  }
];
    expect(stagedSecretOwnersOnly({
      owners,
      agentsDir: "/home/node/.openclaw/agents",
      excluded: unassignedConfiguredAgents(["octogee-bravo-proj-timer-coach"], ["charlie"]),
    })).toBe(true);
  });

});
