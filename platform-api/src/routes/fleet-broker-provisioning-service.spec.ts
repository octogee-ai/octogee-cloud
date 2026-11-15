import express, { type RequestHandler } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { workspaceDefaultAgentChannelName } from "@octogee/shared/types/identity";
import { NO_BROKER_RECORDS, type BrokerRecords } from "../lib/broker-records.js";
import type { LegacyProvisioning, ProvisioningWait } from "../lib/legacy-provisioning.js";
import { RecordingDocuments } from "../test-helpers/recording-documents.js";
import { createFleetBrokerRoutes, type ProvisionedUserReport } from "./fleet-broker.js";

const GATEWAY_ID = "shared-blue";
const CHAT = { userId: "mm-alice", teamId: "team-alice", channels: { general: "ch-general", agent: "ch-agent" }, agentBotUserId: "bot-alice" };
const READY_CHAT: ProvisioningWait<{ slug: string; chat: typeof CHAT }> = { ready: true, value: { slug: "alice", chat: CHAT } };

function legacyProvisioning(overrides: Partial<LegacyProvisioning> = {}): LegacyProvisioning {
  return {
    chat: vi.fn(async () => READY_CHAT),
    git: vi.fn(async () => ({ ready: true as const, value: undefined })),
    agentChatToken: vi.fn(async () => "service-agent-token"),
    ...overrides,
  };
}

function fixture(options: {
  provisioning?: LegacyProvisioning | null;
  mattermostUserId?: string;
  agentDocument?: Record<string, unknown>;
  onUserProvisioned?: (report: ProvisionedUserReport) => Promise<void>;
} = {}) {
  const documents = new RecordingDocuments({
    "users/uid-alice": {
      username: "alice",
      ...(options.mattermostUserId ? { mattermost: { userId: options.mattermostUserId } } : {}),
      provisioning: { openclaw: { gatewayId: GATEWAY_ID, slug: "alice" } },
    },
  });
  const store = createDocumentFixtureStore(documents);
  const sync = vi.fn(async () => []);
  const records: BrokerRecords = {
    ...NO_BROKER_RECORDS,
    userDocuments: {
      ...NO_BROKER_RECORDS.userDocuments,
      account: async () => ({ username: "alice" }),
      agent: async () => options.agentDocument,
    },
    agentIdentity: { ...NO_BROKER_RECORDS.agentIdentity, sync },
  };
  const provisionMattermost = vi.fn(async () => ({ "mattermost.userId": "legacy" }));
  const markProvisioningComplete = vi.fn(async () => undefined);
  const renderAvatar = vi.fn(async () => Buffer.from("png"));
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: GATEWAY_ID, tokenSource: "ksa" } as never;
    next();
  }) as RequestHandler);
  app.use("/internal/fleet", createFleetBrokerRoutes({
    store,
    records,
    provisionMattermost,
    markProvisioningComplete,
    renderAvatar,
    legacyProvisioning: options.provisioning === undefined ? legacyProvisioning() : options.provisioning,
    ...(options.onUserProvisioned ? { onUserProvisioned: options.onUserProvisioned } : {}),
  }));
  return { app, store, documents, sync, provisionMattermost, markProvisioningComplete, renderAvatar };
}

const post = (app: express.Express, path: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/internal/fleet/${path}`).send({ gatewayId: GATEWAY_ID, uid: "uid-alice", ...body });

async function putDefaultAgentSecret(store: ReturnType<typeof createDocumentFixtureStore>, personalToken: string) {
  await store.secrets.put("uid-alice", {
    kind: "coach-mattermost",
    secretId: "coachMattermost",
    projectId: null,
    personalToken,
    mattermostUserId: "bot-alice",
    createdAt: Date.now(),
    rotatedAt: null,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /internal/fleet/provision-mattermost with the provisioning service", () => {
  it("answers today's mmUpdate from the service's chat outputs and its agent token for a user with no platform secret", async () => {
    vi.stubEnv("API_PUBLIC_URL", "https://api.example.test");
    const provisioning = legacyProvisioning();
    const { app, provisionMattermost } = fixture({ provisioning });

    const response = await post(app, "provision-mattermost").expect(200);

    expect(response.body).toEqual({
      mmUpdate: {
        "mattermost.userId": "mm-alice",
        "mattermost.username": "alice",
        "mattermost.teamId": "team-alice",
        "mattermost.generalChannelId": "ch-general",
        "mattermost.channelId": "ch-agent",
        "mattermost.dmChannelId": "ch-agent",
        "mattermost.channelName": workspaceDefaultAgentChannelName("alice"),
        "mattermost.proxyUrl": "https://api.example.test",
        "mattermost.coachUserId": "bot-alice",
        _coachPersonalToken: "service-agent-token",
      },
    });
    expect(provisioning.chat).toHaveBeenCalledWith("uid-alice");
    expect(provisionMattermost).not.toHaveBeenCalled();
  });

  it("hands out the platform secret's agent token when the user already has one", async () => {
    const provisioning = legacyProvisioning();
    const { app, store } = fixture({ provisioning });
    await putDefaultAgentSecret(store, "legacy-agent-token");

    const response = await post(app, "provision-mattermost").expect(200);

    expect(response.body.mmUpdate._coachPersonalToken).toBe("legacy-agent-token");
    expect(provisioning.agentChatToken).not.toHaveBeenCalled();
  });

  it("answers 503 until an agent token exists in either place", async () => {
    const { app } = fixture({ provisioning: legacyProvisioning({ agentChatToken: vi.fn(async () => null) }) });

    const response = await post(app, "provision-mattermost").expect(503);

    expect(response.headers["retry-after"]).toBe("5");
    expect(response.body).toEqual({ error: "provisioning_pending", reason: "CredentialsNotIssued" });
  });

  it("answers 503 with Retry-After while chat is not ready", async () => {
    const { app, provisionMattermost } = fixture({
      provisioning: legacyProvisioning({ chat: vi.fn(async () => ({ ready: false as const, reason: "ChatTeamFailed", retryAfterSeconds: 42 })) }),
    });

    const response = await post(app, "provision-mattermost").expect(503);

    expect(response.headers["retry-after"]).toBe("42");
    expect(response.body).toEqual({ error: "provisioning_pending", reason: "ChatTeamFailed" });
    expect(provisionMattermost).not.toHaveBeenCalled();
  });

  it("answers 503 for a user the service has no resource for", async () => {
    const { app } = fixture({
      provisioning: legacyProvisioning({ chat: vi.fn(async () => ({ ready: false as const, reason: "NotProvisioned", retryAfterSeconds: 5 })) }),
    });

    const response = await post(app, "provision-mattermost").expect(503);

    expect(response.body).toEqual({ error: "provisioning_pending", reason: "NotProvisioned" });
  });

  it("calls the legacy provisioning without a provisioning service", async () => {
    const { app, provisionMattermost } = fixture({ provisioning: null });

    const response = await post(app, "provision-mattermost").expect(200);

    expect(response.body).toEqual({ mmUpdate: { "mattermost.userId": "legacy" } });
    expect(provisionMattermost).toHaveBeenCalledOnce();
  });
});

describe("POST /internal/fleet/set-mattermost-fields with the provisioning service", () => {
  const mmUpdate = { "mattermost.userId": "mm-alice" };

  it("writes nothing and answers 204 once the mirror has written the user's chat account", async () => {
    const { app, documents, markProvisioningComplete, renderAvatar } = fixture({ mattermostUserId: "mm-alice" });

    await post(app, "set-mattermost-fields", { mmUpdate }).expect(204);

    expect(markProvisioningComplete).not.toHaveBeenCalled();
    expect(renderAvatar).not.toHaveBeenCalled();
    expect(documents.writes).toEqual([]);
  });

  it("answers 503 until the mirror has written the user's chat account", async () => {
    const { app } = fixture();

    const response = await post(app, "set-mattermost-fields", { mmUpdate }).expect(503);

    expect(response.body).toEqual({ error: "provisioning_pending", reason: "WaitingForMirror" });
  });

  it("answers 503 while chat is not ready", async () => {
    const { app } = fixture({
      mattermostUserId: "mm-alice",
      provisioning: legacyProvisioning({ chat: vi.fn(async () => ({ ready: false as const, reason: "ChatChannelsFailed", retryAfterSeconds: 9 })) }),
    });

    const response = await post(app, "set-mattermost-fields", { mmUpdate }).expect(503);

    expect(response.headers["retry-after"]).toBe("9");
    expect(response.body.reason).toBe("ChatChannelsFailed");
  });

  it("still refuses a malformed update", async () => {
    const provisioning = legacyProvisioning();
    const { app } = fixture({ provisioning, mattermostUserId: "mm-alice" });

    const response = await post(app, "set-mattermost-fields", { mmUpdate: "nope" });

    expect(response.status).toBe(400);
    expect(provisioning.chat).not.toHaveBeenCalled();
  });

  it("completes provisioning itself without a provisioning service", async () => {
    const { app, markProvisioningComplete, sync } = fixture({ provisioning: null });

    await post(app, "set-mattermost-fields", { mmUpdate }).expect(204);

    expect(markProvisioningComplete).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledOnce();
  });
});

describe("POST /internal/fleet/set-agent-ids", () => {
  it.each([["with", legacyProvisioning()], ["without", null]] as const)("adds the agent ids %s the provisioning service", async (_mode, provisioning) => {
    const { app, store } = fixture({ provisioning });

    await post(app, "set-agent-ids", { agentIds: ["octogee-alice-coach"] }).expect(204);

    expect((await store.users.records.get("uid-alice"))?.agents.agentIds).toEqual(["octogee-alice-coach"]);
  });
});

describe("the gateway's readiness and pushed signals", () => {
  it.each([["with", legacyProvisioning()], ["without", null]] as const)("record the status and the repository URL %s the provisioning service", async (_mode, provisioning) => {
    const { app, store } = fixture({ provisioning });

    await post(app, "set-provisioning-status", { status: "complete" }).expect(204);
    await post(app, "set-repo-url", { repoUrl: "ssh://git@git.example.test/alice/alice-workspace.git" }).expect(204);

    const user = await store.users.records.get("uid-alice");
    expect(user?.openclaw?.status).toBe("complete");
    expect(user?.provisioning?.status).toBe("complete");
    expect(user?.provisioning?.gitRepoUrl).toBe("ssh://git@git.example.test/alice/alice-workspace.git");
    if (provisioning) {
      expect(provisioning.chat).not.toHaveBeenCalled();
      expect(provisioning.git).not.toHaveBeenCalled();
    }
  });
});

describe("POST /internal/fleet/provisioned with the provisioning service", () => {
  it("applies the default agent look to an agent that has none, then reports the user", async () => {
    const order: string[] = [];
    const { app, sync } = fixture({
      mattermostUserId: "mm-alice",
      onUserProvisioned: async () => { order.push("reported"); },
    });
    sync.mockImplementation(async () => { order.push("look"); return []; });

    await post(app, "provisioned", { first: true }).expect(204);

    expect(sync).toHaveBeenCalledWith("uid-alice", expect.objectContaining({ avatarPng: Buffer.from("png") }), { slug: "alice" });
    expect(order).toEqual(["look", "reported"]);
  });

  it("leaves an agent that already has a look alone", async () => {
    const reports: ProvisionedUserReport[] = [];
    const { app, sync, renderAvatar } = fixture({
      mattermostUserId: "mm-alice",
      agentDocument: { look: { body: "custom" } },
      onUserProvisioned: async (report) => { reports.push(report); },
    });

    await post(app, "provisioned", { first: false }).expect(204);

    expect(renderAvatar).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(reports).toEqual([{ uid: "uid-alice", slug: "alice", mattermostUserId: "mm-alice", first: false }]);
  });

  it("applies no look here without a provisioning service", async () => {
    const { app, sync } = fixture({ provisioning: null, mattermostUserId: "mm-alice" });

    await post(app, "provisioned", { first: true }).expect(204);

    expect(sync).not.toHaveBeenCalled();
  });
});
