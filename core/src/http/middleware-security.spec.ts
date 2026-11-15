import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  dashboardAssetRateLimit,
  helmetMiddleware,
  isWellFormedServiceAccountJwt,
} from "./security.js";

const WELL_FORMED_SA_TOKEN = [
  "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5LWlkIn0",
  "eyJhdWQiOlsib2N0b2dlZS1hcGkiXSwiZXhwIjoxNzUyODAwMDAwLCJpc3MiOiJrOHMifQ",
  "c2lnbmF0dXJlLXNlZ21lbnQtZm9yLXRlc3RpbmctcHVycG9zZXMtb25seQ",
].join(".");

function limiterApp() {
  const app = express();
  app.use(dashboardAssetRateLimit);
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/internal/gitea/user-pubkey", (_req, res) => res.json({ ok: true }));
  app.get("/api/probe", (_req, res) => res.json({ ok: true }));
  app.get("/api/g/walter/openclaw/assets/app.js", (_req, res) => res.send("asset"));
  return app;
}

describe("security middleware", () => {
  it("sets the locked-down content security policy", async () => {
    const app = express();
    app.use(helmetMiddleware);
    app.get("/probe", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/probe").expect(200);

    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("only applies the asset budget to dashboard assets", async () => {
    const app = limiterApp();
    for (const path of ["/health", "/internal/gitea/user-pubkey", "/api/probe"]) {
      const response = await request(app).get(path).expect(200);
      expect(response.headers.ratelimit).toBeUndefined();
    }
    await request(app).get("/api/g/walter/openclaw/assets/app.js").expect(200);
  });
});

describe("isWellFormedServiceAccountJwt", () => {
  it("accepts a three-segment base64url token of plausible length", () => {
    expect(isWellFormedServiceAccountJwt(WELL_FORMED_SA_TOKEN)).toBe(true);
  });

  it.each([
    ["junk", "junk"],
    ["two segments", "aGVhZGVy.cGF5bG9hZA"],
    ["four segments", "aGVhZGVy.cGF5bG9hZA.c2ln.ZXh0cmE"],
    ["empty segment", "aGVhZGVy..c2lnbmF0dXJlLXNlZ21lbnQtb2YtcGxhdXNpYmxlLWxlbmd0aA"],
    ["non-base64url characters", `${"a".repeat(20)}!.${"b".repeat(20)}.${"c".repeat(20)}`],
    ["empty string", ""],
  ])("rejects %s", (_label, token) => {
    expect(isWellFormedServiceAccountJwt(token)).toBe(false);
  });

  it("rejects tokens beyond the 8 KiB review bound", () => {
    const oversized = `${"a".repeat(4000)}.${"b".repeat(4000)}.${"c".repeat(300)}`;
    expect(isWellFormedServiceAccountJwt(oversized)).toBe(false);
  });
});
