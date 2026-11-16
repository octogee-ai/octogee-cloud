import express, { type RequestHandler } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { logger } from "@octogee/core/http/logging";
import { workspaceDefaultAgentChannelName } from "@octogee/shared/types/identity";
import { installDefaultUserEntitlements } from "@octogee/shared/types/user-entitlements";
import type { UserProvisioning } from "@octogee/shared/types/provisioning-service";
import { mmUpdateFromChatOutputs } from "@octogee/core/provisioning-mirror";
import { buildProvisioningContext, markProvisioningComplete, noProvisioningProjection } from "@octogee/core/provisionSteps";
import { NO_BROKER_RECORDS, type BrokerRecords } from "../lib/broker-records.js";
import type { LegacyProvisioning, ProvisioningWait } from "../lib/legacy-provisioning.js";
import { RecordingDocuments } from "../test-helpers/recording-documents.js";
import { createFleetBrokerRoutes, type ProvisionedUserReport } from "./fleet-broker.js";

const GATEWAY_ID = "shared-blue";
const CHAT = { userId: "mm-alice", teamId: "team-alice", channels: { general: "ch-general", agent: "ch-agent" }, agentBotUserId: "bot-alice" };
const RESOURCE: UserProvisioning = {
  uid: "uid-alice",
  generation: 1,
  resourceVersion: "4",
  spec: {
    slug: "alice",
    displayName: { first: "Alice", last: "" },
    email: "alice@example.test",
    avatarUrl: null,
    chat: { teamDisplayName: "Alice", defaultAgent: { enabled: true } },
    git: { repositories: ["workspace", "project-coaches"], systemConfigRepository: true },
    agentIds: ["octogee-alice-coach"],
  },
  status: {
    observedGeneration: 1,
    conditions: [{ type: "ChatReady", status: "True", reason: "Converged", message: "", lastTransitionTime: "2026-11-15T18:00:00Z", observedGeneration: 1 }],
    outputs: { chat: CHAT, credentials: ["agent-chat-token", "user-chat-token"] },
    work: { state: "idle", attempts: 1, nextAttemptAt: null, lastAttemptAt: null },
  },
};
const READY_CHAT: ProvisioningWait<{ slug: string; chat: typeof CHAT; resource: UserProvisioning }> = {
  ready: true,
  value: { slug: "alice", chat: CHAT, resource: RESOURCE },
};

function legacyProvisioning(overrides: Partial<LegacyProvisioning> = {}): LegacyProvisioning {
  return {
    chat: vi.fn(async () => READY_CHAT),
    git: vi.fn(async () => ({ ready: true as const, value: undefined })),
    agentChatToken: vi.fn(async () => ({ ready: true as const, value: "service-agent-token" })),
    gitKey: vi.fn(async () => {
      throw new Error("the fleet broker routes put no git key");
    }),
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

async function putDefaultAgentSecret(store: ReturnType<typeof createDocumentFixtureStore>, personalToken: string, mattermostUserId = "bot-alice") {
  await store.secrets.put("uid-alice", {
    kind: "coach-mattermost",
    secretId: "coachMattermost",
    projectId: null,
    personalToken,
    mattermostUserId,
    createdAt: Date.now(),
    rotatedAt: null,
  });
}

async function mirrorFully(store: ReturnType<typeof createDocumentFixtureStore>) {
  const mmUpdate = mmUpdateFromChatOutputs({ slug: "alice", chat: CHAT, agentChannelName: workspaceDefaultAgentChannelName("alice"), proxyUrl: null });
  await markProvisioningComplete(buildProvisioningContext("uid-alice", { username: "alice" }), mmUpdate, [...RESOURCE.spec.agentIds], noProvisioningProjection, store);
}

installDefaultUserEntitlements();

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
    expect(provisioning.chat).toHaveBeenCalledWith("uid-alice", expect.objectContaining({ signal: expect.any(AbortSignal) }));
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
    const { app } = fixture({
      provisioning: legacyProvisioning({ agentChatToken: vi.fn(async () => ({ ready: false as const, reason: "CredentialsNotIssued", retryAfterSeconds: 5 })) }),
    });

    const response = await post(app, "provision-mattermost").expect(503);

    expect(response.headers["retry-after"]).toBe("5");
    expect(response.body).toEqual({ error: "provisioning_pending", reason: "CredentialsNotIssued" });
  });

  it("answers 503 with the service's Retry-After when the agent token read finds the service unavailable", async () => {
    const { app } = fixture({
      provisioning: legacyProvisioning({ agentChatToken: vi.fn(async () => ({ ready: false as const, reason: "ProvisioningServiceUnavailable", retryAfterSeconds: 30 })) }),
    });

    const response = await post(app, "provision-mattermost").expect(503);

    expect(response.headers["retry-after"]).toBe("30");
    expect(response.body).toEqual({ error: "provisioning_pending", reason: "ProvisioningServiceUnavailable" });
  });

  it("logs the uid, the route and the reason of every not-ready answer", async () => {
    const warned = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { app } = fixture({
      provisioning: legacyProvisioning({ chat: vi.fn(async () => ({ ready: false as const, reason: "ChatTeamFailed", retryAfterSeconds: 42 })) }),
    });

    await post(app, "provision-mattermost").expect(503);

    expect(warned).toHaveBeenCalledWith("legacy provisioning: answering not ready", {
      route: "provision-mattermost", uid: "uid-alice", reason: "ChatTeamFailed", retryAfterSeconds: 42,
    });
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

  it("writes nothing and answers 204 once the mirror has written every record the gateway's snapshot reads", async () => {
    const { app, store, documents, markProvisioningComplete, renderAvatar } = fixture();
    await mirrorFully(store);
    const writesBefore = documents.writes.length;

    await post(app, "set-mattermost-fields", { mmUpdate }).expect(204);

    expect(markProvisioningComplete).not.toHaveBeenCalled();
    expect(renderAvatar).not.toHaveBeenCalled();
    expect(documents.writes.length).toBe(writesBefore);
  });

  it("answers 503 while the mirror has written the user's chat account but not yet the workspace, its channels and the agent identity", async () => {
    const warned = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { app } = fixture({ mattermostUserId: "mm-alice" });

    const response = await post(app, "set-mattermost-fields", { mmUpdate }).expect(503);

    expect(response.headers["retry-after"]).toBe("5");
    expect(response.body).toEqual({ error: "provisioning_pending", reason: "WaitingForMirror" });
    expect(warned).toHaveBeenCalledWith("legacy provisioning: answering not ready", expect.objectContaining({ reason: "WaitingForMirror" }));
  });

  it.each([
    ["another chat account on the user record", "ChatAccountMismatch", "the user record holds chat user mm-other", async (store: ReturnType<typeof createDocumentFixtureStore>) => {
      await store.users.records.patch("uid-alice", { mattermostUserId: "mm-other" });
    }],
    ["another chat account behind the agent's platform secret", "ChatAccountMismatch", "belongs to chat user mm-other-bot", async (store: ReturnType<typeof createDocumentFixtureStore>) => {
      await putDefaultAgentSecret(store, "older-token", "mm-other-bot");
    }],
    ["another slug on the user record", "SlugMismatch", "carries slug bob", async (store: ReturnType<typeof createDocumentFixtureStore>) => {
      await store.users.records.patch("uid-alice", { slug: "bob" });
    }],
    ["a user being erased", "UserBeingErased", "account lifecycle is erasing", async (store: ReturnType<typeof createDocumentFixtureStore>) => {
      const user = await store.users.records.get("uid-alice");
      await store.users.records.patch("uid-alice", { accountLifecycle: { ...user!.accountLifecycle, status: "erasing" } });
    }],
  ])("answers 503 with its own reason and an error naming the uid for %s the mirror refuses", async (_case, reason, detail, arrange) => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { app, store, documents } = fixture();
    await arrange(store);
    const writesBefore = documents.writes.length;

    const response = await post(app, "set-mattermost-fields", { mmUpdate }).expect(503);

    expect(response.body).toEqual({ error: "provisioning_pending", reason });
    expect(logged).toHaveBeenCalledWith("legacy provisioning: the mirror refuses this user, so its mount cannot finish", {
      uid: "uid-alice", reason, detail: expect.stringContaining(detail),
    });
    expect(documents.writes.length).toBe(writesBefore);
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

  it("keeps an uploaded avatar that has no look across every mount", async () => {
    const { app, sync, renderAvatar } = fixture({
      mattermostUserId: "mm-alice",
      agentDocument: { avatar: { path: "Coach-avatar.png", gcsPath: "users/alice/Coach-avatar.png" }, avatarVersion: 2 },
    });

    await post(app, "provisioned", { first: true }).expect(204);
    await post(app, "provisioned", { first: false }).expect(204);

    expect(renderAvatar).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("applies no look here without a provisioning service", async () => {
    const { app, sync } = fixture({ provisioning: null, mattermostUserId: "mm-alice" });

    await post(app, "provisioned", { first: true }).expect(204);

    expect(sync).not.toHaveBeenCalled();
  });
});
