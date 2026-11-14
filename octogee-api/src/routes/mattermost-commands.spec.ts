import { generateKeyPairSync } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { signMattermostCommandRequest } from "../../../gateway-edge/src/agent-control-callback-router.js";
import { RecordingDocuments } from "../test-helpers/recording-documents.js";
import { createMattermostCommandRoutes } from "./mattermost-commands.js";
import { createOpenClawControlBrokerRoutes } from "./openclaw-control-broker.js";

const { privateKey: ROUTER_KEY, publicKey: ROUTER_PUBLIC_KEY } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const API_ORIGIN = "https://api-test.octogee.com";
const OWNER_MM = "ownermmuserid0000000000000";
const SHARED_MM = "sharedmmuserid000000000000";
const STRANGER_MM = "strangermmuserid0000000000";
const UNKNOWN_MM = "unknownmmuserid00000000000";
const TEAM = "teamid00000000000000000000";
const COMMAND_TOKEN = "slash-command-token";
const SESSION_ID = "7f9b8a1e-429d-4c43-9e1a-9f3bd49d9a70";
const TICKETS = "openclawControlTickets/";

function isolatedRoot(gatewayId: string, ownerUid: string, slug: string) {
  return {
    gatewayId, createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
    latestRelease: 2, desiredRelease: 2, liveRelease: 2, desiredStatus: "running", configSchemaVersion: 1,
    profile: "isolated", gatewayClass: "isolated", imageProfile: "isolated", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null,
    builderAccess: { controlUiEnabled: true }, ownerUid, builderSlug: slug,
    modelBrokerLimits: null, preemption: null, coOwnerUids: [],
  };
}

function servingRuntime(gatewayId: string, now: number) {
  return {
    docKind: "runtime", gatewayId, release: 2, lifecycle: "serving", createdAt: 1, createdByOperationId: null, helm: {},
    heartbeat: {
      status: "ready",
      lastHeartbeatAt: now,
      configStatus: {
        runtimeReady: true, runtimeHealth: "healthy", runtimeHealthCheckedAt: new Date(now).toISOString(), observedAt: now,
        freezeState: "unfrozen", openclawVersion: "main", openclawForkSha: "current",
        controlProtocol: { protocol: "durable-openclaw-config", version: 2 },
        dashboardControlState: "ready",
        dashboardControlProtocol: { protocol: "openclaw-dashboard-bridge", version: 1 },
        dashboardControlObservedAt: new Date(now).toISOString(),
      },
    },
    lastError: { message: null, at: null },
  };
}

function user(slug: string, gatewayId: string, mattermostUserId: string) {
  return { username: slug, mattermost: { userId: mattermostUserId }, provisioning: { openclaw: { gatewayId, slug } } };
}

function fixture(now: number) {
  const docs = new RecordingDocuments({
    "gateways/walter": isolatedRoot("walter", "uid-owner", "ceckert"),
    "gateways/walter/assignments/uid-owner": {
      uid: "uid-owner", slug: "ceckert", gatewayId: "walter", source: "onboarding", state: "serving",
      epoch: 1, createdAt: 1, updatedAt: 1, updatedByOperationId: null,
    },
    "glmGateways/walter": servingRuntime("walter", now),
    "users/uid-owner": user("ceckert", "walter", OWNER_MM),
    "gateways/shared-0": {
      ...isolatedRoot("shared-0", "", ""),
      profile: "standard", gatewayClass: "shared", imageProfile: "standard",
      builderAccess: null, ownerUid: null, builderSlug: null,
    },
    "glmGateways/shared-0": servingRuntime("shared-0", now),
    "users/uid-shared": user("lin", "shared-0", SHARED_MM),
    "users/uid-stranger": user("ceckert", "walter", STRANGER_MM),
  });
  return { docs, store: createDocumentFixtureStore(docs) };
}

function launchAttachmentText(body: { attachments?: Array<{ text?: string }> }): string {
  expect(body.attachments).toHaveLength(1);
  return body.attachments![0]!.text!;
}

function ticketPaths(docs: RecordingDocuments): string[] {
  return [...docs.keys()].filter((path) => path.startsWith(TICKETS));
}

function commandApp(store: PlatformStateStore, commandTokenMatches = vi.fn(async (input: { token: string }) => input.token === COMMAND_TOKEN)) {
  const app = express();
  app.use("/internal/mattermost/commands", createMattermostCommandRoutes({
    store,
    routerPublicKey: ROUTER_PUBLIC_KEY,
    commandTokenMatches,
    log: () => undefined,
  }));
  return { app, commandTokenMatches };
}

function slashCommand(mattermostUserId: string, token = COMMAND_TOKEN): string {
  return new URLSearchParams({
    channel_id: "channelid00000000000000000",
    channel_name: "ceckert-coach",
    command: "/ui",
    response_url: "http://mattermost:8065/hooks/commands/x",
    team_domain: "ceckert",
    team_id: TEAM,
    text: "",
    token,
    trigger_id: "trigger",
    user_id: mattermostUserId,
    user_name: "someone",
  }).toString();
}

function invoke(app: express.Express, body: string, signed = true) {
  const timestamp = String(Date.now());
  const req = request(app)
    .post("/internal/mattermost/commands/control-ui")
    .set("content-type", "application/x-www-form-urlencoded");
  if (signed) {
    req
      .set("x-octogee-mattermost-command", "control-ui")
      .set("x-octogee-mattermost-command-timestamp", timestamp)
      .set("x-octogee-mattermost-command-signature", signMattermostCommandRequest(Buffer.from(body), "control-ui", timestamp, ROUTER_KEY));
  }
  return req.send(body);
}

function redeemApp(store: PlatformStateStore, now: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.boundTenant = {
      kind: "gateway",
      gatewayId: "walter",
      podName: "octogee-gateway-walter-r2-5bc5949d46-p946t",
      actor: "gateway",
      subject: "system:serviceaccount:octogee:octogee-gw-walter",
      serviceAccountName: "octogee-gw-walter",
    } as Express.Request["boundTenant"];
    next();
  });
  app.use("/internal/openclaw-control", createOpenClawControlBrokerRoutes({
    store,
    readSizingKey: () => { throw new Error("owner tickets never read a sizing key"); },
    now: () => now,
  }));
  return app;
}

describe("Mattermost /ui command", () => {
  beforeEach(() => {
    vi.stubEnv("API_PUBLIC_URL", API_ORIGIN);
  });

  it("gives the owner of an isolated gateway an ephemeral one-time Control UI link, only inside a message attachment so Mattermost never previews it", async () => {
    const { docs, store } = fixture(Date.now());
    const { app, commandTokenMatches } = commandApp(store);

    const response = await invoke(app, slashCommand(OWNER_MM));

    expect(response.status).toBe(200);
    expect(response.body.response_type).toBe("ephemeral");
    const attachmentText = launchAttachmentText(response.body);
    const link = new URL(/^\[Open your Control UI\]\(([^)\s]+)\)\n/.exec(attachmentText)![1]!);
    expect(link.origin).toBe(API_ORIGIN);
    expect(link.pathname).toMatch(/^\/g\/walter\/openclaw\/launch\/[A-Za-z0-9_-]{43}$/);
    expect(attachmentText).toContain("works once");
    expect(JSON.stringify({ ...response.body, attachments: response.body.attachments.map(({ text: _text, ...rest }: { text: string }) => rest) }))
      .not.toContain("/launch/");
    expect(commandTokenMatches).toHaveBeenCalledWith({ teamId: TEAM, trigger: "ui", token: COMMAND_TOKEN });
    const tickets = ticketPaths(docs);
    expect(tickets).toHaveLength(1);
    expect(docs.get(tickets[0]!)).toMatchObject({ uid: "uid-owner", gatewayId: "walter", workspaceSlug: "ceckert" });
  });

  it("refuses a user on a shared gateway: the Control UI is for isolated gateways only", async () => {
    const { docs, store } = fixture(Date.now());

    const response = await invoke(commandApp(store).app, slashCommand(SHARED_MM));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      response_type: "ephemeral",
      text: expect.stringContaining("only for isolated gateways"),
    });
    expect(response.body.text).not.toContain("/launch/");
    expect(ticketPaths(docs)).toEqual([]);
  });

  it("refuses a user whose isolated gateway belongs to someone else, and a Mattermost user with no account", async () => {
    const { docs, store } = fixture(Date.now());
    const { app } = commandApp(store);

    for (const mattermostUserId of [STRANGER_MM, UNKNOWN_MM]) {
      const response = await invoke(app, slashCommand(mattermostUserId));
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        response_type: "ephemeral",
        text: "The Control UI opens only for the owner of an isolated gateway.",
      });
    }
    expect(ticketPaths(docs)).toEqual([]);
  });

  it("issues a link that redeems exactly once", async () => {
    const now = Date.now();
    const { store } = fixture(now);
    const text = launchAttachmentText((await invoke(commandApp(store).app, slashCommand(OWNER_MM))).body);
    const ticket = /\/openclaw\/launch\/([A-Za-z0-9_-]+)\)/.exec(text)![1]!;
    const redeem = () => request(redeemApp(store, now)).post("/internal/openclaw-control/redeem")
      .send({ gatewayId: "walter", revisionId: "walter", sessionId: SESSION_ID, ticket });

    const first = await redeem();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ uid: "uid-owner", gatewayId: "walter", workspaceSlug: "ceckert" });
    const replay = await redeem();
    expect([replay.status, replay.body]).toEqual([404, { error: "ticket-invalid" }]);
  });

  it("accepts only requests the Mattermost callback router signed", async () => {
    const { docs, store } = fixture(Date.now());
    const { app, commandTokenMatches } = commandApp(store);

    const unsigned = await invoke(app, slashCommand(OWNER_MM), false);
    const tampered = await request(app)
      .post("/internal/mattermost/commands/control-ui")
      .set("x-octogee-mattermost-command", "control-ui")
      .set("x-octogee-mattermost-command-timestamp", String(Date.now()))
      .set("x-octogee-mattermost-command-signature", signMattermostCommandRequest(
        Buffer.from(slashCommand(SHARED_MM)), "control-ui", String(Date.now()), ROUTER_KEY))
      .send(slashCommand(OWNER_MM));

    expect(unsigned.status).toBe(401);
    expect(tampered.status).toBe(401);
    expect(commandTokenMatches).not.toHaveBeenCalled();
    expect(ticketPaths(docs)).toEqual([]);
  });

  it("rate-limits callers that the router did not sign, by client address", async () => {
    const { store } = fixture(Date.now());
    const { app } = commandApp(store);
    const unsigned = () => invoke(app, slashCommand(OWNER_MM), false);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 301; attempt += 1) statuses.push((await unsigned()).status);

    expect(statuses.slice(0, 300).every((status) => status === 401)).toBe(true);
    expect(statuses[300]).toBe(429);
  });

  it("keeps one user's flood of signed /ui commands from locking out other users behind the same router", async () => {
    const { docs, store } = fixture(Date.now());
    const { app } = commandApp(store);

    for (let attempt = 0; attempt < 301; attempt += 1) {
      const flood = await invoke(app, slashCommand(STRANGER_MM));
      expect(flood.status).toBe(200);
    }
    const owner = await invoke(app, slashCommand(OWNER_MM));

    expect(owner.status).toBe(200);
    expect(launchAttachmentText(owner.body)).toContain("/openclaw/launch/");
    expect(ticketPaths(docs)).toHaveLength(1);
  });

  it("keeps a team admin's other slash commands, signed by the router and rejected here, from locking out /ui", async () => {
    const { docs, store } = fixture(Date.now());
    const { app } = commandApp(store);
    const otherCommand = slashCommand(STRANGER_MM).replace("command=%2Fui", "command=%2Fx");

    for (let attempt = 0; attempt < 301; attempt += 1) {
      const rejected = await invoke(app, otherCommand);
      expect(rejected.status).toBe(400);
    }
    const owner = await invoke(app, slashCommand(OWNER_MM));

    expect(owner.status).toBe(200);
    expect(launchAttachmentText(owner.body)).toContain("/openclaw/launch/");
    expect(ticketPaths(docs)).toHaveLength(1);
  });

  it("refuses a signed request whose token is not the team's /ui command, such as an outgoing webhook", async () => {
    const { docs, store } = fixture(Date.now());

    const response = await invoke(commandApp(store).app, slashCommand(OWNER_MM, "outgoing-webhook-token"));

    expect([response.status, response.body]).toEqual([403, { error: "forbidden" }]);
    expect(ticketPaths(docs)).toEqual([]);
  });
});
