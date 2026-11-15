import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { dashboardAssetRateLimit, strictRateLimit } from "./security.js";

function app() {
  const target = express();
  target.set("trust proxy", 1);
  target.use(dashboardAssetRateLimit);
  target.use((_req, res) => res.sendStatus(204));
  return target;
}

describe("request rate-limit ownership", () => {
  it("admits the measured 306-request browser burst without another application IP quota", async () => {
    const target = app();
    for (let index = 0; index < 306; index++) {
      const response = await request(target).get(`/api/v4/channels/${"a".repeat(26)}/posts`)
        .set("X-Forwarded-For", "198.51.100.11");
      expect(response.status).toBe(204);
    }
  });

  it("does not pool private user calls into a source-IP allowance", async () => {
    const target = app();
    const serviceToken = `${"a".repeat(50)}.${"b".repeat(50)}.${"c".repeat(50)}`;
    for (let index = 0; index < 1201; index++) {
      const response = await request(target).get("/internal/fleet/assigned-users")
        .set("X-Forwarded-For", "198.51.100.12").set("x-k8s-sa-token", serviceToken);
      expect(response.status).toBe(204);
    }
  });

  it("shares mutation credit across one authenticated user but not across users behind one IP", async () => {
    const target = express();
    target.set("trust proxy", 1);
    target.use((req, _res, next) => {
      const identities: Record<string, string> = { "Bearer token-a": "verified-a", "Bearer token-b": "verified-b" };
      req.uid = identities[req.headers.authorization ?? ""];
      next();
    });
    target.use(strictRateLimit);
    target.use((_req, res) => res.sendStatus(204));
    for (let index = 0; index < 30; index++) {
      await request(target).post("/api/channels").set("X-Forwarded-For", "198.51.100.13").set("Authorization", "Bearer token-a").expect(204);
    }
    await request(target).post("/api/projects").set("X-Forwarded-For", "198.51.100.14").set("Authorization", "Bearer token-a").expect(429);
    const otherUser = await request(target).post("/api/channels")
      .set("X-Forwarded-For", "198.51.100.13").set("Authorization", "Bearer token-b");
    expect(otherUser.status).toBe(204);
  });

  it("keeps unverified callers in the same IP budget despite changing bearer text", async () => {
    const target = express();
    target.set("trust proxy", 1);
    target.use(strictRateLimit);
    target.use((_req, res) => res.sendStatus(204));
    for (let index = 0; index < 30; index++) {
      await request(target).post("/api/channels").set("X-Forwarded-For", "198.51.100.15").set("Authorization", `Bearer unverified-${index}`).expect(204);
    }
    const response = await request(target).post("/api/channels")
      .set("X-Forwarded-For", "198.51.100.15").set("X-User-Id", "another-user");
    expect(response.status).toBe(429);
  });
});
