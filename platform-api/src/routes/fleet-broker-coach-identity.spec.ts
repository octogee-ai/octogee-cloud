import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { NO_BROKER_RECORDS, type BrokerRecords } from "../lib/broker-records.js";
import type { AgentIdentityPatch } from "../lib/agent-identity.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const GATEWAY_ID = "shared-blue";
const AGENT_ID = "octogee-alice-coach";

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
    verifyOwnerWorkspaceTurn: async () => true,
    ...(records ? { records } : {}),
  }));
  return app;
}

function setCoachIdentity(app: express.Express) {
  return request(app)
    .post("/internal/fleet/agent/set-coach-identity")
    .send({ workspaceSlug: "alice", agentId: AGENT_ID, name: "Juniper", vibe: "Warm and direct" });
}

describe("POST /internal/fleet/agent/set-coach-identity", () => {
  it("hands the coach's new name and vibe to the product's agent identity", async () => {
    const synced: Array<{ uid: string; patch: AgentIdentityPatch; context: { slug?: string } | undefined }> = [];
    const app = server({
      ...NO_BROKER_RECORDS,
      agentIdentity: {
        ...NO_BROKER_RECORDS.agentIdentity,
        sync: async (uid, patch, context) => {
          synced.push({ uid, patch, context });
          return ["name", "persona"];
        },
      },
    });

    const response = await setCoachIdentity(app).expect(200);

    expect(response.body).toEqual({ updated: ["name", "persona"] });
    expect(synced).toEqual([{
      uid: "uid-alice",
      patch: { name: "Juniper", persona: "Warm and direct", avatarPng: undefined },
      context: { slug: "alice" },
    }]);
  });

  it("answers 502 when no product holds agent identity", async () => {
    const response = await setCoachIdentity(server()).expect(502);

    expect(response.body).toEqual({ error: "agent identity needs a product store" });
  });
});
