import express, { type RequestHandler } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { logger } from "../../../gateway-edge/src/middleware/logging.js";
import { RecordingDocuments } from "../test-helpers/recording-documents.js";
import { createFleetBrokerRoutes, type ProvisionedUserReport } from "./fleet-broker.js";

const GATEWAY_ID = "shared-blue";

function fixture(onUserProvisioned?: (report: ProvisionedUserReport) => Promise<void>) {
  const documents = new RecordingDocuments({
    "users/uid-alice": {
      username: "alice",
      mattermost: { userId: "mm-alice" },
      provisioning: { openclaw: { gatewayId: GATEWAY_ID, slug: "alice" } },
    },
    "users/uid-bob": { username: "bob", provisioning: { openclaw: { gatewayId: "shared-green", slug: "bob" } } },
  });
  const server = express();
  server.disable("x-powered-by");
  server.use(express.json());
  server.use(((req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: GATEWAY_ID, tokenSource: "ksa" } as never;
    next();
  }) as RequestHandler);
  server.use("/internal/fleet", createFleetBrokerRoutes({
    store: createDocumentFixtureStore(documents),
    ...(onUserProvisioned ? { onUserProvisioned } : {}),
  }));
  return { server, writes: documents.writes };
}

function report(server: express.Express, body: Record<string, unknown>) {
  return request(server).post("/internal/fleet/provisioned").send({ gatewayId: GATEWAY_ID, ...body });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("POST /internal/fleet/provisioned", () => {
  it("hands the assigned user's report to the installed hook and answers 204", async () => {
    const reports: ProvisionedUserReport[] = [];
    const { server } = fixture(async (received) => { reports.push(received); });

    await report(server, { uid: "uid-alice", first: true }).expect(204);
    await report(server, { uid: "uid-alice", first: false }).expect(204);

    expect(reports).toEqual([
      { uid: "uid-alice", slug: "alice", mattermostUserId: "mm-alice", first: true },
      { uid: "uid-alice", slug: "alice", mattermostUserId: "mm-alice", first: false },
    ]);
  });

  it("accepts the report and does nothing else when no hook is installed", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const { server, writes } = fixture();

    await report(server, { uid: "uid-alice", first: true }).expect(204);

    expect(outbound).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("answers 502 with the hook's error so the gateway logs the cause", async () => {
    const { server } = fixture(async () => { throw new Error("ops alert was not delivered"); });

    const response = await report(server, { uid: "uid-alice", first: true }).expect(502);

    expect(response.body).toEqual({ error: "ops alert was not delivered" });
  });

  it("logs the failed call's path and error when it answers 502", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const failure = new Error("ops alert was not delivered");
    const { server } = fixture(async () => { throw failure; });

    await report(server, { uid: "uid-alice", first: true }).expect(502);

    expect(logged).toHaveBeenCalledWith("fleet broker call failed", {
      path: "/internal/fleet/provisioned",
      err: failure,
    });
  });

  it.each([undefined, "true", 1, null])("refuses a report whose first flag is %s before the hook runs", async (first) => {
    const hook = vi.fn(async () => {});
    const { server } = fixture(hook);

    const response = await report(server, { uid: "uid-alice", first }).expect(400);

    expect(response.body).toEqual({ error: "invalid_first" });
    expect(hook).not.toHaveBeenCalled();
  });

  it("refuses a report about a user assigned to another gateway", async () => {
    const hook = vi.fn(async () => {});
    const { server } = fixture(hook);

    await report(server, { uid: "uid-bob", first: true }).expect(403);
    await report(server, { first: true }).expect(400);

    expect(hook).not.toHaveBeenCalled();
  });
});

describe("the fleet broker with no product installed", () => {
  it.each(["/internal/fleet/notify-signup", "/internal/fleet/ensure-community-membership"])(
    "has no %s route",
    async (path) => {
      const { server } = fixture();

      await request(server).post(path).send({ gatewayId: GATEWAY_ID, uid: "uid-alice" }).expect(404);
    },
  );
});
