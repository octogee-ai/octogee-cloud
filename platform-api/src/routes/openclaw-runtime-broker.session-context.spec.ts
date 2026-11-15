import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceChannel } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { receiptDocumentId } from "../../../gateway-edge/src/chat-proxy/openclaw/activity-write-receipts.js";
import {
  createOpenClawRuntimeBrokerRoutes,
  type SessionChannelPurposeReader,
} from "./openclaw-runtime-broker.js";

const SESSION = "s".repeat(26);
const EVENT_KEY = "a".repeat(64);
const docs: Record<string, Record<string, unknown>> = {
  "users/owner": { username: "bob", provisioning: { openclaw: { gatewayId: "builder-bob" } } },
  "workspaces/bob": { id: "bob", ownerUid: "owner" },
  "workspaces/bob/channels/tripplan": { kind: "session", mattermost: { channelId: SESSION } },
};

function app(opts: { readSessionChannelPurpose?: SessionChannelPurposeReader; documents?: Record<string, Record<string, unknown>> } = {}) {
  const server = express();
  server.use(express.json(), (req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: "builder-bob" } as Express.Request["boundTenant"];
    next();
  });
  server.use(createOpenClawRuntimeBrokerRoutes({
    store: createDocumentFixtureStore(opts.documents ?? structuredClone(docs)),
    readSizingKey: async () => null,
    ...(opts.readSessionChannelPurpose ? { readSessionChannelPurpose: opts.readSessionChannelPurpose } : {}),
  }));
  return server;
}

function sessionContext(server: express.Express) {
  return request(server).post("/activity/session-context").send({ agentId: "octogee-bob-coach", accountId: "bob-coach", channelId: SESSION });
}

describe("session channel context", () => {
  it("carries the purpose the product reads for the session channel", async () => {
    const readSessionChannelPurpose = vi.fn<SessionChannelPurposeReader>(async () => "Plan the Lisbon trip");
    const { status, body } = await sessionContext(app({ readSessionChannelPurpose }));
    expect({ status, body }).toEqual({ status: 200, body: { authorized: true, purpose: "Plan the Lisbon trip" } });
    expect(readSessionChannelPurpose.mock.calls.map(([channel]: [WorkspaceChannel]) => [channel.scope, channel.channelId])).toEqual([
      [{ workspaceSlug: "bob", projectSlug: null }, "tripplan"],
    ]);
  });

  it("authorizes the session channel without a purpose when no product reads purposes", async () => {
    const { status, body } = await sessionContext(app());
    expect({ status, body }).toEqual({ status: 200, body: { authorized: true } });
  });
});

describe("activity write receipts", () => {
  const channelDocPath = "workspaces/bob/channels/tripplan";
  const claimBody = {
    channelDocPath,
    input: { eventKey: EVENT_KEY, payloadDigest: "b".repeat(64), historyAnchorPostId: "p".repeat(26), leaseOwner: "worker-1", now: 1_000, leaseMs: 5_000 },
  };

  it("claims and reads the channel's receipt in platform state", async () => {
    const documents = structuredClone(docs);
    const server = app({ documents });
    const claim = await request(server).post("/activity/write-receipts/claim").send(claimBody);
    expect(claim.status).toBe(200);
    expect(claim.body).toMatchObject({ outcome: "claimed" });
    const read = await request(server).post("/activity/write-receipts/read").send({ channelDocPath, eventKey: EVENT_KEY });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ receipt: { eventKey: EVENT_KEY, leaseOwner: "worker-1", state: "claimed" } });
    expect(documents[`${channelDocPath}/activityWriteReceipts/${receiptDocumentId(EVENT_KEY)}`]).toMatchObject({ state: "claimed", leaseOwner: "worker-1" });
  });

  it("refuses a receipt for a channel platform state does not hold", async () => {
    const response = await request(app()).post("/activity/write-receipts/claim").send({ ...claimBody, channelDocPath: "workspaces/bob/channels/gone" });
    expect({ status: response.status, body: response.body }).toEqual({ status: 404, body: { error: "receipt_channel_not_found" } });
  });
});
