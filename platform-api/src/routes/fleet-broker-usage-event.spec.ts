import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { NO_BROKER_RECORDS, type BrokerRecords, type UsageEvent } from "../lib/broker-records.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const GATEWAY_ID = "shared-blue";
const AGENT_ID = "octogee-alice-coach";
const USAGE = {
  input: 10,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 30,
  costUsd: 0.01,
  model: "claude-sonnet",
  costBreakdown: { input: 0.004, output: 0.006, cacheRead: 0, cacheWrite: 0 },
};

function server(records?: BrokerRecords) {
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: GATEWAY_ID, tokenSource: "ksa" } as never;
    next();
  }) as RequestHandler);
  app.use("/internal/fleet", createFleetBrokerRoutes({
    store: createDocumentFixtureStore({
      "users/uid-alice": {
        username: "alice",
        provisioning: { openclaw: { gatewayId: GATEWAY_ID, slug: "alice", agentIds: [AGENT_ID] } },
      },
    }),
    ...(records ? { records } : {}),
  }));
  return app;
}

function reportUsage(app: express.Express, agentId = AGENT_ID) {
  return request(app).post("/internal/fleet/usage-event").send({ gatewayId: GATEWAY_ID, agentId, usage: USAGE });
}

describe("POST /internal/fleet/usage-event", () => {
  it("hands the assigned agent's usage to the product recorder", async () => {
    const events: UsageEvent[] = [];
    const app = server({ ...NO_BROKER_RECORDS, recordUsageEvent: async (event) => { events.push(event); } });

    await reportUsage(app).expect(204);

    expect(events).toEqual([{ uid: "uid-alice", agentId: AGENT_ID, usage: USAGE, gatewayId: GATEWAY_ID, workspaceSlug: "alice" }]);
  });

  it("refuses usage for an agent the gateway does not serve", async () => {
    const events: UsageEvent[] = [];
    const app = server({ ...NO_BROKER_RECORDS, recordUsageEvent: async (event) => { events.push(event); } });

    await reportUsage(app, "octogee-bob-coach").expect(403);

    expect(events).toEqual([]);
  });

  it("answers 502 when no product records usage events", async () => {
    const response = await reportUsage(server()).expect(502);

    expect(response.body).toEqual({ error: "usage events need a product recorder" });
  });
});
