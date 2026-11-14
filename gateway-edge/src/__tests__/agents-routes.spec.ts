import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAgentIdentity, NO_AGENT_IDENTITY } from "../lib/agent-identity.js";

const h = vi.hoisted(() => ({
  uid: "owner-1" as string | undefined,
  sync: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: { uid?: string }, _res: unknown, next: () => void) => {
    req.uid = h.uid;
    next();
  },
}));

const { default: agentRoutes } = await import("../routes/agents.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/agents", agentRoutes);
  a.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return a;
}

describe("agent routes", () => {
  beforeEach(() => {
    h.uid = "owner-1";
    h.sync.mockReset().mockResolvedValue(["name", "persona"]);
    installAgentIdentity({ ...NO_AGENT_IDENTITY, sync: h.sync });
  });

  afterEach(() => installAgentIdentity(NO_AGENT_IDENTITY));

  it("hands only the allowed name and persona fields to the installed agent identity", async () => {
    const res = await request(app())
      .patch("/api/agents/me")
      .send({ name: "Sage", persona: "Direct and practical.", ignored: "value" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, updated: ["name", "persona"] });
    expect(h.sync).toHaveBeenCalledWith("owner-1", { name: "Sage", persona: "Direct and practical." });
  });

  it("rejects a agent patch without allowed string fields", async () => {
    const res = await request(app())
      .patch("/api/agents/me")
      .send({ name: 42, nickname: "Sage" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "no_valid_fields",
      allowed: ["name", "persona"],
    });
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("fails loudly when no product store holds agent identity", async () => {
    installAgentIdentity(NO_AGENT_IDENTITY);

    const res = await request(app()).patch("/api/agents/me").send({ name: "Sage" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "agent identity needs a product store" });
  });
});
