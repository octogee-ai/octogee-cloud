import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { FeaturePolicy } from "../lib/feature-policy.js";
import { createFeatureRoutes } from "./features.js";

const auth: RequestHandler = (req, _res, next) => {
  req.uid = "uid-alice";
  req.user = { selectedTier: "personal" };
  next();
};

describe("GET /api/features", () => {
  it("returns only the registered user-visible snapshot", async () => {
    const api = express();
    api.use("/api/features", createFeatureRoutes({
      auth,
      requireAccount: (_req, _res, next) => next(),
      featurePolicy: new FeaturePolicy({
        evaluate: async () => ({
          isEnabled: (key) => key === "release-agent-import",
        }),
      }),
    }));

    await request(api).get("/api/features").expect(200, {
      flags: {
        "release-openclaw-dashboard": false,
        "release-agent-import": true,
        "release-agent-export": false,
        "release-builder-gateway": false,
        "release-obsidian-connection": false,
        "release-workspace-sharing": false,
        "release-project-repo-source": false,
        "release-voice-talk": false,
        "release-coach-readiness": false,
      },
    });
  });

  it("fails closed when the provider cannot evaluate the snapshot", async () => {
    const api = express();
    api.use("/api/features", createFeatureRoutes({
      auth,
      requireAccount: (_req, _res, next) => next(),
      featurePolicy: new FeaturePolicy({
        evaluate: async () => { throw new Error("provider unavailable"); },
      }),
    }));

    await request(api).get("/api/features")
      .expect(503, { error: "feature_evaluation_unavailable" });
  });

  it("limits requests from one verified account without throttling another account at the same address", async () => {
    const api = express();
    api.use("/api/features", createFeatureRoutes({
      auth: (req, _res, next) => {
        req.uid = req.get("authorization") === "Bearer test-a" ? "user-a" : "user-b";
        next();
      },
      requireAccount: (_req, _res, next) => next(),
      featurePolicy: new FeaturePolicy({ evaluate: async () => ({ isEnabled: () => false }) }),
    }));
    const client = request(api);
    for (let count = 0; count < 120; count++) await client.get("/api/features").set("authorization", "Bearer test-a").expect(200);
    const rejected = await client.get("/api/features").set("authorization", "Bearer test-a").expect(429);
    expect(rejected.body).toEqual({ error: "Too many requests, please try again later." });
    await client.get("/api/features").set("authorization", "Bearer test-b").expect(200);
  });
});
