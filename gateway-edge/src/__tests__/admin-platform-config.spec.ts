import { DEFAULT_OPS_AGENT_MODEL_REF } from "@octogee/shared/types/platform-config";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { platformDocs } = vi.hoisted(() => ({
  platformDocs: {} as Record<string, Record<string, unknown> | undefined>,
}));
const setCalls: Array<{ path: string; data: Record<string, unknown>; opts?: unknown }> = [];
const queryDocs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {};
const aggregateCalls: string[] = [];

vi.mock("../lib/platform-state", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(platformDocs) };
});

vi.mock("../middleware/auth", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    req.uid = "admin-user";
    req.user = { uid: "admin-user" };
    next();
  },
  requireAuth: (req: any, _res: any, next: any) => {
    req.uid = "admin-user";
    req.user = { uid: "admin-user" };
    next();
  },
}));

import express from "express";
import adminRouter from "../routes/admin.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return app;
}

describe("admin platform-config", () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
    for (const key of Object.keys(platformDocs)) delete platformDocs[key];
    for (const key of Object.keys(queryDocs)) delete queryDocs[key];
    setCalls.length = 0;
    aggregateCalls.length = 0;
  });

  it("GET serves the compiled default plus the full catalog when no doc exists", async () => {
    const res = await request(app).get("/api/admin/platform-config");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.freeTierModelRef).toBe("platform-openai/gpt-6-luna");
    expect(res.body.defaultFreeTierModelRef).toBe("platform-openai/gpt-6-luna");
    expect(res.body.opsAgentModelRef).toBe(DEFAULT_OPS_AGENT_MODEL_REF);
    expect(res.body.defaultOpsAgentModelRef).toBe(DEFAULT_OPS_AGENT_MODEL_REF);
    const refs = res.body.catalog.map((c: { ref: string }) => c.ref);
    expect(refs).toContain("anthropic/claude-haiku-4-5");
    expect(refs).toContain("platform-openrouter/z-ai/glm-5.2");
    expect(refs).toContain("platform-openrouter/deepseek/deepseek-v4-pro");
    expect(refs).toContain("platform-openrouter/openai/gpt-5.6-luna");
    const haiku = res.body.catalog.find((c: { ref: string }) => c.ref === "anthropic/claude-haiku-4-5");
    expect(haiku).toMatchObject({ label: "Claude Haiku 4.5", provider: "anthropic" });
    expect(res.body.opsCatalog.map((c: { ref: string }) => c.ref)).toEqual(
      expect.arrayContaining(["platform-openrouter/z-ai/glm-5.2"]),
    );
    expect(res.body.opsCatalog.every((c: { provider: string }) => c.provider === "openrouter")).toBe(true);
  });

  it("GET serves the configured dial when the doc exists", async () => {
    platformDocs["platformConfig/models"] = {
      freeTierModelRef: "anthropic/claude-haiku-4-5",
      opsAgentModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
    };
    const res = await request(app).get("/api/admin/platform-config");
    expect(res.status).toBe(200);
    expect(res.body.freeTierModelRef).toBe("anthropic/claude-haiku-4-5");
    expect(res.body.opsAgentModelRef).toBe("platform-openrouter/deepseek/deepseek-v4-pro");
  });

  it("GET resolves each model dial independently when its sibling is invalid", async () => {
    platformDocs["platformConfig/models"] = {
      freeTierModelRef: "anthropic/claude-haiku-4-5",
      opsAgentModelRef: "anthropic/claude-haiku-4-5",
    };
    let res = await request(app).get("/api/admin/platform-config");
    expect(res.body.freeTierModelRef).toBe("anthropic/claude-haiku-4-5");
    expect(res.body.opsAgentModelRef).toBe(DEFAULT_OPS_AGENT_MODEL_REF);

    platformDocs["platformConfig/models"] = {
      freeTierModelRef: "invalid/model",
      opsAgentModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
    };
    res = await request(app).get("/api/admin/platform-config");
    expect(res.body.freeTierModelRef).toBe("platform-openai/gpt-6-luna");
    expect(res.body.opsAgentModelRef).toBe("platform-openrouter/deepseek/deepseek-v4-pro");
  });

  it("GET falls back to the default when the stored ref left the catalog", async () => {
    platformDocs["platformConfig/models"] = { freeTierModelRef: "platform-openrouter/gone/model" };
    const res = await request(app).get("/api/admin/platform-config");
    expect(res.status).toBe(200);
    expect(res.body.freeTierModelRef).toBe("platform-openai/gpt-6-luna");
  });

  it("GET refuses a models doc whose ref is not a string with 409 so the operator replaces it", async () => {
    platformDocs["platformConfig/models"] = { freeTierModelRef: 42 };
    const res = await request(app).get("/api/admin/platform-config");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("platform_config_invalid");
  });

  it("GET serves the default agent dial with its compiled defaults", async () => {
    const res = await request(app).get("/api/admin/platform-config");
    expect(res.status).toBe(200);
    expect(res.body.builderAgentModelRef).toBe("platform-openai/gpt-6.1-terra");
    expect(res.body.defaultBuilderAgentModelRef).toBe(
      "platform-openai/gpt-6.1-terra",
    );
    expect(res.body.catalog).toContainEqual({
      ref: "platform-openai/gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      provider: "openai",
    });
    expect(res.body.builderAgentFallbackModelRef).toBe("platform-openrouter/z-ai/glm-5.2");
    expect(res.body.defaultBuilderAgentFallbackModelRef).toBe("platform-openrouter/z-ai/glm-5.2");

    platformDocs["platformConfig/models"] = {
      freeTierModelRef: "anthropic/claude-haiku-4-5",
      builderAgentModelRef: "anthropic/claude-sonnet-4-6",
      builderAgentFallbackModelRef: null,
    };
    const dialed = await request(app).get("/api/admin/platform-config");
    expect(dialed.body.builderAgentModelRef).toBe("anthropic/claude-sonnet-4-6");
    expect(dialed.body.builderAgentFallbackModelRef).toBeNull();
  });

  it("PUT writes the dial with audit fields and echoes the new value", async () => {
    const res = await request(app)
      .put("/api/admin/platform-config")
      .send({
        freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
        opsAgentModelRef: "platform-openrouter/z-ai/glm-5.2",
        builderAgentModelRef: "anthropic/claude-sonnet-4-6",
        builderAgentFallbackModelRef: "platform-openrouter/z-ai/glm-5.2",
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
      opsAgentModelRef: "platform-openrouter/z-ai/glm-5.2",
      builderAgentModelRef: "anthropic/claude-sonnet-4-6",
      builderAgentFallbackModelRef: "platform-openrouter/z-ai/glm-5.2",
    });
    expect(platformDocs["platformConfig/models"]).toEqual({
      freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
      opsAgentModelRef: "platform-openrouter/z-ai/glm-5.2",
      builderAgentModelRef: "anthropic/claude-sonnet-4-6",
      builderAgentFallbackModelRef: "platform-openrouter/z-ai/glm-5.2",
      updatedBy: "admin-user",
      updatedAt: expect.any(Number),
    });
  });

  it("PUT rejects a default agent ref outside the catalog", async () => {
    const res = await request(app).put("/api/admin/platform-config").send({
      freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
      builderAgentModelRef: "z-ai/glm-5.2",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_model_ref");
    expect(platformDocs["platformConfig/models"]).toBeUndefined();
  });

  it("PUT rejects a non-catalog ref with 400 and writes nothing", async () => {
    const res = await request(app)
      .put("/api/admin/platform-config")
      .send({ freeTierModelRef: "anthropic/model-not-in-catalog" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_model_ref");
    expect(platformDocs["platformConfig/models"]).toBeUndefined();
  });

  it("PUT rejects an Ops model outside the platform OpenRouter catalog", async () => {
    const res = await request(app).put("/api/admin/platform-config").send({
      freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
      opsAgentModelRef: "anthropic/claude-haiku-4-5",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_model_ref");
    expect(platformDocs["platformConfig/models"]).toBeUndefined();
  });

  it("PUT rejects a missing ref with 400", async () => {
    const res = await request(app).put("/api/admin/platform-config").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_model_ref");
  });
});

const ALL_OFF = {
  calendar: "off",
  gmail: "off",
  drive: "off",
  "drive-full": "off",
  tasks: "off",
  contacts: "off",
};
const SPLIT = { ...ALL_OFF, calendar: "on", tasks: "on", contacts: "on", drive: "on", gmail: "allowlist", "drive-full": "allowlist" };

describe("admin platform-connect-config", () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
    for (const key of Object.keys(platformDocs)) delete platformDocs[key];
    for (const key of Object.keys(queryDocs)) delete queryDocs[key];
    setCalls.length = 0;
  });

  it("GET serves the compiled dark default when no doc exists", async () => {
    const res = await request(app).get("/api/admin/platform-connect-config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ googleStages: ALL_OFF, googleAllowlistUids: [] });
  });

  it("GET serves the stored per-capability dial", async () => {
    platformDocs["platformConfig/connect"] = {
      googleStages: SPLIT,
      googleAllowlistUids: ["uid-chris", "uid-dan"],
    };
    const stored = await request(app).get("/api/admin/platform-connect-config");
    expect(stored.status).toBe(200);
    expect(stored.body).toEqual({
      googleStages: SPLIT,
      googleAllowlistUids: ["uid-chris", "uid-dan"],
    });
  });

  it("GET refuses a malformed doc (including the old global googleStage shape) with 409 instead of a dark fallback", async () => {
    platformDocs["platformConfig/connect"] = { googleStage: "allowlist", googleAllowlistUids: ["uid-chris"] };
    const malformed = await request(app).get("/api/admin/platform-connect-config");
    expect(malformed.status).toBe(409);
    expect(malformed.body.error).toBe("connect_config_invalid");
  });

  it("PUT replaces the doc with the per-capability map, audit fields, and the normalized allowlist", async () => {
    platformDocs["platformConfig/connect"] = { googleStage: "allowlist", googleAllowlistUids: ["uid-old"] };
    const res = await request(app)
      .put("/api/admin/platform-connect-config")
      .send({ googleStages: SPLIT, googleAllowlistUids: [" uid-chris ", ""] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      googleStages: SPLIT,
      googleAllowlistUids: ["uid-chris"],
    });
    expect(platformDocs["platformConfig/connect"]).toEqual({
      googleStages: SPLIT,
      googleAllowlistUids: ["uid-chris"],
      updatedBy: "admin-user",
      updatedAt: expect.any(Number),
    });
  });

  it("PUT rejects an unknown stage, an unknown capability, a missing capability, and the old shape with 400 and writes nothing", async () => {
    for (const body of [
      { googleStages: { ...ALL_OFF, gmail: "public" } },
      { googleStages: { ...ALL_OFF, voice: "on" } },
      { googleStages: { calendar: "on" } },
      { googleStage: "on" },
    ]) {
      const res = await request(app).put("/api/admin/platform-connect-config").send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe("invalid_connect_config");
    }
    expect(platformDocs["platformConfig/connect"]).toBeUndefined();
  });
});

describe("admin platform-connect-config — stage-only updates", () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
    for (const key of Object.keys(platformDocs)) delete platformDocs[key];
    for (const key of Object.keys(queryDocs)) delete queryDocs[key];
    setCalls.length = 0;
  });

  it("a stages-only PUT preserves the stored allowlist", async () => {
    platformDocs["platformConfig/connect"] = {
      googleStages: SPLIT,
      googleAllowlistUids: ["uid-chris", "uid-dan"],
    };
    const res = await request(app)
      .put("/api/admin/platform-connect-config")
      .send({ googleStages: { ...SPLIT, gmail: "on" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      googleStages: { ...SPLIT, gmail: "on" },
      googleAllowlistUids: ["uid-chris", "uid-dan"],
    });
    expect(platformDocs["platformConfig/connect"]).toMatchObject({
      googleStages: { ...SPLIT, gmail: "on" },
      googleAllowlistUids: ["uid-chris", "uid-dan"],
    });
  });

  it("a stages-only PUT over a malformed stored doc is refused with 409 and writes nothing", async () => {
    platformDocs["platformConfig/connect"] = { googleStage: "allowlist", googleAllowlistUids: ["uid-chris"] };
    const res = await request(app)
      .put("/api/admin/platform-connect-config")
      .send({ googleStages: SPLIT });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("connect_config_invalid");
    expect(platformDocs["platformConfig/connect"]).toEqual({ googleStage: "allowlist", googleAllowlistUids: ["uid-chris"] });
  });

  it("an explicit empty allowlist clears it", async () => {
    platformDocs["platformConfig/connect"] = {
      googleStages: SPLIT,
      googleAllowlistUids: ["uid-chris"],
    };
    const res = await request(app)
      .put("/api/admin/platform-connect-config")
      .send({ googleStages: SPLIT, googleAllowlistUids: [] });
    expect(res.status).toBe(200);
    expect(res.body.googleAllowlistUids).toEqual([]);
    expect(platformDocs["platformConfig/connect"]).toMatchObject({ googleAllowlistUids: [] });
  });
});
