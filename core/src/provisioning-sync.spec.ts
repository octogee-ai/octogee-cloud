import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { installDefaultUserEntitlements } from "@octogee/shared/types/user-entitlements";
import type { UserProvisioning, UserProvisioningStatus } from "@octogee/shared/types/provisioning-service";
import { startFakeProvisioningService, type FakeProvisioningService } from "./fixtures/provisioning-service-fake.js";
import { operationAuditDocumentId } from "./operation-audit.js";
import { MalformedRecordError } from "./platform-state/errors.js";
import type { PlatformStateStore } from "./platform-state/store.js";
import { createProvisioningServiceClient } from "./provisioning-service-client.js";
import { mirrorUserProvisioning } from "./provisioning-mirror.js";
import { desiredUserProvisioningSpec } from "./provisioning-spec.js";
import {
  createProvisioningSync,
  markCloudTeardown,
  PROVISIONING_SPEC_BACKFILL_KEY,
  PROVISIONING_SYNC_RESYNC_MS,
  runJournaledBackfill,
  type ProvisioningSync,
} from "./provisioning-sync.js";
import { noProvisioningProjection, type ProvisioningProjection } from "./provisionSteps.js";
import { mintAndPersistDefaultAgentToken } from "./mattermost/default-agent-pat.js";
import { persistUserToken } from "./mattermost/provision.js";
import type { UserSecretInput } from "./platform-state/secrets.js";

type Data = Record<string, unknown>;

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

const USER_TOKEN = "user-token-6f1d8a";
const AGENT_TOKEN = "agent-token-93c2b7";

let records: Map<string, Data>;
let fake: FakeProvisioningService;
let projectionCalls: string[];
let transactions: string[];
let logs: string[];
let secretPuts: UserSecretInput[];
let watchers: Array<{ aggregate: string; listener: { onEvent: (event: unknown) => void } }>;
let secretPutFailure: boolean;
let unreadableUsers: Set<string>;
const stoppers: Array<() => void> = [];

function seedUser(uid: string, slug: string, admitted = true): void {
  records.set(`users/${uid}`, {
    username: slug,
    ...(admitted ? { onboardingStep: "complete" } : {}),
    provisioning: { status: "in_progress" },
  });
}

function store(): PlatformStateStore {
  const fixture = createDocumentFixtureStore(records, {
    serializeTransactions: true,
    beforeTransaction: (label) => transactions.push(label),
  });
  const recordingSecrets = (transaction: Parameters<Parameters<PlatformStateStore["transaction"]>[1]>[0]) => new Proxy(transaction, {
    get(target, property, receiver) {
      if (property !== "secrets") return Reflect.get(target, property, receiver);
      return {
        ...target.secrets,
        put: async (uid: string, row: UserSecretInput) => {
          if (secretPutFailure) throw new Error(`database refused row ${JSON.stringify(row)}`);
          secretPuts.push(row);
          await target.secrets.put(uid, row);
        },
      };
    },
  });
  return new Proxy(fixture, {
    get(target, property, receiver) {
      if (property === "watch") {
        return (request: { aggregate: string }, listener: { onEvent: (event: unknown) => void }) => {
          watchers.push({ aggregate: request.aggregate, listener });
          return { closed: Promise.resolve(), close: async () => undefined };
        };
      }
      if (property === "users") {
        const users = target.users;
        const unreadable = (uid: string) => new MalformedRecordError({ aggregate: "builder", key: uid }, "does not decode");
        return {
          ...users,
          records: new Proxy(users.records, {
            get(recordsTarget, method, recordsReceiver) {
              if (method === "get") {
                return async (uid: string) => {
                  if (unreadableUsers.has(uid)) throw unreadable(uid);
                  return recordsTarget.get(uid);
                };
              }
              if (method === "getMany") {
                return async (uids: readonly string[]) => {
                  const bad = uids.find((uid) => unreadableUsers.has(uid));
                  if (bad !== undefined) throw unreadable(bad);
                  return recordsTarget.getMany(uids);
                };
              }
              return Reflect.get(recordsTarget, method, recordsReceiver);
            },
          }),
        };
      }
      if (property === "transaction") {
        return (options: Parameters<PlatformStateStore["transaction"]>[0], body: Parameters<PlatformStateStore["transaction"]>[1]) =>
          target.transaction(options, (transaction) => body(recordingSecrets(transaction)));
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function client() {
  return createProvisioningServiceClient({ baseUrl: fake.url, tokenPath: "/token", readToken: async () => "token", retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 } });
}

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

function sync(): ProvisioningSync {
  return createProvisioningSync({
    store: store(),
    client: client(),
    documents: { account: async (uid) => ACCOUNTS[uid] },
    projection: recordingProjection(),
    proxyUrl: null,
    log: (message) => logs.push(message),
    watchTimeoutSeconds: 1,
    retry: { baseDelayMs: 1, maxDelayMs: 2 },
  });
}

function started(instance: ProvisioningSync): ProvisioningSync {
  stoppers.push(instance.start());
  return instance;
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
}

async function chatReadyUser(): Promise<ProvisioningSync> {
  seedUser("u1", "lin");
  const instance = started(sync());
  await instance.snapshotLoaded();
  await until(() => fake.resources.has("u1"));
  fake.issueCredential("u1", "user-chat-token", USER_TOKEN);
  fake.issueCredential("u1", "agent-chat-token", AGENT_TOKEN);
  fake.setStatus("u1", CHAT_READY);
  await until(() => instance.counters.mirrors.written === 1);
  return instance;
}

async function emitBuilders(changes: Array<{ type: "added" | "modified" | "removed"; key: string }>): Promise<void> {
  const fixture = store();
  const resolved = await Promise.all(changes.map(async (change) => ({
    ...change,
    record: change.type === "removed" ? null : await fixture.users.records.get(change.key),
  })));
  for (const watcher of watchers.filter((candidate) => candidate.aggregate === "builders")) {
    watcher.listener.onEvent({ kind: "changes", changes: resolved, cursor: "c" });
  }
}

async function deleteUser(uid: string): Promise<void> {
  await store().users.records.delete(uid);
  await emitBuilders([{ type: "removed", key: uid }]);
}

const puts = () => fake.requests.filter((request) => request.method === "PUT");
const audit = () => records.get(`glmOperations/${operationAuditDocumentId(PROVISIONING_SPEC_BACKFILL_KEY)}`);

beforeAll(() => {
  installDefaultUserEntitlements();
});

beforeEach(async () => {
  records = new Map();
  fake = await startFakeProvisioningService();
  projectionCalls = [];
  transactions = [];
  logs = [];
  secretPuts = [];
  secretPutFailure = false;
  unreadableUsers = new Set();
  watchers = [];
});

afterEach(async () => {
  for (const stop of stoppers.splice(0)) stop();
  await fake.close();
});

describe("desired provisioning spec", () => {
  it("carries what the chat user input and provisioning context take today", () => {
    expect(desiredUserProvisioningSpec("u1", { ...ACCOUNTS.u1, photoURL: "https://img.example/a.png", onboarding: { vibe: "studio" } })).toEqual({
      slug: "lin",
      displayName: { first: "lin", last: "Wu" },
      email: "lin@example.test",
      avatarUrl: "https://img.example/a.png",
      chat: { teamDisplayName: expect.any(String), defaultAgent: { enabled: true } },
      git: { repositories: ["workspace", "project-coaches"], systemConfigRepository: true },
      agentIds: ["octogee-lin-coach"],
    });
  });

  it("refuses a user without a valid name", () => {
    expect(() => desiredUserProvisioningSpec("u9", { email: "x@example.test" })).toThrow(/username/);
  });
});

describe("spec backfill", () => {
  it("writes a spec for every admitted user on the first start and journals it once", async () => {
    seedUser("u1", "lin");
    seedUser("u2", "ada");
    seedUser("u3", "pending", false);

    const first = started(sync());
    await first.snapshotLoaded();
    await until(() => audit()?.status === "completed");

    expect(puts().map((request) => request.path).sort()).toEqual(["/v1/users/u1/provisioning", "/v1/users/u2/provisioning"]);
    expect(fake.resources.get("u1")?.spec.slug).toBe("lin");
    expect(logs.some((line) => line.includes("journaled: 2 admitted users, 2 written, 0 unchanged"))).toBe(true);
  });

  it("writes nothing and journals nothing on a restart when every spec is current", async () => {
    seedUser("u1", "lin");
    const first = started(sync());
    await first.snapshotLoaded();
    await until(() => audit()?.status === "completed");
    const auditBefore = structuredClone(audit());
    const putsBefore = puts().length;

    const second = started(sync());
    await second.snapshotLoaded();
    await until(() => logs.filter((line) => line.includes("spec backfill finished")).length === 2);

    expect(puts().length).toBe(putsBefore);
    expect(audit()).toEqual(auditBefore);
    expect(logs.at(-1)).toContain("spec backfill finished: 1 admitted users, 0 written, 1 unchanged");
  });

  it("resumes a backfill a previous fleet controller left in progress", async () => {
    seedUser("u1", "lin");
    let resolveHang: () => void = () => undefined;
    const interrupted = runJournaledBackfill(store(), () => new Promise<void>((resolve) => {
      resolveHang = resolve;
    }));
    await until(() => audit()?.status === "in-progress");

    const resumed = await runJournaledBackfill(store(), async () => "done");
    resolveHang();
    await interrupted.catch(() => undefined);

    expect(resumed).toEqual({ journaled: true, result: "done" });
    expect(audit()).toMatchObject({ status: "completed", actionRecoveryCount: 1 });
  });

  it("keeps retrying while the service is unavailable and never throws", async () => {
    const instance = started(sync());
    await instance.snapshotLoaded();
    seedUser("u1", "lin");
    fake.failNext(503, 6);
    instance.markDirty("u1");
    await until(() => fake.resources.has("u1"));

    expect(instance.counters.specWrites.failed).toBeGreaterThan(0);
    expect(logs.some((line) => line.includes("could not write the spec of u1"))).toBe(true);
  });

  it("does not write a spec for a user who is not admitted", async () => {
    seedUser("u3", "pending", false);

    await expect(sync().writeSpec("u3")).resolves.toBe("not-admitted");
    expect(puts()).toEqual([]);
  });
});

describe("provisioning mirror", () => {

  it("mirrors chat results into the user and workspace records in today's shapes and calls the product projection", async () => {
    await chatReadyUser();

    const s = store();
    expect(await s.users.records.get("u1")).toMatchObject({
      mattermostUserId: "mm-user",
      workspaceId: "lin",
      agents: { agentIds: ["octogee-lin-coach"], activatedAgents: ["coach"] },
    });
    expect(await s.workspaces.records.get("lin")).toMatchObject({ ownerUid: "u1", mattermostTeamId: "mm-team", giteaOrgName: "lin" });
    expect(await s.workspaces.channels.get({ workspaceSlug: "lin", projectSlug: null }, "general")).toMatchObject({ mattermostChannelId: "ch-general" });
    expect(await s.workspaces.channels.get({ workspaceSlug: "lin", projectSlug: null }, "coach-dm")).toMatchObject({ mattermostChannelId: "ch-agent" });
    expect(await s.workspaces.agentIdentities.get("u1")).toMatchObject({ mattermostUserId: "mm-bot" });
    expect(projectionCalls).toEqual(["systemConfig", "user", "workspace", "channel", "channel", "agent", "workspaceEntry"]);
  });

  it("leaves the readiness fields the gateway reports exactly as they were, through the default projection", async () => {
    seedUser("u1", "lin");
    await store().users.records.patch("u1", { openclaw: { status: "complete" }, provisioning: { status: "complete" } });
    const instance = createProvisioningSync({
      store: store(),
      client: client(),
      documents: { account: async (uid) => ACCOUNTS[uid] },
      projection: noProvisioningProjection,
      proxyUrl: null,
      log: (message) => logs.push(message),
      watchTimeoutSeconds: 1,
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
    });
    stoppers.push(instance.start());
    await instance.snapshotLoaded();
    await until(() => fake.resources.has("u1"));
    fake.issueCredential("u1", "user-chat-token", USER_TOKEN);
    fake.issueCredential("u1", "agent-chat-token", AGENT_TOKEN);
    fake.setStatus("u1", CHAT_READY);
    await until(() => instance.counters.mirrors.written === 1);

    const user = await store().users.records.get("u1");
    expect(user?.mattermostUserId).toBe("mm-user");
    expect(user?.openclaw.status).toBe("complete");
    expect(user?.provisioning.status).toBe("complete");
  });

  it("writes nothing and projects nothing when the records already match", async () => {
    await chatReadyUser();
    const resource = fake.resources.get("u1")!;
    projectionCalls = [];
    transactions = [];

    const requestsBefore = fake.requests.length;

    const outcome = await mirrorUserProvisioning({
      store: store(),
      client: client(),
      documents: { account: async (uid) => ACCOUNTS[uid] },
      projection: recordingProjection(),
      proxyUrl: null,
    }, resource);

    expect(outcome).toBe("unchanged");
    expect(projectionCalls).toEqual([]);
    expect(transactions).toEqual([]);
    expect(fake.requests.slice(requestsBefore)).toEqual([]);
  });

  it("waits for ChatReady before mirroring", async () => {
    seedUser("u1", "lin");
    const instance = started(sync());
    await instance.snapshotLoaded();
    await until(() => fake.resources.has("u1"));
    fake.setStatus("u1", { observedGeneration: 1 });
    await until(() => instance.counters.mirrors["chat-not-ready"] >= 1);

    expect((await store().users.records.get("u1"))?.mattermostUserId).toBeNull();
  });

  it("answers each user's Ready condition for the fleet state", async () => {
    const instance = await chatReadyUser();

    expect(instance.readiness("u1")).toEqual({ status: "False", reason: "GitNotReady" });
    expect(instance.readiness("unknown")).toBeNull();
  });
});

describe("platform chat secrets", () => {
  const secretRow = (secretId: string) => records.get(`users/u1/secrets/${secretId}`);

  async function chatReadyWithoutWaiting(credentialsIssued = true): Promise<ProvisioningSync> {
    seedUser("u1", "lin");
    const instance = started(sync());
    await instance.snapshotLoaded();
    await until(() => fake.resources.has("u1"));
    if (credentialsIssued) {
      fake.issueCredential("u1", "user-chat-token", USER_TOKEN);
      fake.issueCredential("u1", "agent-chat-token", AGENT_TOKEN);
    }
    return instance;
  }

  const leakedTokens = () => logs.filter((line) => line.includes(USER_TOKEN) || line.includes(AGENT_TOKEN));

  it("writes both secrets in exactly the rows the legacy chat provisioning writes", async () => {
    const legacy: UserSecretInput[] = [];
    const legacySecrets = { put: async (_uid: string, row: UserSecretInput) => { legacy.push(row); } };
    await persistUserToken(legacySecrets, "u1", "mm-user", USER_TOKEN);
    await mintAndPersistDefaultAgentToken(
      { channelHost: { revokeTokens: async () => [], issueToken: async () => AGENT_TOKEN }, secrets: legacySecrets, now: () => ({ serverNow: true }) },
      "u1",
      "mm-bot",
    );

    await chatReadyUser();

    expect(secretPuts).toEqual(legacy);
  });

  it("writes the secrets before any mirrored record", async () => {
    const instance = await chatReadyWithoutWaiting();
    transactions = [];
    fake.setStatus("u1", CHAT_READY);
    await until(() => instance.counters.mirrors.written === 1);

    expect(transactions.slice(0, 2)).toEqual(["provisioning-mirror-chat-secret", "provisioning-mirror-chat-secret"]);
    expect(transactions.length).toBeGreaterThan(2);
  });

  it("never overwrites a platform secret that already exists", async () => {
    await store().secrets.put("u1", { kind: "builder-mattermost", secretId: "mattermost", projectId: null, personalToken: "older-user-token", mattermostUserId: "mm-user", createdAt: 1, rotatedAt: null });
    await store().secrets.put("u1", { kind: "coach-mattermost", secretId: "coachMattermost", projectId: null, personalToken: "older-agent-token", mattermostUserId: "mm-bot", createdAt: 1, rotatedAt: null });

    await chatReadyUser();

    expect(secretRow("mattermost")).toMatchObject({ personalToken: "older-user-token" });
    expect(secretRow("coachMattermost")).toMatchObject({ personalToken: "older-agent-token" });
    expect(fake.requests.some((request) => request.path.includes("/credentials/"))).toBe(false);
    expect(secretPuts).toEqual([]);
  });

  it("mirrors nothing while the credentials are not issued", async () => {
    const instance = await chatReadyWithoutWaiting(false);
    fake.setStatus("u1", { ...CHAT_READY, conditions: CHAT_READY.conditions!.map((condition) =>
      condition.type === "CredentialsIssued" ? { ...condition, status: "False", reason: "CredentialsNotIssued" } : condition) });
    await until(() => instance.counters.mirrors["credentials-not-issued"] >= 1);

    expect((await store().users.records.get("u1"))?.mattermostUserId).toBeNull();
    expect(projectionCalls).toEqual([]);
  });

  it("mirrors no ids while the credentials are not issued, even when both platform secrets already exist", async () => {
    await store().secrets.put("u1", { kind: "builder-mattermost", secretId: "mattermost", projectId: null, personalToken: "older-user-token", mattermostUserId: "mm-user", createdAt: 1, rotatedAt: null });
    await store().secrets.put("u1", { kind: "coach-mattermost", secretId: "coachMattermost", projectId: null, personalToken: "older-agent-token", mattermostUserId: "mm-bot", createdAt: 1, rotatedAt: null });
    const instance = await chatReadyWithoutWaiting(false);
    fake.setStatus("u1", { ...CHAT_READY, conditions: CHAT_READY.conditions!.map((condition) =>
      condition.type === "CredentialsIssued" ? { ...condition, status: "False", reason: "CredentialsNotIssued" } : condition) });
    await until(() => instance.counters.mirrors["credentials-not-issued"] >= 1);

    expect((await store().users.records.get("u1"))?.mattermostUserId).toBeNull();
    expect(projectionCalls).toEqual([]);
  });

  it("mirrors nothing while the default agent the spec enables has no chat account", async () => {
    const instance = await chatReadyWithoutWaiting();
    const { agentBotUserId: _agentBotUserId, ...chatWithoutAgent } = CHAT_READY.outputs!.chat!;
    fake.setStatus("u1", { ...CHAT_READY, outputs: { ...CHAT_READY.outputs!, chat: chatWithoutAgent } });
    await until(() => instance.counters.mirrors["agent-not-ready"] >= 1);

    expect(secretPuts).toEqual([]);
    expect((await store().users.records.get("u1"))?.mattermostUserId).toBeNull();
    expect(projectionCalls).toEqual([]);
  });

  it("mirrors nothing and reports the user when the service names a different chat account than the user record holds", async () => {
    records.set("users/u1", { username: "lin", onboardingStep: "complete", provisioning: { status: "in_progress" }, mattermost: { userId: "mm-earlier" } });
    const instance = started(sync());
    await instance.snapshotLoaded();
    await until(() => fake.resources.has("u1"));
    fake.issueCredential("u1", "user-chat-token", USER_TOKEN);
    fake.issueCredential("u1", "agent-chat-token", AGENT_TOKEN);
    fake.setStatus("u1", CHAT_READY);
    await until(() => instance.counters.mirrors["chat-id-mismatch"] >= 1);

    expect(secretPuts).toEqual([]);
    expect(fake.requests.some((request) => request.path.includes("/credentials/"))).toBe(false);
    expect((await store().users.records.get("u1"))?.mattermostUserId).toBe("mm-earlier");
    expect(projectionCalls).toEqual([]);
    expect(logs.some((line) => line.includes("❌ not mirroring u1") && line.includes("mm-earlier") && line.includes("mm-user"))).toBe(true);
    expect(instance.mirrorRefusals()).toEqual([expect.objectContaining({ uid: "u1", outcome: "chat-id-mismatch", reason: expect.stringContaining("mm-earlier") })]);
  });

  it("leaves the user record untouched and logs no token when a secret write fails", async () => {
    secretPutFailure = true;
    const instance = await chatReadyWithoutWaiting();
    fake.setStatus("u1", CHAT_READY);
    await until(() => instance.counters.mirrors.failed >= 2);

    expect((await store().users.records.get("u1"))?.mattermostUserId).toBeNull();
    expect(await store().workspaces.records.get("lin")).toBeNull();
    expect(projectionCalls).toEqual([]);
    expect(logs.some((line) => line.includes("could not write the mattermost platform secret of u1"))).toBe(true);
    expect(leakedTokens()).toEqual([]);
  });

  it("retries with backoff while the service refuses the credential read, then mirrors", async () => {
    fake.credentialReader = false;
    const instance = await chatReadyWithoutWaiting();
    fake.setStatus("u1", CHAT_READY);
    await until(() => instance.counters.mirrors.failed >= 2);

    expect((await store().users.records.get("u1"))?.mattermostUserId).toBeNull();
    expect(logs.some((line) => line.includes("needs the credential-reader role"))).toBe(true);

    fake.credentialReader = true;
    await until(() => instance.counters.mirrors.written === 1);
    expect(secretRow("mattermost")).toMatchObject({ personalToken: USER_TOKEN });
    expect(leakedTokens()).toEqual([]);
  });
});

describe("a cloud teardown of a user not scheduled for deletion", () => {
  it("writes no spec while the teardown runs or after it, until the user is explicitly re-admitted", async () => {
    const instance = await chatReadyUser();
    const putsBefore = puts().length;

    await markCloudTeardown(store(), "u1");
    await expect(client().deleteProvisioning("u1")).resolves.toBe("deleted");
    await until(() => instance.observed("u1") === undefined && instance.counters.specWrites["being-erased"] >= 1);
    await emitBuilders([{ type: "modified", key: "u1" }]);
    await instance.resync();
    await until(() => instance.counters.specWrites["being-erased"] >= 2);
    const putsDuringTeardown = puts().length;

    await store().users.records.patch("u1", { accountLifecycle: { status: "active" } });
    await emitBuilders([{ type: "modified", key: "u1" }]);
    await until(() => fake.resources.has("u1"));

    expect(putsDuringTeardown).toBe(putsBefore);
    expect(puts()).toHaveLength(putsBefore + 1);
  });

  it("keeps a scheduled deletion's id and erase time when it marks the teardown", async () => {
    seedUser("u1", "lin");
    const scheduled = { status: "deletion_scheduled" as const, deletionId: "d1", suspendedAt: 1, eraseAfter: 2 };
    await store().users.records.patch("u1", { accountLifecycle: scheduled });

    await markCloudTeardown(store(), "u1");

    expect((await store().users.records.get("u1"))?.accountLifecycle).toEqual({ ...scheduled, status: "erasing" });
  });

  it("marks nothing for a user whose record is already gone", async () => {
    await expect(markCloudTeardown(store(), "u-gone")).resolves.toBe("absent");
  });
});

describe("users being erased", () => {
  const scheduledDeletion = { status: "deletion_scheduled" as const, deletionId: "d1", suspendedAt: 1, eraseAfter: 2 };

  it("writes no spec after erasure deletes the provisioning, and nothing once the record is gone", async () => {
    const instance = await chatReadyUser();
    await store().users.records.patch("u1", { accountLifecycle: scheduledDeletion });

    await expect(client().deleteProvisioning("u1")).resolves.toBe("deleted");
    const putsAfterDelete = puts().length;
    await until(() => instance.observed("u1") === undefined && instance.counters.specWrites["being-erased"] >= 1);
    await instance.resync();
    await until(() => instance.counters.specWrites["being-erased"] >= 2);
    await store().users.records.delete("u1");
    await emitBuilders([{ type: "removed", key: "u1" }]);
    await instance.resync();
    await until(() => instance.counters.deletes.deleted === 1);

    expect(puts().length).toBe(putsAfterDelete);
    expect(fake.resources.has("u1")).toBe(false);
  });

  it("keeps a removed hint from re-provisioning a user being erased", async () => {
    const instance = await chatReadyUser();
    await store().users.records.patch("u1", { accountLifecycle: scheduledDeletion });
    await client().deleteProvisioning("u1");
    await until(() => instance.observed("u1") === undefined);
    const putsAfterDelete = puts().length;

    await emitBuilders([{ type: "removed", key: "u1" }]);
    await until(() => instance.counters.deletes.kept === 1);
    await instance.resync();

    expect(puts().length).toBe(putsAfterDelete);
  });

  it("re-writes no erased agent or workspace record while the user is being erased", async () => {
    const instance = await chatReadyUser();
    await store().users.records.patch("u1", { accountLifecycle: scheduledDeletion });
    await store().workspaces.agentIdentities.delete("u1");
    await store().workspaces.records.delete("lin");
    projectionCalls = [];

    fake.setStatus("u1", { observedGeneration: 2 });
    await until(() => instance.counters.mirrors["being-erased"] >= 1);

    expect(await store().workspaces.agentIdentities.get("u1")).toBeNull();
    expect(await store().workspaces.records.get("lin")).toBeNull();
    expect(projectionCalls).toEqual([]);
  });
});

describe("chat accounts the platform already holds", () => {
  const chatSecret = (secretId: string, kind: "builder-mattermost" | "coach-mattermost", mattermostUserId: string) =>
    ({ kind, secretId, projectId: null, personalToken: `${secretId}-older-token`, mattermostUserId, createdAt: 1, rotatedAt: null });

  async function chatReadyAgainstHeldAccounts(): Promise<ProvisioningSync> {
    seedUser("u1", "lin");
    const instance = started(sync());
    await instance.snapshotLoaded();
    await until(() => fake.resources.has("u1"));
    fake.issueCredential("u1", "user-chat-token", USER_TOKEN);
    fake.issueCredential("u1", "agent-chat-token", AGENT_TOKEN);
    fake.setStatus("u1", CHAT_READY);
    await until(() => instance.counters.mirrors["chat-id-mismatch"] >= 1);
    return instance;
  }

  it("refuses when the user's platform chat secret belongs to another chat account and the record holds no id", async () => {
    await store().secrets.put("u1", chatSecret("mattermost", "builder-mattermost", "mm-x"));

    const instance = await chatReadyAgainstHeldAccounts();

    expect((await store().users.records.get("u1"))?.mattermostUserId).toBeNull();
    expect(await store().secrets.get("u1", "mattermost")).toMatchObject({ mattermostUserId: "mm-x", personalToken: "mattermost-older-token" });
    expect(secretPuts).toEqual([]);
    expect(projectionCalls).toEqual([]);
    expect(instance.mirrorRefusals()).toEqual([expect.objectContaining({ uid: "u1", outcome: "chat-id-mismatch", reason: expect.stringContaining("mm-x") })]);
  });

  it("refuses when the agent's chat secret or identity belongs to another chat account", async () => {
    await store().secrets.put("u1", chatSecret("coachMattermost", "coach-mattermost", "mm-other-bot"));

    const instance = await chatReadyAgainstHeldAccounts();

    expect((await store().users.records.get("u1"))?.mattermostUserId).toBeNull();
    expect(await store().workspaces.agentIdentities.get("u1")).toBeNull();
    expect(instance.mirrorRefusals()).toEqual([expect.objectContaining({ outcome: "chat-id-mismatch", reason: expect.stringContaining("mm-other-bot") })]);
  });

  it("refuses inside the write when another writer records a different chat account after the check", async () => {
    seedUser("u1", "lin");
    await client().putProvisioning("u1", desiredUserProvisioningSpec("u1", ACCOUNTS.u1));
    fake.issueCredential("u1", "user-chat-token", USER_TOKEN);
    fake.issueCredential("u1", "agent-chat-token", AGENT_TOKEN);
    const resource = fake.setStatus("u1", CHAT_READY);
    const racing: ProvisioningProjection = {
      ...recordingProjection(),
      systemConfig: async (ctx) => {
        await store().users.records.patch(ctx.uid, { mattermostUserId: "mm-legacy" });
      },
    };

    const outcome = await mirrorUserProvisioning(
      { store: store(), client: client(), documents: { account: async (uid) => ACCOUNTS[uid] }, projection: racing, proxyUrl: null },
      resource,
    );

    expect(outcome).toBe("chat-id-mismatch");
    expect((await store().users.records.get("u1"))?.mattermostUserId).toBe("mm-legacy");
    expect(await store().workspaces.records.get("lin")).toBeNull();
  });
});

describe("removed users", () => {
  const deletesOf = (uid: string) => fake.requests.filter((request) => request.method === "DELETE" && request.path === `/v1/users/${uid}/provisioning`);

  it("deletes the provisioning of a removed user and writes no spec for it afterwards", async () => {
    const instance = await chatReadyUser();

    await deleteUser("u1");
    await until(() => instance.counters.deletes.deleted === 1);
    const putsAfterDelete = puts().length;
    await instance.resync();

    expect(fake.resources.has("u1")).toBe(false);
    expect(deletesOf("u1")).toHaveLength(1);
    expect(puts().length).toBe(putsAfterDelete);
    expect(instance.observed("u1")).toBeUndefined();
  });

  it("retries the delete until the service confirms it", async () => {
    const instance = await chatReadyUser();
    fake.failNext(503, 4);

    await deleteUser("u1");
    await until(() => instance.counters.deletes.deleted === 1);

    expect(instance.counters.deletes.failed).toBeGreaterThan(0);
    expect(fake.resources.has("u1")).toBe(false);
  });

  it("deletes a provisioning whose user was removed while the fleet controller was down", async () => {
    seedUser("u1", "lin");
    await client().putProvisioning("u1", desiredUserProvisioningSpec("u1", ACCOUNTS.u1));
    records.delete("users/u1");

    const instance = started(sync());
    await instance.snapshotLoaded();
    await until(() => instance.counters.deletes.deleted === 1);

    expect(fake.resources.has("u1")).toBe(false);
  });

  it("never deletes the provisioning of a user whose record cannot be decoded, and keeps re-checking", async () => {
    const instance = await chatReadyUser();
    unreadableUsers.add("u1");

    await emitBuilders([{ type: "removed", key: "u1" }]);
    await until(() => instance.counters.deletes.unreadable >= 2);
    await instance.resync();

    expect(deletesOf("u1")).toHaveLength(0);
    expect(fake.resources.has("u1")).toBe(true);
    expect(logs.some((line) => line.includes("❌ not deleting the provisioning of u1"))).toBe(true);
  });

  it("counts a removed user whose uid the service cannot name as nothing to delete, without retrying", async () => {
    const instance = started(sync());
    await instance.snapshotLoaded();

    await emitBuilders([{ type: "removed", key: "lin@example.test" }]);
    await until(() => instance.counters.deletes.unnameable === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(instance.counters.deletes.failed).toBe(0);
    expect(instance.counters.deletes.unnameable).toBe(1);
    expect(logs.filter((line) => line.includes("cannot name lin@example.test"))).toHaveLength(1);
  });

  it("keeps the provisioning of a user whose record exists again when the pending delete runs", async () => {
    const instance = await chatReadyUser();
    fake.failNext(503, 2);

    await deleteUser("u1");
    seedUser("u1", "lin");
    await until(() => instance.counters.deletes.kept === 1);

    expect(deletesOf("u1")).toHaveLength(0);
    expect(fake.resources.has("u1")).toBe(true);
  });

  it("sends a fresh spec when the same uid is admitted again with the same slug", async () => {
    const instance = await chatReadyUser();
    await deleteUser("u1");
    await until(() => instance.counters.deletes.deleted === 1);
    const putsBefore = puts().length;

    seedUser("u1", "lin");
    await emitBuilders([{ type: "added", key: "u1" }]);
    await until(() => fake.resources.has("u1"));

    expect(puts().length).toBe(putsBefore + 1);
    expect(fake.resources.get("u1")?.status.outputs.chat).toBeUndefined();
  });

  it("forgets a provisioning the service deleted and sends a fresh spec for a user who is still admitted", async () => {
    const instance = await chatReadyUser();
    const putsBefore = puts().length;

    await client().deleteProvisioning("u1");
    await until(() => fake.resources.get("u1")?.generation === 1 && puts().length === putsBefore + 1);

    expect(fake.resources.get("u1")?.status.outputs.chat).toBeUndefined();
    expect(instance.observed("u1")?.status.outputs.chat).toBeUndefined();
  });

  it("forgets a deleted provisioning and writes nothing for a user who is gone", async () => {
    const instance = await chatReadyUser();
    records.delete("users/u1");

    await client().deleteProvisioning("u1");
    await until(() => instance.observed("u1") === undefined);
    await instance.resync();

    expect(fake.resources.has("u1")).toBe(false);
    expect(deletesOf("u1")).toHaveLength(1);
  });

  it("refuses to mirror a user whose record vanishes between the read and the write", async () => {
    seedUser("u1", "lin");
    await client().putProvisioning("u1", desiredUserProvisioningSpec("u1", ACCOUNTS.u1));
    fake.issueCredential("u1", "user-chat-token", USER_TOKEN);
    fake.issueCredential("u1", "agent-chat-token", AGENT_TOKEN);
    const resource = fake.setStatus("u1", CHAT_READY);
    const vanishing: ProvisioningProjection = {
      ...recordingProjection(),
      user: async (ctx) => {
        records.delete(`users/${ctx.uid}`);
      },
    };

    const outcome = await mirrorUserProvisioning(
      { store: store(), client: client(), documents: { account: async (uid) => ACCOUNTS[uid] }, projection: vanishing, proxyUrl: null },
      resource,
    );

    expect(outcome).toBe("user-missing");
    expect(await store().workspaces.records.get("lin")).toBeNull();
    expect(await store().workspaces.channels.get({ workspaceSlug: "lin", projectSlug: null }, "general")).toBeNull();
  });
});

describe("resource versions", () => {
  it("keeps the newer of two resource versions above 2^53 that differ by one when the older arrives second", async () => {
    seedUser("u1", "lin");
    const resource = (resourceVersion: string, email: string) => ({
      uid: "u1",
      generation: 1,
      resourceVersion,
      spec: { ...desiredUserProvisioningSpec("u1", ACCOUNTS.u1), email },
      status: { observedGeneration: 0, conditions: [], outputs: { credentials: [] }, work: { state: "queued", attempts: 0, nextAttemptAt: null, lastAttemptAt: null } },
    }) as UserProvisioning;
    let watches = 0;
    const stub = {
      ...client(),
      listAllProvisionings: async () => ({ items: [resource("9007199254740993", "newer@example.test")], resourceVersion: "9007199254740993" }),
      watchProvisionings: async () => {
        watches += 1;
        if (watches === 1) return { items: [resource("9007199254740992", "older@example.test")], resourceVersion: "9007199254740994" };
        return new Promise<never>(() => undefined);
      },
      putProvisioning: () => new Promise<never>(() => undefined),
    };
    const instance = createProvisioningSync({
      store: store(),
      client: stub,
      documents: { account: async (uid) => ACCOUNTS[uid] },
      projection: recordingProjection(),
      proxyUrl: null,
      log: (message) => logs.push(message),
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
    });
    stoppers.push(instance.start());

    await until(() => watches >= 2);

    expect(instance.observed("u1")?.resourceVersion).toBe("9007199254740993");
    expect(instance.observed("u1")?.spec.email).toBe("newer@example.test");
  });
});

describe("resync and backfill completion", () => {
  it("sends a changed name on the periodic resync without a restart, and writes nothing when it is unchanged", async () => {
    seedUser("u1", "lin");
    const accounts: Record<string, Data> = { ...ACCOUNTS, u1: { ...ACCOUNTS.u1 } };
    const instance = createProvisioningSync({
      store: store(),
      client: client(),
      documents: { account: async (uid) => accounts[uid] },
      projection: recordingProjection(),
      proxyUrl: null,
      log: (message) => logs.push(message),
      watchTimeoutSeconds: 1,
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
      resyncMs: 20,
    });
    stoppers.push(instance.start());
    await instance.snapshotLoaded();
    await until(() => fake.resources.has("u1"));
    await until(() => instance.counters.specWrites.unchanged >= 2);
    const putsWhileEqual = puts().length;

    accounts.u1.email = "lin.wu@example.test";
    await until(() => fake.resources.get("u1")?.spec.email === "lin.wu@example.test");

    expect(putsWhileEqual).toBe(1);
    expect(fake.resources.get("u1")?.generation).toBe(2);
  });

  it("leaves an account-document change for the resync, which runs every ten minutes and writes it once", async () => {
    seedUser("u1", "lin");
    const accounts: Record<string, Data> = { ...ACCOUNTS, u1: { ...ACCOUNTS.u1 } };
    const instance = createProvisioningSync({
      store: store(),
      client: client(),
      documents: { account: async (uid) => accounts[uid] },
      projection: recordingProjection(),
      proxyUrl: null,
      log: (message) => logs.push(message),
      watchTimeoutSeconds: 1,
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
    });
    stoppers.push(instance.start());
    await instance.snapshotLoaded();
    await until(() => fake.resources.has("u1"));

    accounts.u1.email = "lin.wu@example.test";
    await emitBuilders([{ type: "modified", key: "u1" }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const putsBeforeResync = puts().length;
    await instance.resync();
    await until(() => fake.resources.get("u1")?.spec.email === "lin.wu@example.test");

    expect(PROVISIONING_SYNC_RESYNC_MS).toBe(10 * 60_000);
    expect(putsBeforeResync).toBe(1);
    expect(puts()).toHaveLength(2);
  });

  it("completes the backfill when one user can never succeed, and reports that user", async () => {
    seedUser("u1", "lin");
    seedUser("u9", "nouser");

    const instance = started(sync());
    await instance.snapshotLoaded();
    await until(() => audit()?.status === "completed");

    expect(fake.resources.has("u1")).toBe(true);
    expect(logs.some((line) => line.includes("2 admitted users, 1 written, 0 unchanged, 1 failed and retrying"))).toBe(true);
    expect(instance.specFailures()).toEqual([expect.objectContaining({ uid: "u9", reason: expect.stringContaining("no account document") })]);
  });
});

