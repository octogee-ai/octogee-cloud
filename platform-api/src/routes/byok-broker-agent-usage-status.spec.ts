import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { durableGatewayRoot } from "@octogee/core-testing/admin-fleet-route-app";
import type { FundedBudget } from "@octogee/core/model-broker/budget";
import {
  createModelBrokerRailRegistry,
  operatorRail,
  type ModelBrokerRail,
  type OwnerRailProfile,
} from "@octogee/core/model-broker/rails";
import { InMemoryModelBrokerUsageStore } from "@octogee/core/model-broker/usage";
import type { UserAccount } from "@octogee/core/user-account";
import { NO_BROKER_RECORDS } from "../lib/broker-records.js";
import { createByokBrokerRoutes } from "./byok-broker.js";

const GATEWAY_ID = "shared-blue";
const AGENT_ID = "octogee-alice-coach";
const UID = "uid-alice";
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

const budget: FundedBudget = {
  ownerUid: UID,
  ledgerCollection: "fundedBudgets",
  ledgerKey: `${UID}_budget`,
  ledgerBinding: { budgetId: "budget" },
  ledgerRetentionMs: 30 * 86_400_000,
  expiresAtMs: NOW + 6 * 86_400_000,
  capUsd: 4.8,
  hardCapUsd: 8,
  nextCapIncreaseAtMs: NOW + 3_600_000,
  logFields: {},
};

const PROFILES: Record<string, OwnerRailProfile> = {
  funded: {
    rail: "metered",
    spendWindowUsd: 0,
    spendWeekUsd: 0,
    windowBudgets: false,
    freeTier: false,
    houseFallback: false,
    fundedBudget: budget,
  },
  windows: {
    rail: "metered",
    spendWindowUsd: 2,
    spendWeekUsd: 20,
    windowBudgets: true,
    freeTier: false,
    houseFallback: true,
    fundedBudget: null,
  },
};

const meteredRail: ModelBrokerRail = {
  ...operatorRail,
  id: "metered",
  throttle: (observation) => {
    const { fundedBudget, fundedLedger } = observation;
    if (fundedBudget && fundedLedger &&
        fundedLedger.chargeUsd >= Math.min(fundedBudget.capUsd, fundedBudget.hardCapUsd)) {
      return { degraded: false, blocked: true, reason: "funded_budget_exhausted", balanceVisible: false };
    }
    return operatorRail.throttle(observation);
  },
};

const rails = createModelBrokerRailRegistry({
  rails: [operatorRail, meteredRail],
  defaultRailId: operatorRail.id,
  resolveOwnerProfile: (ownerData) => PROFILES[String(ownerData.meter)] ?? null,
});

function account(meter: string): UserAccount {
  return {
    uid: UID,
    username: "alice",
    email: null,
    displayName: null,
    lastActive: null,
    planInputs: { meter },
    usage: {},
    mattermostUsername: null,
  };
}

function server(meter: string, usage: InMemoryModelBrokerUsageStore) {
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: GATEWAY_ID, tokenSource: "ksa" } as never;
    next();
  }) as RequestHandler);
  app.use("/internal/byok", createByokBrokerRoutes({
    store: createDocumentFixtureStore({
      [`users/${UID}`]: {
        username: "alice",
        provisioning: { openclaw: { gatewayId: GATEWAY_ID, slug: "alice", agentIds: [AGENT_ID] } },
      },
      [`gateways/${GATEWAY_ID}`]: durableGatewayRoot(GATEWAY_ID),
    }),
    records: {
      ...NO_BROKER_RECORDS,
      accounts: {
        get: async (uid) => (uid === UID ? account(meter) : null),
        getMany: async () => new Map(),
        list: async () => new Map(),
      },
      usage,
    },
    rails,
    now: () => NOW,
    verifyOwnerWorkspaceTurn: async () => true,
  }));
  return app;
}

async function status(meter: string, usage: InMemoryModelBrokerUsageStore) {
  const response = await request(server(meter, usage))
    .post("/internal/byok/agent-usage-status")
    .send({ agentId: AGENT_ID })
    .expect(200);
  return response.body as Record<string, unknown>;
}

describe("POST /internal/byok/agent-usage-status", () => {
  it("reports a funded budget spent past what is available now as blocked, in the legacy fields too", async () => {
    const usage = new InMemoryModelBrokerUsageStore();
    usage.fundedBudgetLedgers.set(budget.ledgerKey, {
      ...budget.ledgerBinding,
      ownerUid: UID,
      chargeUsd: 4.9,
      requestCount: 400,
      totalTokens: 20_000_000,
      updatedAt: NOW,
      expiresAt: new Date(NOW + budget.ledgerRetentionMs),
    });

    const body = await status("funded", usage);

    expect(body.spend).toEqual({
      rail: "metered",
      meter: {
        kind: "funded_budget",
        usedUsd: 4.9,
        availableUsd: 4.8,
        hardCapUsd: 8,
        percentUsed: 100,
        nextIncreaseAt: "2026-11-18T13:00:00.000Z",
        endsAt: "2026-11-24T12:00:00.000Z",
      },
      balanceUsd: null,
      throttle: { degraded: false, blocked: true, reason: "funded_budget_exhausted" },
      needsAttention: true,
    });
    expect(body.week).toEqual({ percentUsed: 100, resetAt: "2026-11-24T12:00:00.000Z" });
    expect(body.window).toEqual({
      percentUsed: 100,
      nextRefillAt: "2026-11-18T13:00:00.000Z",
      degraded: false,
      blocked: true,
      reason: "funded_budget_exhausted",
    });
    expect(body.credits).toBeNull();
    expect(body.credential).toEqual({ path: "platform_broker", provider: null });
    expect(body.gatewayClass).toBe("shared");
  });

  it("reports the week and the burst window for a plan with spend windows", async () => {
    const usage = new InMemoryModelBrokerUsageStore();
    await usage.recordUsage({
      requestId: "req-1",
      provider: "anthropic",
      gatewayId: GATEWAY_ID,
      ownerUid: UID,
      model: "claude-sonnet-4-5",
      usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      method: "POST",
      path: "/v1/messages",
      upstreamStatus: 200,
      chargeUsd: 10,
      now: NOW,
    });

    const body = await status("windows", usage);

    expect(body.spend).toMatchObject({
      meter: {
        kind: "spend_windows",
        week: { usedUsd: 10, limitUsd: 20, percentUsed: 50, resetsAt: "2026-11-19T00:00:00.000Z" },
        window: { usedUsd: 10, limitUsd: 2, percentUsed: 100, resetsAt: "2026-11-18T16:00:00.000Z" },
      },
      throttle: { degraded: true, blocked: false, reason: "window_exhausted" },
    });
    expect(body.week).toEqual({ percentUsed: 50, resetAt: "2026-11-19T00:00:00.000Z" });
    expect(body.window).toEqual({
      percentUsed: 100,
      nextRefillAt: "2026-11-18T16:00:00.000Z",
      degraded: true,
      blocked: false,
      reason: "window_exhausted",
    });
  });
});
