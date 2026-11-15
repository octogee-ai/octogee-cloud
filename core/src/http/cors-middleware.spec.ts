import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createCorsMiddleware } = await import("./cors.js");

function corsApp() {
  const app = express();
  app.use(createCorsMiddleware());
  app.get("/probe", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("corsMiddleware", () => {
  const ORIGINAL_LOCAL = process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS;
  afterEach(() => {
    if (ORIGINAL_LOCAL === undefined) delete process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS;
    else process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS = ORIGINAL_LOCAL;
  });

  it("reads the allowed origins when an app builds it, and refuses to build without them", () => {
    vi.stubEnv("PUBLIC_APP_ORIGINS", "");
    try {
      expect(() => createCorsMiddleware()).toThrow(/PUBLIC_APP_ORIGINS/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("allows Octogee app origins regardless of the local-origins flag", async () => {
    delete process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS;
    const prod = await request(corsApp())
      .get("/probe")
      .set("Origin", "https://app.octogee.com")
      .expect("Access-Control-Allow-Origin", "https://app.octogee.com")
      .expect("Access-Control-Allow-Credentials", "true")
      .expect(200);
    expect(prod.body).toEqual({ ok: true });
  });

  it("admits localhost only when OCTOGEE_ALLOW_LOCAL_ORIGINS=true", async () => {
    process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS = "true";
    const local = await request(corsApp())
      .get("/probe")
      .set("Origin", "http://localhost:4322")
      .expect("Access-Control-Allow-Origin", "http://localhost:4322")
      .expect(200);
    expect(local.body).toEqual({ ok: true });
  });

  it("denies localhost in production builds (flag unset)", async () => {
    delete process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS;
    const res = await request(corsApp())
      .get("/probe")
      .set("Origin", "http://localhost:4322")
      .expect(200);

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not emit CORS allow headers for unknown origins", async () => {
    const res = await request(corsApp())
      .get("/probe")
      .set("Origin", "https://evil.test")
      .expect(200);

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
