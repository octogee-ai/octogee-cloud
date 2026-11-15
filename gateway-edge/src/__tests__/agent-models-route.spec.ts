import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
import { SIMPLE_MODEL_TIERS } from "@octogee/shared/types/agent-models";
import type { PlatformStateStore } from "@octogee/core/platform-state";

const h = vi.hoisted(() => ({
  triggerSync: vi.fn(),
  store: null as unknown as PlatformStateStore,
}));

vi.mock("@octogee/core/http/auth", () => ({
  requireAuthenticatedUid: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { uid: "alice-uid", user: { username: "alice", provisioning: { openclaw: { gatewayId: "alice" } } } });
    next();
  },
  requireActiveAccount: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("@octogee/core/identity/platform-state-store", () => ({
  get platformStateStore() { return h.store; },
}));
vi.mock("../lib/byot-sync-trigger.js", () => ({ triggerGatewayModelCredentialSync: h.triggerSync }));
vi.mock("@octogee/shared/types/user-entitlements", () => ({
  userEntitlements: () => ({ policy: () => ({ modelAccess: "catalog" }), previousImageFields: () => ({}), pickInputs: () => ({}) }),
}));

const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
const { default: routes } = await import("../routes/agent-models.js");
const app = express();
app.use(express.json());
app.use(routes);

const coach = "octogee-alice-coach";
const projectCoach = "octogee-alice-proj-demo-coach";
const coachModel = { primary: SIMPLE_MODEL_TIERS.everyday.ref, fallbacks: [] };
const projectModel = { primary: SIMPLE_MODEL_TIERS.hard.ref, fallbacks: [] };

async function selections() {
  return (await h.store.users.agentModels.list("alice-uid")).map(({ agentId, primary, fallbacks }) => ({ agentId, primary, fallbacks }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.store = createDocumentFixtureStore(new Map());
  await h.store.users.modelCredentials.put({
    uid: "alice-uid", active: true, provider: "anthropic", mode: "api_key", status: "active", reasonCode: "ok",
    secretName: "byok-alice-anthropic", fingerprint: null, keyHash: null, baseUrl: null, model: null,
    addedAt: 1, lastUsedAt: null,
  });
  await h.store.users.agentModels.put({ uid: "alice-uid", agentId: coach, ...coachModel, updatedAt: 1 });
  await h.store.users.agentModels.put({ uid: "alice-uid", agentId: projectCoach, ...projectModel, updatedAt: 1 });
});

it.each(["put", "delete"] as const)("rejects a model %s for another account before writing or syncing", async method => {
  await request(app)[method]("/octogee-bob-coach").send(coachModel).expect(403);
  expect(await selections()).toEqual([
    { agentId: coach, ...coachModel },
    { agentId: projectCoach, ...projectModel },
  ]);
  expect(h.triggerSync).not.toHaveBeenCalled();
});

it("updates one coach selection and syncs the project coach's existing selection too", async () => {
  const selection = { primary: SIMPLE_MODEL_TIERS.errands.ref, fallbacks: [] };
  await request(app).put(`/${coach}`).send(selection).expect(200);
  expect(await selections()).toEqual([
    { agentId: coach, ...selection },
    { agentId: projectCoach, ...projectModel },
  ]);
  expect(h.triggerSync.mock.calls[0]?.[0].userData.systemConfig).toEqual({
    byot: { provider: "anthropic" },
    agentModels: { [coach]: selection, [projectCoach]: projectModel },
  });
});

it("deletes exactly one agent selection and syncs the other selections", async () => {
  await request(app).delete(`/${coach}`).expect(200);
  expect(await selections()).toEqual([{ agentId: projectCoach, ...projectModel }]);
  expect(h.triggerSync.mock.calls[0]?.[0].userData.systemConfig.agentModels).toEqual({ [projectCoach]: projectModel });
});

it("lists the store's selections", async () => {
  const res = await request(app).get("/").expect(200);

  expect(res.body.selections).toEqual({ [coach]: coachModel, [projectCoach]: projectModel });
});
