import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { PlatformUserRecord, PlatformStateRepositories, Stored } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import { createProductivityRateLimiter } from "../lib/agent-productivity/rate-limit.js";
import {
  OWNER_AUTOMATIONS_PROOF_PATH,
  ownerAutomationProofSignature,
} from "../lib/owner-automation-authorization.js";
import { fixtureUser } from "../test-helpers/fixture-users.js";
import { createOwnerAutomationAuthorizationBrokerRoutes } from "./owner-automation-authorization-broker.js";

const NOW = 1_800_000_000_000;
const OWNER_MM = "o".repeat(26);
const MEMBER_MM = "m".repeat(26);
const DEFAULT_AGENT_CHANNEL = "c".repeat(26);
const GENERAL_CHANNEL = "g".repeat(26);
const AGENT = "octogee-acme-coach";

function liveContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: "mattermost",
    accountId: "acme-coach",
    requesterSenderId: OWNER_MM,
    nativeChannelId: DEFAULT_AGENT_CHANNEL,
    to: `channel:${DEFAULT_AGENT_CHANNEL}`,
    ...overrides,
  };
}

function signedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: AGENT,
    requestContext: liveContext(),
    action: "save",
    params: { key: "weekday-brief" },
    ...overrides,
  };
}

function records(overrides: Record<string, Record<string, unknown> | undefined> = {}) {
  return {
    "workspaces/acme": { id: "acme", ownerUid: "owner-acme", ownerActive: true },
    "workspaces/acme/channels/coach-dm": { mattermost: { channelId: DEFAULT_AGENT_CHANNEL } },
    "users/owner-acme/secrets/coachMattermost": { personalToken: "acme-coach-pat" },
    ...overrides,
  };
}

const ASSIGNED = fixtureUser("owner-acme", { workspaceId: "acme", mattermostUserId: OWNER_MM });

function app(opts: {
  docs?: Record<string, Record<string, unknown> | undefined>;
  assigned?: Stored<PlatformUserRecord> | null;
  bound?: boolean;
  limit?: number;
  readLimit?: number;
} = {}): { server: Express; findAssignedUser: ReturnType<typeof vi.fn> } {
  const docs = opts.docs ?? records();
  const findAssignedUser = vi.fn(async (_store: PlatformStateRepositories, gatewayId: string, agentId: string) =>
    gatewayId === "shared-b" && agentId === AGENT ? (opts.assigned === undefined ? ASSIGNED : opts.assigned) : null);
  const server = express();
  server.use(express.json());
  if (opts.bound !== false) {
    server.use((req, _res, next) => {
      req.boundTenant = { kind: "gateway", gatewayId: "shared-b" };
      next();
    });
  }
  server.use("/internal/owner-automations", createOwnerAutomationAuthorizationBrokerRoutes({
    store: createDocumentFixtureStore(docs),
    findAssignedUser,
    now: () => NOW,
    rateLimiter: createProductivityRateLimiter({ now: () => NOW, limits: { write: opts.limit ?? 20, read: opts.readLimit ?? 60 } }),
  }));
  return { server, findAssignedUser };
}

function authorizeBody(
  body: Record<string, unknown> = signedBody(),
  opts: { secret?: string; timestamp?: number; gatewayId?: string } = {},
): Record<string, unknown> {
  const serialized = JSON.stringify(body);
  const timestamp = String(opts.timestamp ?? NOW);
  return {
    gatewayId: opts.gatewayId ?? "shared-b",
    proof: {
      timestamp,
      signature: ownerAutomationProofSignature(
        opts.secret ?? "acme-coach-pat",
        timestamp,
        OWNER_AUTOMATIONS_PROOF_PATH,
        serialized,
      ),
      body: serialized,
    },
  };
}

function post(server: Express, body: Record<string, unknown>) {
  return request(server).post("/internal/owner-automations/authorize").send(body);
}

describe("owner automation authorization broker", () => {
  it("authorizes the assigned owner in their Agent channel and names the tenant", async () => {
    const res = await post(app().server, authorizeBody());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      gatewayId: "shared-b",
      slug: "acme",
      agentId: AGENT,
      ownerMattermostUserId: OWNER_MM,
      coachChannelId: DEFAULT_AGENT_CHANNEL,
    });
  });

  it("authorizes the owner's direct route from the Agent channel", async () => {
    const body = signedBody({ requestContext: liveContext({ to: `user:${OWNER_MM}` }) });

    expect((await post(app().server, authorizeBody(body))).status).toBe(200);
  });

  it.each([
    ["a collaborator in the Agent channel", liveContext({ requesterSenderId: MEMBER_MM })],
    ["the owner in the general channel", liveContext({ nativeChannelId: GENERAL_CHANNEL, to: `channel:${GENERAL_CHANNEL}` })],
    ["a route to another channel", liveContext({ to: `channel:${GENERAL_CHANNEL}` })],
    ["a direct route to someone else", liveContext({ to: `user:${MEMBER_MM}` })],
    ["another agent account", liveContext({ accountId: "victim-coach" })],
    ["a scheduled run", { origin: "scheduled", channel: "mattermost", accountId: "acme-coach", requesterSenderId: OWNER_MM, to: `user:${OWNER_MM}` }],
    ["a missing context", undefined],
    ["an extra owner claim", liveContext({ senderIsOwner: true })],
  ])("rejects %s", async (_label, requestContext) => {
    const res = await post(app().server, authorizeBody(signedBody({ requestContext })));

    expect(res.status).toBe(403);
  });

  it("rejects a project agent and an unknown agent", async () => {
    for (const agentId of ["octogee-acme-proj-orbit-coach", "octogee-victim-coach"]) {
      expect((await post(app().server, authorizeBody(signedBody({ agentId })))).status).toBe(403);
    }
  });

  it.each([
    ["a workspace owned by someone else", { "workspaces/acme": { id: "acme", ownerUid: "owner-victim", ownerActive: true } }],
    ["an inactive workspace owner", { "workspaces/acme": { id: "acme", ownerUid: "owner-acme", ownerActive: false } }],
    ["an archived Agent channel", { "workspaces/acme/channels/coach-dm": { mattermost: { channelId: DEFAULT_AGENT_CHANNEL }, archivedAt: 1 } }],
    ["a missing Agent channel", { "workspaces/acme/channels/coach-dm": undefined }],
    ["a missing proof secret", { "users/owner-acme/secrets/coachMattermost": undefined }],
  ])("rejects %s", async (_label, overrides) => {
    const res = await post(app({ docs: records(overrides) }).server, authorizeBody());

    expect(res.status).toBe(403);
  });

  it("rejects an agent that is not assigned to this gateway or is suspended", async () => {
    expect((await post(app({ assigned: null }).server, authorizeBody())).status).toBe(403);
    const suspended = fixtureUser("owner-acme", { ...ASSIGNED, accountLifecycle: { status: "suspended" } });
    expect((await post(app({ assigned: suspended }).server, authorizeBody())).status).toBe(403);
  });

  it("rejects a proof signed with another secret, a stale proof, or a changed body", async () => {
    const { server } = app();
    expect((await post(server, authorizeBody(signedBody(), { secret: "victim-coach-pat" }))).status).toBe(403);
    expect((await post(server, authorizeBody(signedBody(), { timestamp: NOW - 31_000 }))).status).toBe(403);
    const tampered = authorizeBody();
    (tampered.proof as Record<string, unknown>).body = JSON.stringify(signedBody({ params: { key: "other" } }));
    expect((await post(server, tampered)).status).toBe(403);
  });

  it("rejects a caller without a gateway binding or claiming another gateway, before any lookup", async () => {
    const unbound = app({ bound: false });
    expect((await post(unbound.server, authorizeBody())).status).toBe(403);
    const other = app();
    expect((await post(other.server, authorizeBody(signedBody(), { gatewayId: "shared-victim" }))).status).toBe(403);
    expect(unbound.findAssignedUser).not.toHaveBeenCalled();
    expect(other.findAssignedUser).not.toHaveBeenCalled();
  });

  it("rate-limits authorized writes per gateway and agent", async () => {
    const { server } = app({ limit: 1 });
    expect((await post(server, authorizeBody())).status).toBe(200);
    expect((await post(server, authorizeBody())).status).toBe(429);
  });

  it("charges a list to the read limit, not the write limit", async () => {
    const { server } = app({ limit: 1, readLimit: 2 });
    const list = signedBody({ action: "list", params: {} });
    expect((await post(server, authorizeBody(list))).status).toBe(200);
    expect((await post(server, authorizeBody(list))).status).toBe(200);
    expect((await post(server, authorizeBody())).status).toBe(200);
    expect((await post(server, authorizeBody(list))).status).toBe(429);
  });
});
