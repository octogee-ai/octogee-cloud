import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { NO_BROKER_RECORDS, type BrokerRecords } from "../lib/broker-records.js";
import { RecordingDocuments } from "../test-helpers/recording-documents.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const provisionSteps = vi.hoisted(() => ({
  noProvisioningProjection: { name: "none" },
  buildProvisioningContext: vi.fn((uid: string) => ({ uid, slug: "alice" })),
  markProvisioningComplete: vi.fn(async () => undefined),
  provisionMattermost: vi.fn(async () => ({ "mattermost.userId": "mm-alice" })),
}));
vi.mock("@octogee/core/provisionSteps", () => provisionSteps);
const channelHost = vi.hoisted(() => ({ host: { name: "mattermost" } }));
vi.mock("@octogee/core/channel-host", () => ({ mattermostChannelHostFromEnv: () => channelHost.host }));

const GATEWAY_ID = "shared-blue";
const MM_UPDATE = { "mattermost.userId": "mm-alice" };

function server(provisioningProjection?: object) {
  const documents = new RecordingDocuments({
    "users/uid-alice": { username: "alice", provisioning: { openclaw: { gatewayId: GATEWAY_ID, slug: "alice" } } },
  });
  const records: BrokerRecords = {
    ...NO_BROKER_RECORDS,
    userDocuments: { ...NO_BROKER_RECORDS.userDocuments, account: async () => ({ username: "alice" }) },
  };
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: GATEWAY_ID, tokenSource: "ksa" } as never;
    next();
  }) as RequestHandler);
  app.use("/internal/fleet", createFleetBrokerRoutes({
    store: createDocumentFixtureStore(documents),
    records,
    renderAvatar: async () => Buffer.alloc(0),
    ...(provisioningProjection ? { provisioningProjection: provisioningProjection as never } : {}),
  }));
  return app;
}

async function completeProvisioning(app: express.Express) {
  await request(app)
    .post("/internal/fleet/set-mattermost-fields")
    .send({ gatewayId: GATEWAY_ID, uid: "uid-alice", mmUpdate: MM_UPDATE })
    .expect(204);
}

describe("POST /internal/fleet/set-mattermost-fields provisioning projection", () => {
  it("records provisioning in platform state alone when no product projection is installed", async () => {
    provisionSteps.markProvisioningComplete.mockClear();

    await completeProvisioning(server());

    expect(provisionSteps.markProvisioningComplete).toHaveBeenCalledWith(
      { uid: "uid-alice", slug: "alice" },
      MM_UPDATE,
      ["octogee-alice-coach"],
      provisionSteps.noProvisioningProjection,
    );
  });

  it("hands the installed product projection to the provisioning steps", async () => {
    provisionSteps.markProvisioningComplete.mockClear();
    const projection = { name: "product" };

    await completeProvisioning(server(projection));

    expect(provisionSteps.markProvisioningComplete).toHaveBeenCalledWith(
      { uid: "uid-alice", slug: "alice" },
      MM_UPDATE,
      ["octogee-alice-coach"],
      projection,
    );
  });
});

describe("POST /internal/fleet/provision-mattermost provisioning projection", () => {
  async function provision(app: express.Express) {
    const response = await request(app)
      .post("/internal/fleet/provision-mattermost")
      .send({ gatewayId: GATEWAY_ID, uid: "uid-alice" })
      .expect(200);
    expect(response.body).toEqual({ mmUpdate: MM_UPDATE });
  }

  it("reads no product names when no product projection is installed", async () => {
    provisionSteps.provisionMattermost.mockClear();

    await provision(server());

    expect(provisionSteps.provisionMattermost).toHaveBeenCalledWith(
      { uid: "uid-alice", slug: "alice" },
      channelHost.host,
      provisionSteps.noProvisioningProjection,
    );
  });

  it("hands the installed product projection to Mattermost provisioning", async () => {
    provisionSteps.provisionMattermost.mockClear();
    const projection = { name: "product" };

    await provision(server(projection));

    expect(provisionSteps.provisionMattermost).toHaveBeenCalledWith(
      { uid: "uid-alice", slug: "alice" },
      channelHost.host,
      projection,
    );
  });
});
