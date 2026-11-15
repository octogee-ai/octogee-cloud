import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createOpenClawRuntimeBrokerRoutes } from "./openclaw-runtime-broker.js";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

let documents: Record<string, Record<string, unknown>> = {};

function app() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: "gw-alice", ownerUid: "uid-alice" };
    next();
  });
  app.use("/internal/openclaw", createOpenClawRuntimeBrokerRoutes({ store: createDocumentFixtureStore(documents), readSizingKey: async () => { throw new Error("no tier reads expected"); } }));
  return app;
}

beforeEach(() => {
  documents = {
    "users/uid-alice": { username: "alice", provisioning: { openclaw: { gatewayId: "gw-alice", slug: "alice" } } },
    "workspaces/alice/channels/coach-dm": { kind: "coach-dm", mattermost: { channelId: "primary" } },
  };
});

describe("channel projection target", () => {
  it("returns the canonical channel target", async () => {
    const response = await request(app())
      .post("/internal/openclaw/activity/channel-target")
      .send({ primaryChannelId: "primary" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      target: {
        primaryChannelId: "primary",
        channelDocPath: "workspaces/alice/channels/coach-dm",
      },
    });
  });

  it("does not expose the removed channel-pair route", async () => {
    const response = await request(app())
      .post("/internal/openclaw/activity/channel-pair")
      .send({ primaryChannelId: "primary" });

    expect(response.status).toBe(404);
  });

  it("does not resolve an unknown channel target", async () => {
    const response = await request(app())
      .post("/internal/openclaw/activity/channel-target")
      .send({ primaryChannelId: "unknown-channel" });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "not_found" });
  });

  it("refuses a channel target in a workspace this gateway does not serve", async () => {
    documents["users/uid-alice"] = { username: "alice", provisioning: { openclaw: { gatewayId: "gw-other", slug: "alice" } } };
    const response = await request(app())
      .post("/internal/openclaw/activity/channel-target")
      .send({ primaryChannelId: "primary" });

    expect(response.status).toBe(403);
  });

  it("refuses a Mattermost channel id bound to two channel records", async () => {
    documents["workspaces/alice/projects/web/channels/general"] = { kind: "general", mattermost: { channelId: "primary" } };
    const response = await request(app())
      .post("/internal/openclaw/activity/channel-target")
      .send({ primaryChannelId: "primary" });

    expect(response.status).toBe(403);
  });
});
