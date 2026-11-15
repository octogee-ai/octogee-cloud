import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { installBodyParsers } from "./body-parsers.js";

function captureRawBodyApp(): { app: express.Express; received: { value: string } } {
  const app = express();
  installBodyParsers(app);
  const received = { value: "__not-set__" };
  app.all("/api/v4/*splat", (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      received.value = Buffer.concat(chunks).toString("utf-8");
      res.json({});
    });
    req.on("error", () => res.status(500).end());
  });
  app.post("/api/projects/test", (req, res) => {
    res.json({ parsedBody: req.body });
  });
  app.post("/api/connect/obsidian/pair/complete", (req, res) => {
    res.json({ parsedBody: req.body });
  });
  app.post("/api/billing/webhook", (req, res) => {
    const rawBody: unknown = (req as typeof req & { rawBody?: unknown }).rawBody;
    res.json({ rawBodyLength: Buffer.isBuffer(rawBody) ? rawBody.byteLength : -1 });
  });
  return { app, received };
}

describe("installBodyParsers — /api/v4/* must reach handlers with the body stream intact", () => {
  it("POST /api/v4/users/ids with JSON body — handler sees the original bytes (not consumed by express.json)", async () => {
    const { app, received } = captureRawBodyApp();
    const body = JSON.stringify(["id-1", "id-2", "id-3"]);
    await request(app)
      .post("/api/v4/users/ids")
      .set("Content-Type", "application/json")
      .send(body)
      .expect(200);
    expect(received.value).toBe(body);
  });

  it("POST /api/v4/foo with urlencoded body — handler sees the original bytes", async () => {
    const { app, received } = captureRawBodyApp();
    const body = "a=1&b=two&c=three";
    await request(app)
      .post("/api/v4/foo")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(body)
      .expect(200);
    expect(received.value).toBe(body);
  });
});

describe("installBodyParsers — non-/api/v4 routes still get express.json parsing", () => {
  it("POST /api/projects/test — req.body is the parsed JSON object", async () => {
    const { app } = captureRawBodyApp();
    const res = await request(app)
      .post("/api/projects/test")
      .set("Content-Type", "application/json")
      .send({ hello: "world", n: 7 })
      .expect(200);
    expect(res.body.parsedBody).toEqual({ hello: "world", n: 7 });
  });

  it("POST /api/billing/webhook — rawBody preserved via express.raw (byte-accurate, non-ASCII-safe)", async () => {
    const { app } = captureRawBodyApp();
    // Include a non-ASCII char so payload.length (UTF-16 code units) and
    // Buffer.byteLength (UTF-8 bytes) diverge — pins the byte-count
    // semantics Stripe signature verification depends on.
    const payload = JSON.stringify({ stripe: "événement" });
    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(payload)
      .expect(200);
    expect(res.body.rawBodyLength).toBe(Buffer.byteLength(payload, "utf8"));
    expect(res.body.rawBodyLength).toBeGreaterThan(payload.length);
  });

  it("caps unauthenticated Obsidian pairing completion bodies at 64 KiB", async () => {
    const { app } = captureRawBodyApp();
    const response = await request(app)
      .post("/api/connect/obsidian/pair/complete")
      .set("Content-Type", "application/json")
      .send({ connection: "x".repeat(70 * 1024) })
      .expect(413);
    expect(response.status).toBe(413);
  });
});
