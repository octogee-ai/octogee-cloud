import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installDefaultUserEntitlements } from "@octogee/shared/types/user-entitlements";
import type { UserProvisioningStatus } from "@octogee/shared/types/provisioning-service";
import { startFakeProvisioningService, type FakeProvisioningService } from "./fixtures/provisioning-service-fake.js";
import { operationAuditDocumentId } from "./operation-audit.js";
import { createHarness, dsn, type PlatformStateHarness } from "./platform-state/postgres/__tests__/fixtures/harness.js";
import { createProvisioningServiceClient } from "./provisioning-service-client.js";
import { mirrorUserProvisioning } from "./provisioning-mirror.js";
import {
  createProvisioningSync,
  PROVISIONING_SPEC_BACKFILL_KEY,
  runJournaledBackfill,
  type ProvisioningSync,
} from "./provisioning-sync.js";
import { noProvisioningProjection, type ProvisioningProjection } from "./provisionSteps.js";

type Data = Record<string, unknown>;

const NOW = Date.parse("2026-11-15T18:00:00Z");

const ACCOUNTS: Record<string, Data> = {
  u1: { username: "lin", email: "lin@example.test", displayName: "Lin Wu" },
  u2: { username: "ada", email: "ada@example.test" },
};

const CHAT_READY: Partial<UserProvisioningStatus> = {
  observedGeneration: 1,
  conditions: [
    { type: "ChatReady", status: "True", reason: "Converged", message: "", lastTransitionTime: "2026-11-15T18:00:00Z", observedGeneration: 1 },
    { type: "CredentialsIssued", status: "True", reason: "Converged", message: "", lastTransitionTime: "2026-11-15T18:00:00Z", observedGeneration: 1 },
    { type: "Ready", status: "False", reason: "GitNotReady", message: "", lastTransitionTime: "2026-11-15T18:00:00Z", observedGeneration: 1 },
  ],
  outputs: {
    chat: { userId: "mm-user", teamId: "mm-team", channels: { general: "ch-general", agent: "ch-agent" }, agentBotUserId: "mm-bot" },
    credentials: ["agent-chat-token", "user-chat-token"],
  },
};

describe.skipIf(!dsn)("provisioning spec writer, backfill and mirror on PostgreSQL", () => {
  let harness: PlatformStateHarness;
  let fake: FakeProvisioningService;
  let projectionCalls: string[];
  let logs: string[];
  const stoppers: Array<() => void> = [];

  function recordingProjection(): ProvisioningProjection {
    const record = (name: string) => async () => {
      projectionCalls.push(name);
    };
    return {
      ...noProvisioningProjection,
      systemConfig: record("systemConfig"),
      user: record("user"),
      workspace: record("workspace"),
      channel: record("channel"),
      agent: record("agent"),
      workspaceEntry: record("workspaceEntry"),
    };
  }

  const client = () => createProvisioningServiceClient({
    baseUrl: fake.url,
    tokenPath: "/token",
    readToken: async () => "token",
    retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
  });

  function started(): ProvisioningSync {
    const instance = createProvisioningSync({
      store: harness.store,
      client: client(),
      documents: { account: async (uid) => ACCOUNTS[uid] },
      projection: recordingProjection(),
      proxyUrl: null,
      log: (message) => logs.push(message),
      watchTimeoutSeconds: 1,
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
    });
    stoppers.push(instance.start());
    return instance;
  }

  async function admit(uid: string, slug: string): Promise<void> {
    await harness.store.users.records.create({ uid, createdAt: NOW });
    await harness.store.users.records.admit(uid, { slug, persona: { vibe: "calm" }, createdAt: NOW, provisioningStartedAt: NOW });
  }

  async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 500 && !(await condition()); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await condition()).toBe(true);
  }

  const audit = () => harness.store.journal.audits.get(operationAuditDocumentId(PROVISIONING_SPEC_BACKFILL_KEY));
  const puts = () => fake.requests.filter((request) => request.method === "PUT");

  beforeAll(() => {
    installDefaultUserEntitlements();
  });

  beforeEach(async () => {
    harness = await createHarness();
    fake = await startFakeProvisioningService();
    projectionCalls = [];
    logs = [];
  });

  afterEach(async () => {
    for (const stop of stoppers.splice(0)) stop();
    await fake.close();
    await harness.dispose();
  });

  it("writes a spec for every admitted user, journals the backfill once and writes nothing on a restart", async () => {
    await admit("u1", "lin");
    await admit("u2", "ada");
    await harness.store.users.records.create({ uid: "u3", createdAt: NOW });

    const first = started();
    await first.snapshotLoaded();
    await until(async () => (await audit())?.status === "completed");
    const journaled = await audit();
    const written = puts().length;

    const second = started();
    await second.snapshotLoaded();
    await until(() => logs.filter((line) => line.includes("spec backfill finished")).length === 2);

    expect(puts().slice(0, written).map((request) => request.path).sort()).toEqual(["/v1/users/u1/provisioning", "/v1/users/u2/provisioning"]);
    expect(fake.resources.get("u1")?.spec).toMatchObject({ slug: "lin", agentIds: ["octogee-lin-coach"] });
    expect(puts().length).toBe(written);
    expect(await audit()).toEqual(journaled);
    expect(logs.at(-1)).toContain("spec backfill finished: 2 admitted users, 0 written, 2 unchanged");
  });

  it("writes the spec of a user admitted after the fleet controller started", async () => {
    const instance = started();
    await instance.snapshotLoaded();

    await admit("u1", "lin");

    await until(() => fake.resources.has("u1"));
    expect(instance.counters.specWrites.created).toBe(1);
  });

  it("resumes a backfill a previous fleet controller left in progress", async () => {
    await admit("u1", "lin");
    let resolveHang: () => void = () => undefined;
    const interrupted = runJournaledBackfill(harness.store, () => new Promise<void>((resolve) => {
      resolveHang = resolve;
    }));
    await until(async () => (await audit())?.status === "in-progress");

    const resumed = await runJournaledBackfill(harness.openStore(), async () => "done");
    resolveHang();
    await interrupted.catch(() => undefined);

    expect(resumed).toEqual({ journaled: true, result: "done" });
    expect(await audit()).toMatchObject({ status: "completed", actionRecoveryCount: 1 });
  });

  it("mirrors chat results in today's shapes, leaves the readiness fields alone and writes nothing the second time", async () => {
    await admit("u1", "lin");
    const instance = started();
    await instance.snapshotLoaded();
    await until(() => fake.resources.has("u1"));

    fake.issueCredential("u1", "user-chat-token", "user-token-pg");
    fake.issueCredential("u1", "agent-chat-token", "agent-token-pg");
    fake.setStatus("u1", CHAT_READY);
    await until(() => instance.counters.mirrors.written === 1);

    const user = await harness.store.users.records.get("u1");
    expect(user).toMatchObject({
      mattermostUserId: "mm-user",
      workspaceId: "lin",
      agents: { agentIds: ["octogee-lin-coach"] },
    });
    expect(user?.provisioning.status).toBe("in_progress");
    expect(user?.openclaw.status).toBeUndefined();
    expect(await harness.store.workspaces.records.get("lin")).toMatchObject({ ownerUid: "u1", mattermostTeamId: "mm-team" });
    const scope = { workspaceSlug: "lin", projectSlug: null };
    expect(await harness.store.workspaces.channels.get(scope, "general")).toMatchObject({ mattermostChannelId: "ch-general" });
    expect(await harness.store.workspaces.channels.get(scope, "coach-dm")).toMatchObject({ mattermostChannelId: "ch-agent" });
    expect(await harness.store.workspaces.agentIdentities.get("u1")).toMatchObject({ mattermostUserId: "mm-bot" });
    expect(projectionCalls).toEqual(["systemConfig", "user", "workspace", "channel", "channel", "agent", "workspaceEntry"]);
    expect(await harness.store.secrets.get("u1", "mattermost")).toMatchObject({ kind: "builder-mattermost", personalToken: "user-token-pg", mattermostUserId: "mm-user", projectId: null, rotatedAt: null });
    expect(await harness.store.secrets.get("u1", "coachMattermost")).toMatchObject({ kind: "coach-mattermost", personalToken: "agent-token-pg", mattermostUserId: "mm-bot" });

    projectionCalls = [];
    const again = await mirrorUserProvisioning(
      { store: harness.store, client: client(), documents: { account: async (uid) => ACCOUNTS[uid] }, projection: recordingProjection(), proxyUrl: null },
      fake.resources.get("u1")!,
    );

    expect(again).toBe("unchanged");
    expect(projectionCalls).toEqual([]);
  });
});
