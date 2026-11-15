import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { BoundTenant } from "../lib/sa-to-tenant.js";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { RecordingDocuments } from "../test-helpers/recording-documents.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

class VanishingDocuments extends RecordingDocuments {
  constructor(seed: Record<string, Record<string, unknown>>, private readonly vanishAfterRead: ReadonlySet<string>) {
    super(seed);
  }

  override get(path: string): Record<string, unknown> | undefined {
    const row = super.get(path);
    if (row !== undefined && this.vanishAfterRead?.has(path)) Map.prototype.delete.call(this, path);
    return row;
  }
}

function runtime(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { docKind: "runtime", gatewayId: "b-x", release: 1, lifecycle: "running", ...fields };
}

function appWith(docs: Record<string, Record<string, unknown>>, bound: BoundTenant | null, deletedAfterRead = new Set<string>()) {
  const documents = new VanishingDocuments(docs, deletedAfterRead);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (bound) req.boundTenant = bound;
    next();
  });
  app.use("/internal/fleet", createFleetBrokerRoutes({ store: createDocumentFixtureStore(documents), now: () => 5_000 }));
  return { app, documents };
}
const gateway: BoundTenant = { kind: "gateway", gatewayId: "b-x" };
const post = (app: express.Express, body: Record<string, unknown>) => request(app).post("/internal/fleet/computer-egress").send(body);

describe("POST /internal/fleet/computer-egress", () => {
  it("reads the bound gateway's stored egress mode, null when none was ever chosen", async () => {
    const empty = await post(appWith({ "glmGateways/b-x": runtime() }, gateway).app, {});
    expect(empty.status).toBe(200);
    expect(empty.headers["cache-control"]).toBe("no-store");
    expect(empty.body).toEqual({ egress: null });

    const chosen = await post(appWith({ "glmGateways/b-x": runtime({ vmEgress: { mode: "desktop", updatedAt: 4_000 } }) }, gateway).app, { gatewayId: "b-x" });
    expect(chosen.body).toEqual({ egress: { mode: "desktop", updatedAt: 4_000 } });
  });

  it("writes a chosen mode beside the controller-owned vm map and echoes it", async () => {
    const h = appWith({ "glmGateways/b-x": runtime({ vm: { status: "RUNNING" } }) }, gateway);
    const res = await post(h.app, { mode: "desktop" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ egress: { mode: "desktop", updatedAt: 5_000 } });
    expect(h.documents.writes).toEqual([{ path: "glmGateways/b-x", data: runtime({ vm: { status: "RUNNING" }, vmEgress: { mode: "desktop", updatedAt: 5_000 } }) }]);
  });

  it("answers 404 without recreating the gateway when it is retired between the read and the mode write", async () => {
    const h = appWith({ "glmGateways/b-x": runtime() }, gateway, new Set(["glmGateways/b-x"]));
    const res = await post(h.app, { mode: "desktop" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "gateway_not_found" });
    expect(h.documents.writes).toEqual([]);
    expect(h.documents.get("glmGateways/b-x")).toBeUndefined();
  });

  it("rejects an unknown mode, refuses to read a malformed stored record while still letting a write repair it, and refuses any binding that is not the gateway itself", async () => {
    const bad = appWith({ "glmGateways/b-x": runtime() }, gateway);
    expect((await post(bad.app, { mode: "tor" })).status).toBe(400);
    expect(bad.documents.writes).toEqual([]);

    const malformed = await post(appWith({ "glmGateways/b-x": runtime({ vmEgress: { mode: "desktop" } }) }, gateway).app, {});
    expect(malformed.status).toBe(409);
    expect(malformed.body).toEqual({ error: "egress_record_malformed" });
    const repaired = appWith({ "glmGateways/b-x": runtime({ vmEgress: { mode: "desktop" } }) }, gateway);
    expect((await post(repaired.app, { mode: "cloud" })).status).toBe(200);
    expect(repaired.documents.get("glmGateways/b-x")?.vmEgress).toEqual({ mode: "cloud", updatedAt: 5_000 });

    expect((await post(appWith({ "glmGateways/b-x": runtime() }, gateway).app, { gatewayId: "b-y", mode: "cloud" })).status).toBe(403);
    expect((await post(appWith({ "glmGateways/b-x": runtime() }, null).app, { mode: "cloud" })).status).toBe(403);
    expect((await post(appWith({}, gateway).app, { mode: "cloud" })).status).toBe(404);
  });

  it("treats a gateway document that is not a runtime record as missing", async () => {
    const h = appWith({ "glmGateways/b-x": { gatewayId: "b-x", vmEgress: { mode: "desktop", updatedAt: 4_000 } } }, gateway);
    expect((await post(h.app, { mode: "cloud" })).status).toBe(404);
    expect(h.documents.writes).toEqual([]);
  });
});
