import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  aggregateBrokerDiagnostics,
  addAdminUserDirectoryRoutes,
  mergeDailyUsage,
  noAdminUserDirectorySource,
  type AdminUserDirectoryRouterDeps,
} from "./admin-user-directory-router.js";
import { noUserAccounts } from "./user-account.js";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";

type DocData = Record<string, unknown>;
type DocStore = Map<string, DocData>;

function makeBarePlatformApp(docs: Record<string, DocData>) {
  return appWith(new Map(Object.entries(docs)), { accounts: noUserAccounts, source: noAdminUserDirectorySource });
}

function appWith(
  documents: DocStore,
  product: Pick<AdminUserDirectoryRouterDeps, "accounts" | "source" | "productUserDetail">,
) {
  const app = express();
  app.use(express.json());

  const deps: AdminUserDirectoryRouterDeps = {
    store: createDocumentFixtureStore(documents),
    logger: { info: vi.fn(), warn: vi.fn() },
    ...product,
  };

  const router = express.Router();
  addAdminUserDirectoryRoutes(router, deps);
  app.use("/api/admin", router);
  return app;
}

function userDoc(overrides: DocData = {}): DocData {
  return {
    email: "user@example.com",
    username: "builder",
    displayName: "User",
    subscription: { tier: "hobby", status: "active" },
    usage: {},
    provisioning: { openclaw: { status: "complete", slug: "builder" } },
    ...overrides,
  };
}

describe("mergeDailyUsage", () => {
  it("keeps legacy token/interaction telemetry but takes USD only from the broker series", () => {
    const merged = mergeDailyUsage(
      [
        { date: "2026-06-30", tokensUsed: 469_438, interactions: 19, costUsd: 0 },
        { date: "2026-06-29", tokensUsed: 676_435, interactions: 23, costUsd: 0.0001 },
      ],
      new Map([
        ["2026-06-30", { date: "2026-06-30", costUsd: 0.72, totalTokens: 420_000, requestCount: 15 }],
      ]),
    );

    expect(merged[0]).toMatchObject({
      date: "2026-06-30",
      tokensUsed: 469_438, // legacy telemetry survives (covers byosub traffic)
      interactions: 19,
      costUsd: 0.72, // broker is the only USD source
      brokerTokens: 420_000,
    });
    // no broker events that day → $0, never the legacy openclaw figure
    expect(merged[1]).toMatchObject({ date: "2026-06-29", costUsd: 0 });
  });

  it("surfaces broker-only days that have no legacy log doc", () => {
    const merged = mergeDailyUsage(
      [],
      new Map([
        ["2026-07-01", { date: "2026-07-01", costUsd: 0.29, totalTokens: 90_000, requestCount: 4 }],
      ]),
    );
    expect(merged).toEqual([
      {
        date: "2026-07-01",
        tokensUsed: 90_000,
        interactions: 4,
        costUsd: 0.29,
        brokerTokens: 90_000,
      },
    ]);
  });
});

describe("admin user routes — bare platform", () => {
  const recorded = (): Record<string, DocData> => ({
    "users/uid-1": userDoc({ usage: { totalTokensUsed: 900 } }),
    "users/uid-1/workspaces/builder": { name: "Builder" },
    "users/uid-1/admin_actions/a1": { action: "setTier", at: 1_800_000_000_000 },
    "modelBrokerUsageRollups/uid-1": { costUsd: 1.73, totalTokens: 1_000 },
    "system/stats": { totalCustomers: 7 },
  });

  it("lists the platform's users without product accounts, usage or a total", async () => {
    const res = await request(makeBarePlatformApp(recorded())).get("/api/admin/users").expect(200);

    expect(res.body.items).toEqual([expect.objectContaining({ uid: "uid-1", email: "", costUsd: 0 })]);
    expect(res.body.total).toBeNull();
  });

  it("details a platform user with no product usage, workspaces or broker cost", async () => {
    const res = await request(makeBarePlatformApp(recorded())).get("/api/admin/users/uid-1").expect(200);

    expect(res.body.provisioning).toMatchObject({ status: "complete", slug: "builder" });
    expect(res.body.usage).toMatchObject({ totalTokensUsed: 0, costUsd: 0 });
    expect(res.body).toMatchObject({ workspaces: [], usageLogs: [], modelCosts: {}, modelCredential: null });
  });

  it("details the stored model credential without its secret, with its last use as a date", async () => {
    const res = await request(makeBarePlatformApp({
      ...recorded(),
      "modelCredentials/uid-1": {
        uid: "uid-1", active: true, provider: "anthropic", mode: "api_key", status: "active", reasonCode: "ok",
        secretName: "byok-builder-anthropic", fingerprint: "sk-ant…7890", keyHash: "deadbeefcafe", baseUrl: null,
        model: "claude-sonnet-4-6", addedAt: 1, lastUsedAt: Date.parse("2026-06-02T03:04:05.000Z"),
      },
    })).get("/api/admin/users/uid-1").expect(200);

    expect(res.body.modelCredential).toEqual({
      active: true, provider: "anthropic", mode: "api_key", status: "active", reasonCode: "ok",
      fingerprint: "sk-ant…7890", model: "claude-sonnet-4-6", baseUrl: null, lastUsedAt: "2026-06-02T03:04:05.000Z",
    });
    expect(res.body.byot).toEqual({ active: true });
    expect(JSON.stringify(res.body)).not.toContain("byok-builder-anthropic");
  });

  it("reports an empty audit trail", async () => {
    const res = await request(makeBarePlatformApp(recorded())).get("/api/admin/users/uid-1/audit").expect(200);

    expect(res.body.items).toEqual([]);
  });
});

describe("POST /api/admin/users/:uid/ops", () => {
  it("is not a directory route; a plan change belongs to the product", async () => {
    const app = makeBarePlatformApp({ "users/uid-ops": userDoc() });

    const res = await request(app).post("/api/admin/users/uid-ops/ops").send({ action: "setTier", value: "pro" });

    expect(res.status).toBe(404);
  });
});

describe("aggregateBrokerDiagnostics — the where-did-my-window-go projection", () => {
  const JULY3 = Date.UTC(2026, 6, 3, 17);
  const ev = (over: Record<string, unknown>) => ({
    createdAt: JULY3,
    model: "claude-sonnet-4-6",
    totalTokens: 20_100,
    costUsd: 0.076,
    usage: { inputTokens: 3, outputTokens: 90, cacheCreationInputTokens: 20_009, cacheReadInputTokens: 0 },
    costBreakdown: { input: 0.0001, output: 0.0013, cacheRead: 0, cacheWrite: 0.075 },
    degraded: false,
    brokerTokenSecretName: "agent-model-token-canary-glm-blue-uid1",
    ...over,
  });

  it("aggregates per-day×model with cache-write share, decomposition, and newest-first recent calls", () => {
    const out = aggregateBrokerDiagnostics([
      ev({}),
      ev({ createdAt: JULY3 + 60_000, costUsd: 0.01, costBreakdown: { input: 0.0001, output: 0.0013, cacheRead: 0.006, cacheWrite: 0.002 }, usage: { inputTokens: 1, outputTokens: 88, cacheCreationInputTokens: 281, cacheReadInputTokens: 20_002 } }),
      ev({ createdAt: Date.UTC(2026, 6, 4, 1), model: "z-ai/glm-5.2", totalTokens: 15_600, costUsd: 0.016, costBreakdown: { input: 0.016, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      ev({ createdAt: 0 }), // no timestamp → excluded from days, not counted
    ]);

    expect(out.days).toEqual([
      expect.objectContaining({ date: "2026-07-03", model: "claude-sonnet-4-6", requestCount: 2, cacheWriteUsd: expect.closeTo(0.077, 5) }),
      expect.objectContaining({ date: "2026-07-04", model: "z-ai/glm-5.2", requestCount: 1 }),
    ]);
    expect(out.decomposition.cacheWrite).toBeCloseTo(0.077, 5);
    expect(out.decomposition.input).toBeCloseTo(0.0162, 5);
    expect(out.recentCalls[0]).toMatchObject({ model: "z-ai/glm-5.2", cacheWriteTokens: 20_009 });
    expect(out.recentCalls[1]).toMatchObject({ cacheReadTokens: 20_002, degraded: false });
    expect(out.recentCalls).toHaveLength(4);
    expect(out.recentCalls[2].brokerTokenSecretName).toContain("canary-glm-blue");
  });

  it("caps the recent-call list", () => {
    const out = aggregateBrokerDiagnostics(
      Array.from({ length: 40 }, (_, i) => ev({ createdAt: JULY3 + i })),
      25,
    );
    expect(out.recentCalls).toHaveLength(25);
    expect(out.recentCalls[0].at).toBe(JULY3 + 39);
  });
});
