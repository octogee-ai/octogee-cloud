import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_PATH = "workspaces/alice/projects/site";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  updates: [] as { path: string; data: Record<string, unknown> }[],
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@octogee/core/identity/platform-state-store", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});

vi.mock("@octogee/core/http/security", () => ({
  strictRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("@octogee/core/http/logging", () => ({ logger: h.logger }));

const { default: settingsRoutes } = await import("../routes/projects/settings.js");

function app(uid: string) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.uid = uid;
    next();
  });
  instance.use("/api/projects", settingsRoutes);
  return instance;
}

function patch(body: unknown, uid = "uid-owner") {
  return request(app(uid)).patch("/api/projects/alice/site/settings").send(body as object);
}

beforeEach(() => {
  h.docs.clear();
  h.updates.length = 0;
  h.docs.set(PROJECT_PATH, {
    id: "site",
    workspaceId: "alice",
    slug: "site",
    ownerUid: "uid-owner",
    provisioningState: "active",
    giteaRepoName: "alice-site",
    visibility: "public",
    status: "building",
    checkoutEnabled: true,
    commercialLifecycle: { status: "archived" },
  });
});

describe("PATCH /api/projects/:wid/:pid/settings", () => {
  it("changes visibility, status and checkout through the platform store and not the Firestore document", async () => {
    await patch({ visibility: "private", status: "paused", checkoutEnabled: false }).expect(200);

    expect(h.docs.get(PROJECT_PATH)).toMatchObject({ visibility: "private", status: "paused", checkoutEnabled: false });
    expect(h.updates).toEqual([]);
  });

  it("changes only the settings the request names", async () => {
    await patch({ checkoutEnabled: false }).expect(200);

    expect(h.docs.get(PROJECT_PATH)).toMatchObject({ visibility: "public", status: "building", checkoutEnabled: false });
  });

  it("lets the owner of an archived project make it private", async () => {
    await patch({ visibility: "private" }).expect(200);

    expect(h.docs.get(PROJECT_PATH)).toMatchObject({ visibility: "private" });
  });

  it("403s anyone but the owner", async () => {
    await patch({ visibility: "private" }, "uid-member").expect(403);

    expect(h.docs.get(PROJECT_PATH)).toMatchObject({ visibility: "public" });
  });

  it.each([
    [{ visibility: "secret" }],
    [{ status: "archived" }],
    [{ checkoutEnabled: "no" }],
    [{}],
  ])("400s %j without changing the project", async (body) => {
    await patch(body).expect(400);

    expect(h.docs.get(PROJECT_PATH)).toMatchObject({ visibility: "public", status: "building", checkoutEnabled: true });
  });

  it("404s an unknown project", async () => {
    h.docs.delete(PROJECT_PATH);

    const response = await patch({ visibility: "private" });

    expect(response.status).toBe(404);
  });
});
