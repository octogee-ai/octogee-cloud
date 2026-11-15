import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";

vi.mock("@octogee/core/http/auth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.uid = req.get("authorization");
    next();
  },
}));

import { createIsolatedGatewayRoutes } from "./gateways.js";

it("limits workspace Gateway status requests independently for each verified user", async () => {
  const app = express();
  app.use(createIsolatedGatewayRoutes());
  const path = "/workspaces/gateway-status";
  for (let index = 0; index < 120; index++) {
    await request(app).get(path).set("authorization", "alice").expect(200, { workspaces: [] });
  }
  const limited = await request(app).get(path).set("authorization", "alice");
  expect(limited.status).toBe(429);
  const other = await request(app).get(path).set("authorization", "bob");
  expect(other.status).toBe(200);
  expect(other.body).toEqual({ workspaces: [] });
});
