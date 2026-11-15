import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  saveModelCredentialKey: vi.fn(),
  deleteModelCredentialKey: vi.fn(),
}));

vi.mock("@octogee/core/http/auth", () => ({
  requireActiveAccount: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuthenticatedUid: (req: express.Request, res: express.Response, next: express.NextFunction) =>
    h.requireAuth(req, res, next),
}));

vi.mock("../routes/billing/byot.js", () => ({
  saveModelCredentialKey: (req: express.Request, res: express.Response) => h.saveModelCredentialKey(req, res),
  deleteModelCredentialKey: (req: express.Request, res: express.Response) => h.deleteModelCredentialKey(req, res),
}));

vi.mock("../routes/byosub.js", () => {
  const router = express.Router();
  router.get("/probe", (_req, res) => res.json({ route: "subscription" }));
  return { default: router };
});

const { default: modelCredentialRoutes } = await import("../routes/model-credentials.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/model-credentials", modelCredentialRoutes);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAuth.mockImplementation((req, _res, next) => { req.uid = "credential-owner"; next(); });
  h.saveModelCredentialKey.mockImplementation((_req, res) => res.status(201).json({ route: "save" }));
  h.deleteModelCredentialKey.mockImplementation((_req, res) => res.json({ route: "delete" }));
});

describe("model credential route index", () => {
  it("protects key save and delete routes with requireAuth", async () => {
    await request(app()).post("/api/model-credentials").send({ provider: "anthropic" }).expect(201, { route: "save" });
    await request(app()).delete("/api/model-credentials").send({ provider: "anthropic" }).expect(200, { route: "delete" });

    expect(h.requireAuth).toHaveBeenCalledTimes(2);
    expect(h.saveModelCredentialKey).toHaveBeenCalledTimes(1);
    expect(h.deleteModelCredentialKey).toHaveBeenCalledTimes(1);
  });

  it("mounts subscription routes below the model credential surface", async () => {
    await request(app()).get("/api/model-credentials/subscription/probe").expect(200, { route: "subscription" });

    expect(h.requireAuth).not.toHaveBeenCalled();
  });

  it("limits credential writes per account without blocking key deletion", async () => {
    h.requireAuth.mockImplementation((req, _res, next) => {
      req.uid = req.get("authorization") === "Bearer owner-a" ? "owner-a" : "owner-b";
      next();
    });
    const client = request(app());
    const save = (uid: string) => client.post("/api/model-credentials")
      .set("authorization", `Bearer ${uid}`).send({ provider: "anthropic" });
    for (let attempt = 0; attempt < 30; attempt++) await save("owner-a").expect(201);
    const rejected = await save("owner-a").expect(429);
    expect(rejected.body).toEqual({ error: "Too many requests, please try again later." });
    await save("owner-b").expect(201);
    await client.delete("/api/model-credentials").set("authorization", "Bearer owner-a").send({ provider: "anthropic" }).expect(200);
  });
});
