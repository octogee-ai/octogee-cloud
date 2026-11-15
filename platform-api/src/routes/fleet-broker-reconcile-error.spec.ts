import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { RecordingDocuments } from "../test-helpers/recording-documents.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const GATEWAY_ID = "shared-blue";

function gatewayRoot(): Record<string, unknown> {
  return {
    gatewayId: GATEWAY_ID, createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test", latestRelease: 1,
    desiredRelease: 1, liveRelease: 1, desiredStatus: "running", configSchemaVersion: 1, profile: null, gatewayClass: "shared",
    imageProfile: "standard", sizingTier: null, gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null,
    serviceAccount: null, builderAccess: null, ownerUid: null, builderSlug: null, modelBrokerLimits: null, preemption: null,
  };
}

function fixture(start = 1_000_000, seed: Record<string, Record<string, unknown>> = { [`gateways/${GATEWAY_ID}`]: gatewayRoot() }) {
  let now = start;
  const documents = new RecordingDocuments({
    "users/uid-alice": { provisioning: { openclaw: { gatewayId: GATEWAY_ID, slug: "alice" } } },
    ...seed,
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
    now: () => now,
  }));
  return {
    server,
    documents,
    writes: documents.writes,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function report(server: express.Express, message: string) {
  return request(server)
    .post("/internal/fleet/reconcile-error")
    .send({ gatewayId: GATEWAY_ID, slug: "alice", message });
}

describe("reconcile-error reporting", () => {
  it("writes the first report and drops an identical repeat inside the window", async () => {
    const { server, writes } = fixture();

    await expect(report(server, "mount failed").expect(204)).resolves.toBeDefined();
    await expect(report(server, "mount failed").expect(204)).resolves.toBeDefined();

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(`gateways/${GATEWAY_ID}`);
    expect(writes[0]?.data?.lastError).toMatchObject({ slug: "alice", message: "mount failed" });
  });

  it("writes again once the window elapses", async () => {
    const { server, writes, advance } = fixture();

    await report(server, "mount failed").expect(204);
    advance(59_999);
    await report(server, "mount failed").expect(204);
    expect(writes).toHaveLength(1);

    advance(1);
    await report(server, "mount failed").expect(204);
    expect(writes).toHaveLength(2);
  });

  it("writes a different message immediately", async () => {
    const { server, writes } = fixture();

    await report(server, "mount failed").expect(204);
    await report(server, "unmount failed").expect(204);

    expect(writes.map((write) => (write.data?.lastError as { message: string }).message)).toEqual([
      "mount failed",
      "unmount failed",
    ]);
  });

  it("lets the next report through after the error is cleared", async () => {
    const { server, writes } = fixture();

    await report(server, "mount failed").expect(204);
    await request(server)
      .post("/internal/fleet/clear-reconcile-error")
      .send({ gatewayId: GATEWAY_ID, slug: "alice" })
      .expect(204);
    await report(server, "mount failed").expect(204);

    expect(writes).toHaveLength(3);
    expect(writes[1]?.data?.lastError).toBeNull();
  });

  it("leaves a different slug's error in place on clear", async () => {
    const { server, documents } = fixture();

    await report(server, "mount failed").expect(204);
    documents.set(`gateways/${GATEWAY_ID}`, { ...documents.get(`gateways/${GATEWAY_ID}`), lastError: { slug: "bob", message: "other", at: 1 } });
    await request(server)
      .post("/internal/fleet/clear-reconcile-error")
      .send({ gatewayId: GATEWAY_ID, slug: "alice" })
      .expect(204);

    expect(documents.get(`gateways/${GATEWAY_ID}`)?.lastError).toEqual({ slug: "bob", message: "other", at: 1 });
  });

  it("refuses to create a gateway record for a report on a gateway without one", async () => {
    const { server, documents } = fixture(1_000_000, {});

    await report(server, "mount failed").expect(502);

    expect(documents.get(`gateways/${GATEWAY_ID}`)).toBeUndefined();
  });
});
