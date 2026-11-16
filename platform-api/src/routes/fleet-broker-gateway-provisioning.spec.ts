import express, { type RequestHandler } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { ProvisioningServiceError } from "@octogee/core/provisioning-service-client";
import { logger } from "@octogee/core/http/logging";
import { mmUpdateFromChatOutputs } from "@octogee/core/provisioning-mirror";
import { buildProvisioningContext, markProvisioningComplete, noProvisioningProjection } from "@octogee/core/provisionSteps";
import { workspaceDefaultAgentChannelName } from "@octogee/shared/types/identity";
import { installDefaultUserEntitlements } from "@octogee/shared/types/user-entitlements";
import type { ChatOutputs, GitKey, UserProvisioning } from "@octogee/shared/types/provisioning-service";
import { NO_BROKER_RECORDS, type BrokerRecords } from "../lib/broker-records.js";
import type { LegacyProvisioning, ProvisioningWait } from "../lib/legacy-provisioning.js";
import type { ProvisioningGitKeys } from "../lib/provisioning-git-keys.js";
import { RecordingDocuments } from "../test-helpers/recording-documents.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const GATEWAY_ID = "shared-blue";
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
    ...overrides,
  };
}

function gitKey(overrides: { publicKey?: string; generation?: number; observedGeneration?: number; registered?: "True" | "False"; reason?: string; message?: string } = {}): GitKey {
  const generation = overrides.generation ?? 1;
  return {
    uid: "uid-alice",
    gatewayId: GATEWAY_ID,
    generation,
    resourceVersion: "7",
    deletionRequestedAt: null,
    spec: { publicKey: overrides.publicKey ?? PUBLIC_KEY },
    status: {
      observedGeneration: overrides.observedGeneration ?? generation,
      conditions: [{
        type: "Registered",
        status: overrides.registered ?? "True",
        reason: (overrides.reason ?? "Converged") as never,
        message: overrides.message ?? "",
        lastTransitionTime: "2026-11-15T18:00:00Z",
        observedGeneration: overrides.observedGeneration ?? generation,
      }],
    },
  };
}

function gitKeys(overrides: Partial<ProvisioningGitKeys> = {}): ProvisioningGitKeys {
  return {
    putGitKey: vi.fn(async () => gitKey()),
    deleteGitKey: vi.fn(async () => "deleted" as const),
    ...overrides,
  };
}

interface Options {
  provisioning?: LegacyProvisioning | null;
  keys?: ProvisioningGitKeys | null;
  assignedTo?: string;
  boundGatewayId?: string;
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
  const keys = options.keys === undefined ? gitKeys() : options.keys;
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: options.boundGatewayId ?? GATEWAY_ID, tokenSource: "ksa" } as never;
    next();
  }) as RequestHandler);
  app.use("/internal/fleet", createFleetBrokerRoutes({ store, records, legacyProvisioning: provisioning, provisioningGitKeys: keys }));
  return { app, store, provisioning, keys };
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
  it("tells the gateway to mount through the provisioning service when the platform is configured with it", async () => {
    const { app } = fixture();

    const response = await post(app, "user-snapshot").expect(200);

    expect(response.body.user.provisionedBy).toBe("service");
  });

  it("leaves the gateway on its own provisioning path without the service", async () => {
    const { app } = fixture({ provisioning: null });

    const response = await post(app, "user-snapshot").expect(200);

    expect(response.body.user).not.toHaveProperty("provisionedBy");
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
    const { app, store } = fixture({ provisioning: legacyProvisioning({ chat: vi.fn(async () => readyChat(NO_AGENT_CHAT)) }) });
    await mirrorFully(store, NO_AGENT_CHAT);

    await post(app, "provisioning-readiness").expect(204);
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
  it("writes the key for the caller's own gateway and answers 204 once it is registered", async () => {
    const { app, keys } = fixture();

    await post(app, "git-key", { publicKey: `${PUBLIC_KEY}\n` }).expect(204);

    expect(keys?.putGitKey).toHaveBeenCalledWith("uid-alice", GATEWAY_ID, PUBLIC_KEY);
  });

  it("never takes the gateway id from the body", async () => {
    const { app, keys } = fixture();

    await post(app, "git-key", { publicKey: PUBLIC_KEY, gatewayId: "shared-green" }).expect(403);

    expect(keys?.putGitKey).not.toHaveBeenCalled();
  });

  it("refuses a user assigned to another gateway", async () => {
    const { app, keys } = fixture({ assignedTo: "shared-green" });

    await post(app, "git-key", { publicKey: PUBLIC_KEY }).expect(403);

    expect(keys?.putGitKey).not.toHaveBeenCalled();
  });

  it("refuses a body that is not one public key line", async () => {
    const { app, keys } = fixture();

    await post(app, "git-key", { publicKey: "-----BEGIN OPENSSH PRIVATE KEY-----" }).expect(400);

    expect(keys?.putGitKey).not.toHaveBeenCalled();
  });

  it.each([
    ["the service has not observed the write", gitKey({ generation: 2, observedGeneration: 1 }), "GenerationNotObserved"],
    ["the service reports the key not registered", gitKey({ registered: "False", reason: "GitKeyFailed" }), "GitKeyFailed"],
    ["the row now holds another key", gitKey({ publicKey: "ssh-ed25519 AAAAother" }), "GitKeyReplaced"],
  ] as const)("answers 503 with the reason while %s", async (_case, key, reason) => {
    const { app } = fixture({ keys: gitKeys({ putGitKey: vi.fn(async () => key) }) });

    const response = await post(app, "git-key", { publicKey: PUBLIC_KEY }).expect(503);

    expect(response.body).toEqual({ error: "provisioning_pending", reason });
  });

  it("answers 422 and logs an error when the service refuses the key as held elsewhere", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const refused = gitKey({ registered: "False", reason: "GitKeyFailed", message: "registered under a holder this service does not manage; left unchanged" });
    const { app } = fixture({ keys: gitKeys({ putGitKey: vi.fn(async () => refused) }) });

    const response = await post(app, "git-key", { publicKey: PUBLIC_KEY }).expect(422);

    expect(response.body).toEqual({ error: "provisioning_refused", reason: "GitKeyHeldElsewhere" });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("refusing"), expect.objectContaining({ route: "git-key", reason: "GitKeyHeldElsewhere" }));
  });

  it("answers 503 with the service's Retry-After while it is unavailable", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const { app } = fixture({
      keys: gitKeys({ putGitKey: vi.fn(async () => { throw new ProvisioningServiceError(503, "unavailable" as never, "down", 30_000); }) }),
    });

    const response = await post(app, "git-key", { publicKey: PUBLIC_KEY }).expect(503);

    expect(response.headers["retry-after"]).toBe("30");
    expect(response.body.reason).toBe("ProvisioningServiceUnavailable");
  });

  it("answers 503 NotProvisioned for a user the service has no resource for", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const { app } = fixture({
      keys: gitKeys({ putGitKey: vi.fn(async () => { throw new ProvisioningServiceError(404, "not-found", "no provisioning for this user"); }) }),
    });

    const response = await post(app, "git-key", { publicKey: PUBLIC_KEY }).expect(503);

    expect(response.body.reason).toBe("NotProvisioned");
  });

  it("answers 409 without the service", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const { app } = fixture({ keys: null });

    const response = await post(app, "git-key", { publicKey: PUBLIC_KEY }).expect(409);

    expect(response.body).toEqual({ error: "provisioning_service_not_configured" });
  });
});

describe("POST /internal/fleet/git-key/release", () => {
  it("releases only the caller's own gateway key while it holds the caller's public key, also after the user moved away", async () => {
    const { app, keys } = fixture({ assignedTo: "shared-green" });

    await post(app, "git-key/release", { publicKey: PUBLIC_KEY }).expect(204);

    expect(keys?.deleteGitKey).toHaveBeenCalledWith("uid-alice", GATEWAY_ID, { expectedPublicKey: PUBLIC_KEY });
  });

  it("leaves a newer registration in place when the release races it", async () => {
    const logged = vi.spyOn(logger, "info").mockImplementation(() => {});
    const { app } = fixture({ keys: gitKeys({ deleteGitKey: vi.fn(async () => "superseded" as const) }) });

    await post(app, "git-key/release", { publicKey: PUBLIC_KEY }).expect(204);

    expect(logged).toHaveBeenCalledWith(expect.stringContaining("newer registration"), { uid: "uid-alice", gatewayId: GATEWAY_ID });
  });

  it("refuses a release without the public key it releases", async () => {
    const { app, keys } = fixture();

    await post(app, "git-key/release").expect(400);

    expect(keys?.deleteGitKey).not.toHaveBeenCalled();
  });

  it("refuses a gateway id in the body that is not the caller's", async () => {
    const { app, keys } = fixture();

    await post(app, "git-key/release", { gatewayId: "shared-green", publicKey: PUBLIC_KEY }).expect(403);

    expect(keys?.deleteGitKey).not.toHaveBeenCalled();
  });

  it("answers 404 for a uid that names no user", async () => {
    const { app, keys } = fixture();

    await request(app).post("/internal/fleet/git-key/release").send({ uid: "uid-nobody", publicKey: PUBLIC_KEY }).expect(404);

    expect(keys?.deleteGitKey).not.toHaveBeenCalled();
  });
});
