import express, { type RequestHandler } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { logger } from "@octogee/core/http/logging";
import { mmUpdateFromChatOutputs } from "@octogee/core/provisioning-mirror";
import { buildProvisioningContext, markProvisioningComplete, noProvisioningProjection } from "@octogee/core/provisionSteps";
import { workspaceDefaultAgentChannelName } from "@octogee/shared/types/identity";
import { installDefaultUserEntitlements } from "@octogee/shared/types/user-entitlements";
import type { ChatOutputs, UserProvisioning } from "@octogee/shared/types/provisioning-service";
import { NO_BROKER_RECORDS, type BrokerRecords } from "../lib/broker-records.js";
import { createLegacyProvisioning, type LegacyProvisioning } from "../lib/legacy-provisioning.js";
import { RecordingDocuments } from "../test-helpers/recording-documents.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const GATEWAY_ID = "shared-blue";
const POD_NAME = "octogee-gateway-shared-blue-5bc59-p946t";
const HOLDER = `${GATEWAY_ID}/${POD_NAME}`;
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGatewayKey octogee-alice@gateway";
const CHAT: ChatOutputs = { userId: "mm-alice", teamId: "team-alice", channels: { general: "ch-general", agent: "ch-agent" }, agentBotUserId: "bot-alice" };
const NO_AGENT_CHAT: ChatOutputs = { userId: "mm-alice", teamId: "team-alice", channels: { general: "ch-general" } };

function provisioningResource(chat: ChatOutputs): UserProvisioning {
  return {
    uid: "uid-alice",
    generation: 1,
    resourceVersion: "4",
    spec: {
      slug: "alice",
      displayName: { first: "Alice", last: "" },
      email: "alice@example.test",
      avatarUrl: null,
      chat: { teamDisplayName: "Alice", defaultAgent: { enabled: chat.agentBotUserId !== undefined } },
      git: { repositories: ["workspace", "project-coaches"], systemConfigRepository: true },
      agentIds: ["octogee-alice-coach"],
    },
    status: {
      observedGeneration: 1,
      conditions: [{ type: "ChatReady", status: "True", reason: "Converged", message: "", lastTransitionTime: "2026-11-15T18:00:00Z", observedGeneration: 1 }],
      outputs: { chat, credentials: ["agent-chat-token", "user-chat-token"] },
      work: { state: "idle", attempts: 1, nextAttemptAt: null, lastAttemptAt: null },
    },
  };
}

function readyChat(chat: ChatOutputs = CHAT) {
  return { ready: true as const, value: { slug: "alice", chat, resource: provisioningResource(chat) } };
}

installDefaultUserEntitlements();

function legacyProvisioning(overrides: Partial<LegacyProvisioning> = {}): LegacyProvisioning {
  return {
    chat: vi.fn(async () => readyChat()),
    git: vi.fn(async () => ({ ready: true as const, value: undefined })),
    agentChatToken: vi.fn(async () => ({ ready: true as const, value: "service-agent-token" })),
    gitKey: vi.fn(async () => ({ ready: true as const, value: undefined })),
    releaseGitKey: vi.fn(async () => "deleted" as const),
    ...overrides,
  };
}

interface Options {
  provisioning?: LegacyProvisioning | null;
  assignedTo?: string;
  boundGatewayId?: string;
  podName?: string | null;
}

function fixture(options: Options = {}) {
  const documents = new RecordingDocuments({
    "users/uid-alice": {
      username: "alice",
      provisioning: { openclaw: { gatewayId: options.assignedTo ?? GATEWAY_ID, slug: "alice" } },
    },
  });
  const store = createDocumentFixtureStore(documents);
  const records: BrokerRecords = {
    ...NO_BROKER_RECORDS,
    userDocuments: { ...NO_BROKER_RECORDS.userDocuments, account: async () => ({ username: "alice" }) },
  };
  const provisioning = options.provisioning === undefined ? legacyProvisioning() : options.provisioning;
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    const podName = options.podName === undefined ? POD_NAME : options.podName;
    req.boundTenant = { kind: "gateway", gatewayId: options.boundGatewayId ?? GATEWAY_ID, tokenSource: "ksa", ...(podName === null ? {} : { podName }) } as never;
    next();
  }) as RequestHandler);
  app.use("/internal/fleet", createFleetBrokerRoutes({ store, records, legacyProvisioning: provisioning }));
  return { app, store, provisioning };
}

async function mirrorFully(store: ReturnType<typeof createDocumentFixtureStore>, chat: ChatOutputs = CHAT) {
  const mmUpdate = mmUpdateFromChatOutputs({ slug: "alice", chat, agentChannelName: workspaceDefaultAgentChannelName("alice"), proxyUrl: null });
  await markProvisioningComplete(buildProvisioningContext("uid-alice", { username: "alice" }), mmUpdate, ["octogee-alice-coach"], noProvisioningProjection, store);
}

async function mirrorChatAccountTokenAndAgentChannel(store: ReturnType<typeof createDocumentFixtureStore>) {
  await store.users.records.patch("uid-alice", { mattermostUserId: "mm-alice" });
  await store.secrets.put("uid-alice", {
    kind: "coach-mattermost",
    secretId: "coachMattermost",
    projectId: null,
    personalToken: "agent-token",
    mattermostUserId: "bot-alice",
    createdAt: Date.now(),
    rotatedAt: null,
  });
  await store.workspaces.channels.put({
    scope: { workspaceSlug: "alice", projectSlug: null },
    channelId: "coach-dm",
    kind: "coach-dm",
    mattermostChannelId: "ch-agent",
    archivedAt: null,
    createdBy: "uid-alice",
    createdAt: null,
  });
}

const post = (app: express.Express, path: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/internal/fleet/${path}`).send({ uid: "uid-alice", ...body });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /internal/fleet/user-snapshot", () => {
  it("tells the gateway to mount a fully mirrored user through the service, under the holder its token names", async () => {
    const { app, store, provisioning } = fixture();
    await mirrorFully(store);

    const response = await post(app, "user-snapshot").expect(200);

    expect(response.body.user).toMatchObject({ provisionedBy: "service", gitKeyHolder: HOLDER });
    expect(provisioning?.chat).toHaveBeenCalledWith("uid-alice", expect.objectContaining({ signal: expect.any(AbortSignal) }), { longPoll: false });
    const budget = vi.mocked(provisioning!.chat).mock.calls[0][1];
    expect(budget.remainingMs()).toBeLessThanOrEqual(3_000);
  });

  it("leaves a user whose mirror is not complete on the gateway's own path", async () => {
    const { app, store } = fixture();
    await mirrorChatAccountTokenAndAgentChannel(store);

    const response = await post(app, "user-snapshot").expect(200);

    expect(response.body.user).not.toHaveProperty("provisionedBy");
    expect(response.body.user.gitKeyHolder).toBe(HOLDER);
  });

  it("leaves a user the service has no resource for on the gateway's own path", async () => {
    const { app, store } = fixture({
      provisioning: legacyProvisioning({ chat: vi.fn(async () => ({ ready: false as const, reason: "NotProvisioned", retryAfterSeconds: 5 })) }),
    });
    await mirrorFully(store);

    const response = await post(app, "user-snapshot").expect(200);

    expect(response.body.user).not.toHaveProperty("provisionedBy");
  });

  it("leaves the user on the gateway's own path and logs an error when the service cannot be read", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const failure = new Error("provisioning service down");
    const { app, store } = fixture({ provisioning: legacyProvisioning({ chat: vi.fn(async () => { throw failure; }) }) });
    await mirrorFully(store);

    const response = await post(app, "user-snapshot").expect(200);

    expect(response.body.user).not.toHaveProperty("provisionedBy");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("user-snapshot"), expect.objectContaining({ err: failure, uid: "uid-alice" }));
  });

  it("names no holder and no service path for a caller whose token binds no pod, and logs it", async () => {
    const warned = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { app, store, provisioning } = fixture({ podName: null });
    await mirrorFully(store);

    const response = await post(app, "user-snapshot").expect(200);

    expect(response.body.user).not.toHaveProperty("provisionedBy");
    expect(response.body.user).not.toHaveProperty("gitKeyHolder");
    expect(provisioning?.chat).not.toHaveBeenCalled();
    expect(warned).toHaveBeenCalledWith(expect.stringContaining("binds no pod"), { uid: "uid-alice", gatewayId: GATEWAY_ID });
  });

  it("leaves the gateway on its own provisioning path without the service", async () => {
    const { app, store } = fixture({ provisioning: null });
    await mirrorFully(store);

    const response = await post(app, "user-snapshot").expect(200);

    expect(response.body.user).not.toHaveProperty("provisionedBy");
    expect(response.body.user).not.toHaveProperty("gitKeyHolder");
  });
});

describe("POST /internal/fleet/provisioning-readiness", () => {
  it("answers 204 once the service reports chat and git ready and every mirrored record matches", async () => {
    const { app, store, provisioning } = fixture();
    await mirrorFully(store);

    await post(app, "provisioning-readiness").expect(204);

    expect(provisioning?.git).toHaveBeenCalledWith("uid-alice", null, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("answers 204 for a fully mirrored user without a default agent", async () => {
    const { app, store, provisioning } = fixture({ provisioning: legacyProvisioning({ chat: vi.fn(async () => readyChat(NO_AGENT_CHAT)) }) });
    await mirrorFully(store, NO_AGENT_CHAT);

    await post(app, "provisioning-readiness").expect(204);

    expect(provisioning?.git).toHaveBeenCalledOnce();
  });

  it("answers 503 WaitingForMirror while only the chat account, agent token and agent channel are mirrored", async () => {
    const { app, store, provisioning } = fixture();
    await mirrorChatAccountTokenAndAgentChannel(store);

    const response = await post(app, "provisioning-readiness").expect(503);

    expect(response.body).toEqual({ error: "provisioning_pending", reason: "WaitingForMirror" });
    expect(provisioning?.git).not.toHaveBeenCalled();
  });

  it("answers 503 WaitingForMirror for a user without a default agent while only the chat account is mirrored", async () => {
    const { app, store } = fixture({ provisioning: legacyProvisioning({ chat: vi.fn(async () => readyChat(NO_AGENT_CHAT)) }) });
    await store.users.records.patch("uid-alice", { mattermostUserId: "mm-alice" });

    const response = await post(app, "provisioning-readiness").expect(503);

    expect(response.body).toEqual({ error: "provisioning_pending", reason: "WaitingForMirror" });
  });

  it.each([
    ["the service reports chat not ready", { chatReason: "ChatTeamFailed" }, "ChatTeamFailed"],
    ["the service reports git not ready", { gitReason: "GitRepositoryFailed" }, "GitRepositoryFailed"],
  ] as const)("answers 503 with the reason while %s", async (_case, scenario, reason) => {
    const s = scenario as { chatReason?: string; gitReason?: string };
    const { app, store } = fixture({
      provisioning: legacyProvisioning({
        ...(s.chatReason ? { chat: vi.fn(async () => ({ ready: false as const, reason: s.chatReason!, retryAfterSeconds: 12 })) } : {}),
        ...(s.gitReason ? { git: vi.fn(async () => ({ ready: false as const, reason: s.gitReason!, retryAfterSeconds: 12 })) } : {}),
      }),
    });
    await mirrorFully(store);

    const response = await post(app, "provisioning-readiness").expect(503);

    expect(response.body).toEqual({ error: "provisioning_pending", reason });
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("answers 422 and logs an error for a user the mirror refuses", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { app, store } = fixture();
    await mirrorFully(store);
    const user = await store.users.records.get("uid-alice");
    await store.users.records.patch("uid-alice", { accountLifecycle: { ...user!.accountLifecycle!, status: "erasing" } });

    const response = await post(app, "provisioning-readiness").expect(422);

    expect(response.body).toEqual({ error: "provisioning_refused", reason: "UserBeingErased" });
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("refusing"), expect.objectContaining({ route: "provisioning-readiness", reason: "UserBeingErased" }));
  });

  it("answers 422 for a user whose provisioning is parked", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const { app } = fixture({
      provisioning: legacyProvisioning({
        chat: vi.fn(async () => ({ ready: false as const, reason: "ChatUserFailed", retryAfterSeconds: 5, refused: true as const })),
      }),
    });

    const response = await post(app, "provisioning-readiness").expect(422);

    expect(response.body).toEqual({ error: "provisioning_refused", reason: "ChatUserFailed" });
  });

  it("refuses a user assigned to another gateway", async () => {
    const { app, provisioning } = fixture({ assignedTo: "shared-green" });

    await post(app, "provisioning-readiness").expect(403);

    expect(provisioning?.chat).not.toHaveBeenCalled();
  });

  it("answers 409 and logs it when the platform is not configured with the service", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { app } = fixture({ provisioning: null });

    const response = await post(app, "provisioning-readiness").expect(409);

    expect(response.body).toEqual({ error: "provisioning_service_not_configured" });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("not configured with the provisioning service"), { route: "provisioning-readiness" });
  });
});

describe("POST /internal/fleet/git-key", () => {
  it("registers the key for the caller's own gateway and answers 204 once it is registered", async () => {
    const { app, provisioning } = fixture();

    await post(app, "git-key", { publicKey: `${PUBLIC_KEY}\n` }).expect(204);

    expect(provisioning?.gitKey).toHaveBeenCalledWith("uid-alice", HOLDER, PUBLIC_KEY, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("refuses a caller whose token binds no pod, since the pod holds the key", async () => {
    const { app, provisioning } = fixture({ podName: null });

    await post(app, "git-key", { publicKey: PUBLIC_KEY }).expect(403);

    expect(provisioning?.gitKey).not.toHaveBeenCalled();
  });

  it("never takes the gateway id from the body", async () => {
    const { app, provisioning } = fixture();

    await post(app, "git-key", { publicKey: PUBLIC_KEY, gatewayId: "shared-green" }).expect(403);

    expect(provisioning?.gitKey).not.toHaveBeenCalled();
  });

  it("refuses a user assigned to another gateway", async () => {
    const { app, provisioning } = fixture({ assignedTo: "shared-green" });

    await post(app, "git-key", { publicKey: PUBLIC_KEY }).expect(403);

    expect(provisioning?.gitKey).not.toHaveBeenCalled();
  });

  it("refuses a body that is not one public key line", async () => {
    const { app, provisioning } = fixture();

    await post(app, "git-key", { publicKey: "-----BEGIN OPENSSH PRIVATE KEY-----" }).expect(400);

    expect(provisioning?.gitKey).not.toHaveBeenCalled();
  });

  it("answers 503 with the reason and Retry-After while the key is not registered", async () => {
    const { app } = fixture({
      provisioning: legacyProvisioning({ gitKey: vi.fn(async () => ({ ready: false as const, reason: "GenerationNotObserved", retryAfterSeconds: 7 })) }),
    });

    const response = await post(app, "git-key", { publicKey: PUBLIC_KEY }).expect(503);

    expect(response.body).toEqual({ error: "provisioning_pending", reason: "GenerationNotObserved" });
    expect(response.headers["retry-after"]).toBe("7");
  });

  it("answers 503 with Retry-After until the service's next attempt for a key held elsewhere", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const nextAttemptAt = new Date(Date.now() + 120_000).toISOString();
    const provisioning = createLegacyProvisioning({
      client: {
        getProvisioning: vi.fn(async () => null),
        getCredential: vi.fn(async () => null),
        deleteGitKey: vi.fn(async () => "deleted" as const),
        putGitKey: vi.fn(async (uid: string, holder: string, spec: { publicKey: string }) => ({
          outcome: "unchanged" as const,
          key: {
            uid, gatewayId: holder, generation: 1, resourceVersion: "2", deletionRequestedAt: null, spec,
            status: { observedGeneration: 1, nextAttemptAt, conditions: [{
              type: "Registered" as const, status: "False" as const, reason: "GitKeyHeldElsewhere" as const, message: "422 from git host",
              lastTransitionTime: "2026-11-16T10:00:00Z", observedGeneration: 1,
            }] },
          },
        })),
      },
    });
    const { app } = fixture({ provisioning });

    const response = await post(app, "git-key", { publicKey: PUBLIC_KEY }).expect(503);

    expect(response.body).toEqual({ error: "provisioning_pending", reason: "GitKeyHeldElsewhere" });
    expect(Number(response.headers["retry-after"])).toBeGreaterThanOrEqual(119);
  });

  it("answers 409 without the service", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const { app } = fixture({ provisioning: null });

    const response = await post(app, "git-key", { publicKey: PUBLIC_KEY }).expect(409);

    expect(response.body).toEqual({ error: "provisioning_service_not_configured" });
  });
});

describe("POST /internal/fleet/git-key/release", () => {
  it("releases only the caller's own gateway key while it holds the caller's public key, also after the user moved away", async () => {
    const { app, provisioning } = fixture({ assignedTo: "shared-green" });

    await post(app, "git-key/release", { publicKey: PUBLIC_KEY }).expect(204);

    expect(provisioning?.releaseGitKey).toHaveBeenCalledWith("uid-alice", HOLDER, PUBLIC_KEY, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("refuses a caller whose token binds no pod", async () => {
    const { app, provisioning } = fixture({ podName: null });

    await post(app, "git-key/release", { publicKey: PUBLIC_KEY }).expect(403);

    expect(provisioning?.releaseGitKey).not.toHaveBeenCalled();
  });

  it("leaves a newer registration in place when the release races it", async () => {
    const logged = vi.spyOn(logger, "info").mockImplementation(() => {});
    const { app } = fixture({ provisioning: legacyProvisioning({ releaseGitKey: vi.fn(async () => "superseded" as const) }) });

    await post(app, "git-key/release", { publicKey: PUBLIC_KEY }).expect(204);

    expect(logged).toHaveBeenCalledWith(expect.stringContaining("newer registration"), { uid: "uid-alice", holder: HOLDER });
  });

  it("refuses a release without the public key it releases", async () => {
    const { app, provisioning } = fixture();

    await post(app, "git-key/release").expect(400);

    expect(provisioning?.releaseGitKey).not.toHaveBeenCalled();
  });

  it("refuses a gateway id in the body that is not the caller's", async () => {
    const { app, provisioning } = fixture();

    await post(app, "git-key/release", { gatewayId: "shared-green", publicKey: PUBLIC_KEY }).expect(403);

    expect(provisioning?.releaseGitKey).not.toHaveBeenCalled();
  });

  it("answers 404 for a uid that names no user", async () => {
    const { app, provisioning } = fixture();

    await request(app).post("/internal/fleet/git-key/release").send({ uid: "uid-nobody", publicKey: PUBLIC_KEY }).expect(404);

    expect(provisioning?.releaseGitKey).not.toHaveBeenCalled();
  });
});
