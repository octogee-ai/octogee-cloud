import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

const { corsMiddleware } = await import("../middleware/cors.js");

function corsApp() {
  const app = express();
  app.use(corsMiddleware);
  app.get("/probe", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("corsMiddleware", () => {
  const ORIGINAL_LOCAL = process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS;
  afterEach(() => {
    if (ORIGINAL_LOCAL === undefined) delete process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS;
    else process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS = ORIGINAL_LOCAL;
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
