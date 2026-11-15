import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import { createTenantBindingMiddleware } from "../tenant-binding.js";
import type { Reviewer } from "../../lib/token-review.js";

const WELL_FORMED_SA_TOKEN = [
  "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5LWlkIn0",
  "eyJhdWQiOlsib2N0b2dlZS1hcGkiXSwiZXhwIjoxNzUyODAwMDAwLCJpc3MiOiJrOHMifQ",
  "c2lnbmF0dXJlLXNlZ21lbnQtZm9yLXRlc3RpbmctcHVycG9zZXMtb25seQ",
].join(".");

function harness(reviewer: Reviewer) {
  const inc = vi.fn();
  const middleware = createTenantBindingMiddleware({
    reviewer,
    store: createDocumentFixtureStore({}),
    metrics: { attemptsTotal: { inc } as never },
    logger: { warn: vi.fn() },
  });
  const app = express();
  app.use(middleware);
  app.get("/internal/probe", (req, res) =>
    res.json({ boundTenant: req.boundTenant ?? null }),
  );
  return { app, inc };
}

describe("tenant binding malformed-token short-circuit", () => {
  it("rejects malformed tokens without spending a TokenReview call", async () => {
    const reviewer = vi.fn<Reviewer>();
    const { app, inc } = harness(reviewer);

    const res = await request(app)
      .get("/internal/probe")
      .set("x-k8s-sa-token", "junk-not-a-jwt")
      .expect(200);

    expect(res.body.boundTenant).toBeNull();
    expect(reviewer).not.toHaveBeenCalled();
    expect(inc).toHaveBeenCalledWith(
      expect.objectContaining({ result: "malformed" }),
    );
  });

  it("still reviews well-formed tokens", async () => {
    const reviewer = vi.fn<Reviewer>().mockResolvedValue({ authenticated: false });
    const { app, inc } = harness(reviewer);

    const res = await request(app)
      .get("/internal/probe")
      .set("x-k8s-sa-token", WELL_FORMED_SA_TOKEN)
      .expect(200);

    expect(res.body.boundTenant).toBeNull();
    expect(reviewer).toHaveBeenCalledWith(WELL_FORMED_SA_TOKEN);
    expect(inc).toHaveBeenCalledWith(
      expect.objectContaining({ result: "invalid" }),
    );
  });
});
