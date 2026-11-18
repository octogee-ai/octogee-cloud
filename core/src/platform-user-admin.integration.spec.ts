import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAdminUserDirectoryRoutes, noAdminUserDirectorySource } from "./admin-user-directory-router.js";
import { addAdminUserRoutes } from "./admin-user-router.js";
import { operatorRailRegistry } from "./model-broker/rails.js";
import { InMemoryModelBrokerUsageStore } from "./model-broker/usage.js";
import { createHarness, dsn, type PlatformStateHarness } from "./platform-state/postgres/__tests__/fixtures/harness.js";
import { platformStateUserAccountReader, platformStateUserAccounts } from "./platform-state-user-accounts.js";

function adminApp(harness: PlatformStateHarness) {
  const router = express.Router();
  addAdminUserRoutes(router, {
    store: harness.store,
    accounts: platformStateUserAccounts(harness.store),
    journal: async ({ action }) => action({ auditId: "audit-1" } as never),
  });
  addAdminUserDirectoryRoutes(router, {
    store: harness.store,
    accounts: platformStateUserAccountReader(harness.store),
    source: noAdminUserDirectorySource,
    spend: { rails: operatorRailRegistry(), usage: new InMemoryModelBrokerUsageStore() },
    logger: { info: () => undefined, warn: () => undefined },
  });
  const app = express();
  app.use(express.json());
  app.use("/api/admin", router);
  return app;
}

describe.skipIf(!dsn)("platform user administration on PostgreSQL", () => {
  let harness: PlatformStateHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("adds a user who is admitted, reserved a workspace, listed and shown in the directory", async () => {
    const app = adminApp(harness);

    const added = await request(app).post("/api/admin/users").send({ name: "ada", email: "Ada@Example.test" }).expect(201);
    const { userId } = added.body as { userId: string };

    expect(await harness.store.users.records.get(userId)).toMatchObject({ slug: "ada", admitted: true });
    expect(await harness.store.workspaces.records.get("ada")).toMatchObject({ ownerUid: userId });
    const listed = await request(app).get("/api/admin/users").expect(200);
    expect(listed.body.items).toEqual([
      expect.objectContaining({ uid: userId, username: "ada", email: "ada@example.test" }),
    ]);
    const detail = await request(app).get(`/api/admin/users/${userId}`).expect(200);
    expect(detail.body).toMatchObject({
      summary: { uid: userId, username: "ada", email: "ada@example.test" },
      provisioning: { slug: "ada", status: "in_progress" },
    });
  });

  it("refuses a second user with a taken email and keeps the name free", async () => {
    const app = adminApp(harness);
    await request(app).post("/api/admin/users").send({ name: "ada", email: "ada@example.test" }).expect(201);

    await request(app).post("/api/admin/users").send({ name: "bob", email: "ada@example.test" }).expect(409);

    expect(await harness.store.workspaces.records.get("bob")).toBeNull();
    await request(app).post("/api/admin/users").send({ name: "bob", email: "bob@example.test" }).expect(201);
  });
});
