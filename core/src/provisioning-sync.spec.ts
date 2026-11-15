import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { installDefaultUserEntitlements } from "@octogee/shared/types/user-entitlements";
import type { UserProvisioningStatus } from "@octogee/shared/types/provisioning-service";
import { startFakeProvisioningService, type FakeProvisioningService } from "./fixtures/provisioning-service-fake.js";
import { operationAuditDocumentId } from "./operation-audit.js";
import type { PlatformStateStore } from "./platform-state/store.js";
import { createProvisioningServiceClient } from "./provisioning-service-client.js";
import { mirrorUserProvisioning } from "./provisioning-mirror.js";
import { desiredUserProvisioningSpec } from "./provisioning-spec.js";
import {
  createProvisioningSync,
  PROVISIONING_SPEC_BACKFILL_KEY,
  runJournaledBackfill,
  type ProvisioningSync,
} from "./provisioning-sync.js";
import { noProvisioningProjection, type ProvisioningProjection } from "./provisionSteps.js";

type Data = Record<string, unknown>;

const ACCOUNTS: Record<string, Data> = {
  u1: { username: "lin", email: "lin@example.test", displayName: "Lin Wu" },
  u2: { username: "ada", email: "ada@example.test" },
};

const CHAT_READY: Partial<UserProvisioningStatus> = {
  observedGeneration: 1,
  conditions: [
    { type: "ChatReady", status: "True", reason: "Converged", message: "", lastTransitionTime: "2026-11-15T18:00:00Z", observedGeneration: 1 },
    { type: "Ready", status: "False", reason: "GitNotReady", message: "", lastTransitionTime: "2026-11-15T18:00:00Z", observedGeneration: 1 },
  ],
  outputs: {
    chat: { userId: "mm-user", teamId: "mm-team", channels: { general: "ch-general", agent: "ch-agent" }, agentBotUserId: "mm-bot" },
    credentials: [],
  },
};

let records: Map<string, Data>;
let fake: FakeProvisioningService;
let projectionCalls: string[];
let transactions: string[];
let logs: string[];
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
  return new Proxy(fixture, {
    get(target, property, receiver) {
      if (property === "watch") return () => ({ closed: Promise.resolve(), close: async () => undefined });
      return Reflect.get(target, property, receiver);
    },
  });
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
    client: createProvisioningServiceClient({ baseUrl: fake.url, tokenPath: "/token", readToken: async () => "token", retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 } }),
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
  async function chatReadyUser(): Promise<ProvisioningSync> {
    seedUser("u1", "lin");
    const instance = started(sync());
    await instance.snapshotLoaded();
    await until(() => fake.resources.has("u1"));
    fake.setStatus("u1", CHAT_READY);
    await until(() => instance.counters.mirrors.written === 1);
    return instance;
  }

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

  it("never writes the readiness fields the gateway reports", async () => {
    await chatReadyUser();

    const user = await store().users.records.get("u1");
    expect(user?.provisioning.status).toBe("in_progress");
    expect(user?.openclaw.status).toBeUndefined();
  });

  it("writes nothing and projects nothing when the records already match", async () => {
    await chatReadyUser();
    const resource = fake.resources.get("u1")!;
    projectionCalls = [];
    transactions = [];

    const outcome = await mirrorUserProvisioning({
      store: store(),
      documents: { account: async (uid) => ACCOUNTS[uid] },
      projection: recordingProjection(),
      proxyUrl: null,
    }, resource);

    expect(outcome).toBe("unchanged");
    expect(projectionCalls).toEqual([]);
    expect(transactions).toEqual([]);
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
