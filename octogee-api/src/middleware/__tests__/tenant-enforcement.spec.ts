import express from "express";
import { EventEmitter } from "node:events";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import {
  createTenantEnforcementMiddleware,
  NO_PRODUCT_TENANT_ROUTES,
  type FlowGatewayReader,
  type ProductTenantRoutes,
  type TenantAccessRecord,
} from "../tenant-enforcement.js";
import type { TenantDenial, TenantDenialReporter } from "../tenant-denial.js";

type UserDoc = Record<string, unknown>;
type FlowDoc = Record<string, unknown>;
type OperationDoc = Record<string, unknown>;

function flowGateways(flows: Record<string, FlowDoc> = {}): FlowGatewayReader {
  return async (flowId) => {
    const gatewayId = Object.prototype.hasOwnProperty.call(flows, flowId) ? flows[flowId].gatewayId : undefined;
    return typeof gatewayId === "string" ? gatewayId : null;
  };
}

function documentsAt(collection: string, records: Record<string, Record<string, unknown>> = {}) {
  return Object.fromEntries(Object.entries(records).map(([id, data]) => [`${collection}/${id}`, data]));
}

function fixtureStore(opts: {
  users: Record<string, UserDoc>;
  flows?: Record<string, FlowDoc>;
  operations?: Record<string, OperationDoc>;
  gateways?: Record<string, Record<string, unknown>>;
}) {
  return createDocumentFixtureStore({
    ...documentsAt("users", opts.users),
    ...documentsAt("byosubFlows", opts.flows),
    ...documentsAt("glmOperations", opts.operations),
    ...documentsAt("gateways", opts.gateways),
  });
}

const FIXTURE_PRODUCT_ROUTES: ProductTenantRoutes = {
  platformActorRoutes: {
    cron: ["/internal/product-jobs/first", "/internal/product-jobs/second", "/internal/product-fanout"],
    "llm-broker": ["/internal/product-events"],
  },
  userTargetedRoutes: ["/api/product-ingest"],
  platformOnlyRoutes: ["/internal/product-fanout"],
  tenantBoundApiRoutes: ["/api/product-ingest"],
  selfScopedBrokerRoutes: ["/internal/product-broker/list"],
};

function app(opts: {
  boundTenant?: Express.Request["boundTenant"];
  productRoutes?: ProductTenantRoutes;
  users?: Record<string, UserDoc>;
  flows?: Record<string, FlowDoc>;
  operations?: Record<string, OperationDoc>;
  gateways?: Record<string, Record<string, unknown>>;
  onDenied?: TenantDenialReporter;
  onAccess?: (record: TenantAccessRecord) => void;
  handlerStatus?: number;
}) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    if (opts.boundTenant) req.boundTenant = opts.boundTenant;
    next();
  });
  const records = {
    users:
      opts.users ?? {
        alice: {
          username: "alice",
          provisioning: { openclaw: { slug: "alice", gatewayId: "walter" } },
        },
        victim: {
          username: "victim",
          provisioning: { openclaw: { slug: "victim", gatewayId: "other" } },
        },
      },
    flows: opts.flows,
    operations: opts.operations,
    gateways: opts.gateways,
  };
  const enforcement = createTenantEnforcementMiddleware({
    onDenied: opts.onDenied ?? (async () => {}),
    onAccess: opts.onAccess ?? (() => {}),
    readFlowGateway: flowGateways(records.flows),
    store: fixtureStore(records),
    productRoutes: opts.productRoutes ?? FIXTURE_PRODUCT_ROUTES,
  });
  const handler = (_req: express.Request, res: express.Response) =>
    res.status(opts.handlerStatus ?? 200).json({ ok: true });
  a.post("/internal/probe", enforcement, handler);
  a.post("/internal/fleet/assignment-roster", enforcement, handler);
  a.post("/internal/probe/:uid", enforcement, handler);
  a.post("/internal/connectors/access-token", enforcement, handler);
  a.post("/internal/connectors/github-project-clone-access", enforcement, handler);
  a.post("/internal/byok/agent-usage-status", enforcement, handler);
  a.post("/internal/byok/broker-inspect", enforcement, handler);
  a.post("/internal/byok/byosub-flow", enforcement, handler);
  a.post("/internal/byok/byosub-cred-syncback", enforcement, handler);
  a.post("/internal/openclaw-control/redeem", enforcement, handler);
  a.post("/internal/openclaw-control/authorize", enforcement, handler);
  a.post("/internal/openclaw-control/profile", enforcement, handler);
  a.post("/internal/openclaw-control/tool-conversation", enforcement, handler);
  a.post("/internal/voice/conversation", enforcement, handler);
  a.post("/internal/voice/turn", enforcement, handler);
  a.post("/internal/voice/archive", enforcement, handler);
  a.post("/internal/openclaw-control/mattermost/authorize", enforcement, handler);
  a.post("/internal/openclaw-control/mattermost/channels", enforcement, handler);
  a.post("/internal/openclaw/notifications/final-reply", enforcement, handler);
  a.post("/internal/openclaw/activity/session-context", enforcement, handler);
  a.post("/internal/openclaw/activity/dispatch-context", enforcement, handler);
  a.post("/internal/workspace-git/authorize", enforcement, handler);
  a.post("/internal/channel-agent-readiness/authorize", enforcement, handler);
  a.post("/internal/product-broker/list", enforcement, handler);
  a.post("/internal/computer/agent-context", enforcement, handler);
  a.get("/internal/agent-imports/github/sources", enforcement, handler);
  a.get("/internal/agent-imports/records/:importId", enforcement, handler);
  a.patch("/internal/agent-imports/identity", enforcement, handler);
  a.delete("/internal/agent-imports/staging/:importId", enforcement, handler);
  a.post("/internal/fleet/agent/web-search", enforcement, handler);
  a.post("/internal/fleet/agent/web-extract", enforcement, handler);
  a.post("/internal/fleet/configured-builder-bootstrap", enforcement, handler);
  a.post("/internal/fleet/builder-identity", enforcement, handler);
  a.post("/internal/fleet/assigned-users", enforcement, handler);
  a.post("/internal/fleet/system-config-status", enforcement, handler);
  a.post("/internal/fleet/user-snapshot", enforcement, handler);
  a.post("/internal/fleet/builder-runtime-state/download-url", enforcement, handler);
  a.post("/internal/fleet/builder-runtime-state/snapshot-urls", enforcement, handler);
  a.post("/internal/fleet/builder-runtime-state/prune", enforcement, handler);
  a.post("/internal/fleet/agent-anchors/report", enforcement, handler);
  a.post("/internal/fleet/agent-anchors/read", enforcement, handler);
  a.post("/internal/fleet/computer-home/checkpoint-url", enforcement, handler);
  a.post("/internal/fleet/computer-home/commit", enforcement, handler);
  a.post("/internal/fleet/computer-home/download-url", enforcement, handler);
  a.post("/internal/fleet/computer-home/prune", enforcement, handler);
  a.post("/internal/fleet/vm-runtime", enforcement, handler);
  a.post("/internal/fleet/computer-egress", enforcement, handler);
  a.post("/internal/fleet/uid-for-slug", enforcement, handler);
  a.post("/internal/fleet/provisioned", enforcement, handler);
  a.post("/internal/product-jobs/first", enforcement, handler);
  a.post("/internal/product-jobs/second", enforcement, handler);
  a.post("/internal/chat-artifacts/claim", enforcement, handler);
  a.post("/internal/chat-artifacts/:artifactId/lease", enforcement, handler);
  a.post("/internal/product-events", enforcement, handler);
  a.post("/internal/fleet/npm-cache-authorize", enforcement, handler);
  a.post("/internal/fleet/npm-registry-credentials", enforcement, handler);
  a.post("/internal/product-fanout", enforcement, handler);
  a.post("/api/product-ingest", enforcement, handler);
  a.get("/internal/gitea/user-pubkey", enforcement, handler);
  return a;
}

const WALTER: Express.Request["boundTenant"] = {
  kind: "gateway",
  gatewayId: "walter",
  ownerUid: "owner-walter",
};

const WALTER_R2: Express.Request["boundTenant"] = {
  ...WALTER,
  podName: "octogee-gateway-walter-r2-5bc5949d46-p946t",
  podUid: "b0de5f4c-2d38-4dc9-9bb7-3f20a0d7beef",
};

function configuredWalter(overrides: Record<string, unknown> = {}) {
  return {
    gatewayId: "walter",
    createdAt: 1,
    createdBy: "admin",
    updatedAt: 2,
    updatedBy: "admin",
    latestRelease: 2,
    desiredRelease: 2,
    liveRelease: 1,
    liveRevisionId: "walter-r1",
    trafficRevisionId: "walter-r1",
    desiredStatus: "running",
    roll: {
      operationId: "roll-1",
      status: "warming",
      fromRelease: 1,
      toRelease: 2,
      sourceRevisionId: "walter-r1",
      targetRevisionId: "walter-r2",
      acceptingNewAssignments: false,
      startedAt: 2,
      updatedAt: 2,
      error: null,
      flippedAt: null,
    },
    configSchemaVersion: 1,
    profile: "isolated",
    gatewayClass: "isolated",
    imageProfile: "isolated",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: "octogee-gw-walter",
    serviceAccount: null,
    builderAccess: null,
    ownerUid: "owner-walter",
    builderSlug: "victim",
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

describe("tenant enforcement middleware", () => {
  it("admits no platform actor to a product path and applies no product gateway rule when no product supplies routes", async () => {
    const bare = (boundTenant: Express.Request["boundTenant"]) => app({ boundTenant, productRoutes: NO_PRODUCT_TENANT_ROUTES });

    for (const actor of ["cron", "glm-controller", "octogee-api", "llm-broker"] as const) {
      for (const path of ["/internal/product-jobs/first", "/internal/product-events", "/internal/product-fanout"]) {
        expect((await request(bare({ kind: "platform", actor })).post(path).send({})).status).toBe(403);
      }
    }
    expect((await request(bare(WALTER)).post("/internal/product-fanout").send({ gatewayId: "walter" })).status).toBe(200);
    expect((await request(bare(WALTER)).post("/api/product-ingest").send({ gatewayId: "walter" })).status).toBe(200);
    expect((await request(bare(WALTER)).post("/internal/product-broker/list").send({ agentId: "octogee-alice-coach", uid: "victim" })).status).toBe(403);
    expect((await request(app({ boundTenant: WALTER })).post("/internal/product-broker/list").send({ agentId: "octogee-alice-coach", uid: "victim" })).status).toBe(200);
    expect((await request(bare({ kind: "platform", actor: "artifact-worker" })).post("/internal/chat-artifacts/claim").send({})).status).toBe(200);
    expect((await request(bare({ kind: "platform", actor: "npm-cache-proxy" })).post("/internal/fleet/npm-cache-authorize").send({})).status).toBe(200);
  });

  it.each([
    "/internal/product-jobs/first",
    "/internal/product-jobs/second",
  ])("allows the cron caller on %s", async (path) => {
    const res = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post(path)
      .send({});
    expect(res.status).toBe(200);
  });

function disposableClaim(uid: string, extra: Record<string, unknown> = {}) {
  return {
    gatewayId: "ceckert-s-072b95aa",
    createdAt: 1,
    createdBy: "glm-controller",
    updatedAt: 1,
    updatedBy: "glm-controller",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: null,
    liveRevisionId: null,
    trafficRevisionId: null,
    roll: null,
    configSchemaVersion: 1,
    profile: "isolated",
    imageProfile: "isolated",
    gatewayClass: "isolated",
    desiredStatus: "running",
    ownerUid: uid,
    builderSlug: "ceckert",
    allocation: {
      kind: "disposable-builder",
      schemaVersion: 1,
      leaseId: "lease-1",
      generation: 41,
      claimedByUid: uid,
    },
    ...extra,
  };
}

const CLAIMING_GATEWAY = {
  kind: "gateway",
  gatewayId: "ceckert-s-072b95aa",
  ownerUid: "uid-ceckert",
} as const;

// The user mirror still names the shared slot until activation completes, so a
// booting disposable isolated cannot bootstrap unless its own claim counts.
const STILL_ON_SHARED = {
  "uid-ceckert": {
    username: "ceckert",
    provisioning: { openclaw: { slug: "ceckert", gatewayId: "shared-0" } },
  },
};

  it("lets a booting disposable isolated bootstrap the user it has claimed", async () => {
    const res = await request(app({
      boundTenant: CLAIMING_GATEWAY,
      users: STILL_ON_SHARED,
      gateways: { "ceckert-s-072b95aa": disposableClaim("uid-ceckert") },
    }))
      .post("/internal/fleet/system-config-status")
      .send({ uid: "uid-ceckert" });

    expect(res.status).toBe(200);
  });

  it("refuses a disposable isolated naming a user it has not claimed", async () => {
    const res = await request(app({
      boundTenant: CLAIMING_GATEWAY,
      users: {
        "uid-other": {
          username: "other",
          provisioning: { openclaw: { slug: "other", gatewayId: "shared-0" } },
        },
      },
      gateways: { "ceckert-s-072b95aa": disposableClaim("uid-ceckert") },
    }))
      .post("/internal/fleet/system-config-status")
      .send({ uid: "uid-other" });

    expect(res.status).toBe(403);
  });

  it("refuses a retired gateway still carrying a stale claim", async () => {
    const res = await request(app({
      boundTenant: CLAIMING_GATEWAY,
      users: STILL_ON_SHARED,
      gateways: {
        "ceckert-s-072b95aa": disposableClaim("uid-ceckert", { desiredStatus: "retired" }),
      },
    }))
      .post("/internal/fleet/system-config-status")
      .send({ uid: "uid-ceckert" });

    expect(res.status).toBe(403);
  });

  it("forbids a platform-bound caller on any non-cron internal route (no skeleton key)", async () => {
    const res = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post("/internal/probe")
      .send({});

    expect(res.status).toBe(403);
  });

  it("allows the artifact worker only on artifact worker routes", async () => {
    const worker = { kind: "platform", actor: "artifact-worker" } as const;
    const claim = await request(app({ boundTenant: worker }))
      .post("/internal/chat-artifacts/claim")
      .send({ workerId: "artifact-worker-1" });
    const lease = await request(app({ boundTenant: worker }))
      .post(`/internal/chat-artifacts/${"a".repeat(64)}/lease`)
      .send({});
    const billing = await request(app({ boundTenant: worker }))
      .post("/internal/product-jobs/first")
      .send({});
    const cronClaim = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post("/internal/chat-artifacts/claim")
      .send({ workerId: "cron" });

    expect(claim.status).toBe(200);
    expect(lease.status).toBe(200);
    expect(billing.status).toBe(403);
    expect(cronClaim.status).toBe(403);
  });

  it("allows the LLM broker only on its product-event route", async () => {
    const broker = { kind: "platform", actor: "llm-broker" } as const;
    const productEvent = await request(app({ boundTenant: broker }))
      .post("/internal/product-events")
      .send({ uid: "uid-alice" });
    const billing = await request(app({ boundTenant: broker }))
      .post("/internal/product-jobs/first")
      .send({});
    const cronProductEvent = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post("/internal/product-events")
      .send({ uid: "uid-alice" });

    expect(productEvent.status).toBe(200);
    expect(billing.status).toBe(403);
    expect(cronProductEvent.status).toBe(403);
  });

  it("allows the npm cache proxy only on capability authorization", async () => {
    const proxy = { kind: "platform", actor: "npm-cache-proxy" } as const;
    const authorize = await request(app({ boundTenant: proxy }))
      .post("/internal/fleet/npm-cache-authorize")
      .send({ token: "opaque" });
    const productEvent = await request(app({ boundTenant: proxy }))
      .post("/internal/product-events")
      .send({ uid: "uid-alice" });
    const cronAuthorize = await request(app({
      boundTenant: { kind: "platform", actor: "cron" },
    }))
      .post("/internal/fleet/npm-cache-authorize")
      .send({ token: "opaque" });

    expect(authorize.status).toBe(200);
    expect(productEvent.status).toBe(403);
    expect(cronAuthorize.status).toBe(403);
  });

  it("does not honor a legacy X-Internal-Service-Key", async () => {
    const res = await request(app({}))
      .post("/internal/product-jobs/first")
      .set("X-Internal-Service-Key", "platform-key")
      .send({});

    expect(res.status).toBe(403);
  });

  it("rejects missing binding before route handlers run", async () => {
    const res = await request(app({}))
      .post("/internal/probe")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "forbidden: request carries no gateway tenant binding",
      code: "tenant-enforcement",
    });
  });

  describe("denial reporting", () => {
    function denialCapture() {
      const denials: TenantDenial[] = [];
      const onDenied = vi.fn(async (denial: TenantDenial) => { denials.push(denial); });
      return { denials, onDenied };
    }

    it("reports a fall-through deny with the reason, the bound tenant, and the calling agent", async () => {
      const { denials, onDenied } = denialCapture();
      const res = await request(app({ boundTenant: WALTER, onDenied }))
        .post("/internal/probe")
        .send({ agentId: "octogee-alice-coach" });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "forbidden: route is not admitted for gateway tenants and the request names no owned user, slug, gateway, or flow",
        code: "tenant-enforcement",
      });
      expect(denials).toEqual([{
        method: "POST",
        path: "/internal/probe",
        reason: "route is not admitted for gateway tenants and the request names no owned user, slug, gateway, or flow",
        cause: "policy",
        tenant: { kind: "gateway", gatewayId: "walter", ownerUid: "owner-walter" },
        agentId: "octogee-alice-coach",
      }]);
    });

    it("marks assignment-skew denials as placement so they stay out of the user's inbox", async () => {
      const { denials, onDenied } = denialCapture();
      await request(app({ boundTenant: WALTER, onDenied }))
        .post("/internal/product-broker/list")
        .send({ gatewayId: "other", agentId: "octogee-alice-coach" })
        .expect(403);
      await request(app({ boundTenant: WALTER, onDenied }))
        .post("/internal/probe")
        .send({ workspaceSlug: "stranger" })
        .expect(403);
      await request(app({ boundTenant: WALTER, onDenied }))
        .post("/internal/probe")
        .send({ agentId: "octogee-alice-coach" })
        .expect(403);
      expect(denials.map((d) => [d.reason, d.cause])).toEqual([
        ["request names a gatewayId other than the bound gateway", "placement"],
        ["request names a workspace slug not assigned to the bound gateway", "placement"],
        ["route is not admitted for gateway tenants and the request names no owned user, slug, gateway, or flow", "policy"],
      ]);
    });

    it("reports a foreign-gateway deny and a platform-actor deny with their own reasons", async () => {
      const { denials, onDenied } = denialCapture();
      await request(app({ boundTenant: WALTER, onDenied }))
        .post("/internal/product-broker/list")
        .send({ gatewayId: "other", agentId: "octogee-alice-coach" })
        .expect(403);
      await request(app({ boundTenant: { kind: "platform", actor: "cron" }, onDenied }))
        .post("/internal/probe")
        .send({})
        .expect(403);

      expect(denials.map((d) => [d.tenant, d.reason, d.agentId])).toEqual([
        [
          { kind: "gateway", gatewayId: "walter", ownerUid: "owner-walter" },
          "request names a gatewayId other than the bound gateway",
          "octogee-alice-coach",
        ],
        [{ kind: "platform", actor: "cron" }, "platform actor cron is not admitted on this route", null],
      ]);
    });

    it("reports an unbound deny without an agent", async () => {
      const { denials, onDenied } = denialCapture();
      await request(app({ onDenied })).post("/internal/probe").send({ agentId: 42 }).expect(403);
      expect(denials).toEqual([{
        method: "POST",
        path: "/internal/probe",
        reason: "request carries no gateway tenant binding",
        cause: "policy",
        tenant: { kind: "unbound" },
        agentId: null,
      }]);
    });

    it("does not report an admitted call", async () => {
      const { denials, onDenied } = denialCapture();
      await request(app({ boundTenant: WALTER, onDenied }))
        .post("/internal/product-broker/list")
        .send({ agentId: "octogee-alice-coach" })
        .expect(200);
      expect(denials).toEqual([]);
    });

    it("still answers 403 when the reporter rejects", async () => {
      const onDenied = vi.fn(async () => { throw new Error("inbox down"); });
      const res = await request(app({ boundTenant: WALTER, onDenied })).post("/internal/probe").send({});
      expect(res.status).toBe(403);
      expect(onDenied).toHaveBeenCalledOnce();
    });
  });

  describe("access audit", () => {
    function accessCapture() {
      const records: TenantAccessRecord[] = [];
      const onAccess = vi.fn((record: TenantAccessRecord) => { records.push(record); });
      return { records, onAccess };
    }

    it("records an admitted call with the bound tenant, calling agent, and final status", async () => {
      const { records, onAccess } = accessCapture();
      await request(app({ boundTenant: WALTER_R2, onAccess, handlerStatus: 404 }))
        .post("/internal/product-broker/list")
        .send({ agentId: "octogee-alice-coach" })
        .expect(404);

      expect(records).toEqual([{
        method: "POST",
        path: "/internal/product-broker/list",
        decision: "admitted",
        status: 404,
        responseCompleted: true,
        tenant: { kind: "gateway", gatewayId: "walter", ownerUid: "owner-walter" },
        podName: "octogee-gateway-walter-r2-5bc5949d46-p946t",
        agentId: "octogee-alice-coach",
      }]);
    });

    it("captures the full broker path before a mounted router handles the request", async () => {
      const { records, onAccess } = accessCapture();
      const server = express();
      server.use((req, _res, next) => {
        req.boundTenant = { kind: "platform", actor: "artifact-worker" };
        next();
      });
      server.use(createTenantEnforcementMiddleware({ onAccess, readFlowGateway: flowGateways(), store: fixtureStore({ users: {} }) }));
      const router = express.Router();
      router.get("/:artifactId/source", (_req, res) => res.send("data"));
      server.use("/internal/chat-artifacts", router);

      await request(server).get("/internal/chat-artifacts/demo/source?token=private").expect(200);

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ path: "/internal/chat-artifacts/demo/source", responseCompleted: true });
    });

    it.each([false, true])("records a response exactly once when finish=%s precedes close", (finished) => {
      const { records, onAccess } = accessCapture();
      const req = {
        method: "GET", path: "/internal/chat-artifacts/demo/source",
        boundTenant: { kind: "platform", actor: "artifact-worker" },
      } as express.Request;
      const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: finished });
      createTenantEnforcementMiddleware({ onAccess, readFlowGateway: flowGateways(), store: fixtureStore({ users: {} }) })(req, res as unknown as express.Response, () => {});

      if (finished) res.emit("finish");
      res.emit("close");

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        path: "/internal/chat-artifacts/demo/source", status: 200, responseCompleted: finished,
      });
    });

    it("does not mark a disconnect during authorization as admitted", () => {
      const { records, onAccess } = accessCapture();
      const req = { method: "POST", path: "/internal/product-broker/list", boundTenant: WALTER } as express.Request;
      const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
      createTenantEnforcementMiddleware({ onAccess, readFlowGateway: flowGateways(), store: fixtureStore({ users: {} }), productRoutes: FIXTURE_PRODUCT_ROUTES, onDenied: async () => {} })(
        req, res as unknown as express.Response, () => {},
      );
      res.emit("close");
      expect(records[0]).toMatchObject({ decision: "pending", responseCompleted: false });
    });

    it("records a denied call with its reason", async () => {
      const { records, onAccess } = accessCapture();
      await request(app({ boundTenant: WALTER, onAccess }))
        .post("/internal/product-broker/list")
        .send({ gatewayId: "other", agentId: "octogee-alice-coach" })
        .expect(403);

      expect(records).toEqual([{
        method: "POST",
        path: "/internal/product-broker/list",
        decision: "denied",
        status: 403,
        responseCompleted: true,
        reason: "request names a gatewayId other than the bound gateway",
        tenant: { kind: "gateway", gatewayId: "walter", ownerUid: "owner-walter" },
        agentId: "octogee-alice-coach",
      }]);
    });

    it("records platform actors and unbound callers", async () => {
      const { records, onAccess } = accessCapture();
      await request(app({ boundTenant: { kind: "platform", actor: "llm-broker" }, onAccess }))
        .post("/internal/product-events")
        .send({});
      await request(app({ onAccess })).post("/internal/probe").send({}).expect(403);

      expect(records.map((r) => [r.tenant, r.decision])).toEqual([
        [{ kind: "platform", actor: "llm-broker" }, "admitted"],
        [{ kind: "unbound" }, "denied"],
      ]);
    });

    it("does not record the once-a-second assignment roster poll", async () => {
      const { records, onAccess } = accessCapture();
      await request(app({ boundTenant: WALTER, onAccess }))
        .post("/internal/fleet/assignment-roster")
        .send({ revisionId: "walter" });

      expect(records).toEqual([]);
    });

    it("still answers when the access recorder throws", async () => {
      const onAccess = vi.fn(() => { throw new Error("log sink down"); });
      await request(app({ boundTenant: WALTER, onAccess }))
        .post("/internal/product-broker/list")
        .send({ agentId: "octogee-alice-coach" })
        .expect(200);
      expect(onAccess).toHaveBeenCalledOnce();
    });
  });

  it("allows a gateway-bound caller to target its own gatewayId only", async () => {
    const owned = await request(app({ boundTenant: WALTER }))
      .post("/internal/probe")
      .send({ gatewayId: "walter" });

    const foreign = await request(app({ boundTenant: WALTER }))
      .post("/internal/probe")
      .send({ gatewayId: "other" });

    expect(owned.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  it("admits the exact web-extension body only when it claims the bound gateway", async () => {
    const extensionBody = {
      gatewayId: "walter",
      agentId: "octogee-alice-coach",
      requestId: "tool-1",
      provider: "brave",
      query: "octopus research",
    };
    const admitted = await request(app({ boundTenant: WALTER }))
      .post("/internal/fleet/agent/web-search")
      .send(extensionBody);
    const missingGateway = await request(app({ boundTenant: WALTER }))
      .post("/internal/fleet/agent/web-search")
      .send({ ...extensionBody, gatewayId: undefined });
    const foreignGateway = await request(app({ boundTenant: WALTER }))
      .post("/internal/fleet/agent/web-extract")
      .send({ ...extensionBody, gatewayId: "other", urls: ["https://example.com"] });

    expect(admitted.status).toBe(200);
    expect(missingGateway.status).toBe(403);
    expect(foreignGateway.status).toBe(403);
  });

  it("allows a gateway-bound caller to target only users assigned to that gateway", async () => {
    const owned = await request(app({ boundTenant: WALTER }))
      .post("/internal/probe")
      .send({ uid: "alice" });

    const foreign = await request(app({ boundTenant: WALTER }))
      .post("/internal/probe")
      .send({ uid: "victim" });

    expect(owned.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  it("does not let a matching gatewayId bypass uid ownership checks on ordinary routes", async () => {
    const owned = await request(app({ boundTenant: WALTER }))
      .post("/internal/probe")
      .send({ gatewayId: "walter", uid: "alice" });

    const foreign = await request(app({ boundTenant: WALTER }))
      .post("/internal/probe")
      .send({ gatewayId: "walter", uid: "victim" });

    expect(owned.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  it("lets a gateway report only its own assigned user as provisioned", async () => {
    const report = (body: Record<string, unknown>) =>
      request(app({ boundTenant: WALTER })).post("/internal/fleet/provisioned").send({ first: true, ...body });

    expect((await report({ gatewayId: "walter", uid: "alice" })).status).toBe(200);
    expect((await report({ gatewayId: "walter", uid: "victim" })).status).toBe(403);
    expect((await report({ gatewayId: "other", uid: "alice" })).status).toBe(403);
  });

  it("admits only a bound gateway to the final reply route's own recipient authorization", async () => {
    const path = "/internal/openclaw/notifications/final-reply";
    expect((await request(app({ boundTenant: WALTER })).post(path).send({ gatewayId: "walter" })).status).toBe(200);
    expect((await request(app({ boundTenant: WALTER })).post(path).send({ gatewayId: "other" })).status).toBe(403);
    expect((await request(app({})).post(path).send({ gatewayId: "walter" })).status).toBe(403);
    expect((await request(app({ boundTenant: { kind: "platform", actor: "cron" } })).post(path).send({ gatewayId: "walter" })).status).toBe(403);
  });

  it("does not let a matching gatewayId bypass foreign notification recipients", async () => {
    const owned = await request(app({ boundTenant: WALTER }))
      .post("/api/product-ingest")
      .send({ gatewayId: "walter", targetUserIds: ["alice"] });
    const foreign = await request(app({ boundTenant: WALTER }))
      .post("/api/product-ingest")
      .send({ gatewayId: "walter", targetUserIds: ["victim"] });

    expect(owned.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  it("never lends gateway authority to the platform-wide social fanout", async () => {
    const res = await request(app({ boundTenant: WALTER }))
      .post("/internal/product-fanout")
      .send({
        gatewayId: "walter",
        actorUid: "alice",
        type: "announcement",
        targetUserIds: [],
      });

    expect(res.status).toBe(403);
  });

  it("keeps the platform producer authorized for the social fanout", async () => {
    const res = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post("/internal/product-fanout")
      .send({
        actorUid: "admin",
        actorName: "Octogee",
        type: "announcement",
        targetUserIds: [],
      });

    expect(res.status).toBe(200);
  });

  it("lets the connector-token broker perform its own project-membership authorization", async () => {
    const ownedGateway = await request(app({ boundTenant: WALTER }))
      .post("/internal/connectors/access-token")
      .send({
        gatewayId: "walter",
        uid: "victim",
        access: {
          kind: "project",
          requestingUid: "owner-walter",
          workspaceSlug: "victim",
          projectSlug: "octo",
        },
      });

    const foreignGateway = await request(app({ boundTenant: WALTER }))
      .post("/internal/connectors/access-token")
      .send({
        gatewayId: "other",
        uid: "victim",
        access: {
          kind: "project",
          requestingUid: "owner-walter",
          workspaceSlug: "victim",
          projectSlug: "octo",
        },
      });

    expect(ownedGateway.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("lets the fleet broker resolve an unassigned stale slug for idempotent eviction", async () => {
    const stale = await request(app({ boundTenant: WALTER }))
      .post("/internal/fleet/uid-for-slug")
      .send({ gatewayId: "walter", slug: "departed" });

    const foreignGateway = await request(app({ boundTenant: WALTER }))
      .post("/internal/fleet/uid-for-slug")
      .send({ gatewayId: "other", slug: "alice" });

    expect(stale.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("passes a configured user owner snapshot to the route-level admission", async () => {
    const target = app({
      boundTenant: WALTER_R2,
      gateways: { walter: configuredWalter() },
    });
    const owner = await request(target)
      .post("/internal/fleet/user-snapshot")
      .send({ gatewayId: "walter", uid: "owner-walter" });
    const foreignGateway = await request(target)
      .post("/internal/fleet/user-snapshot")
      .send({ gatewayId: "other", uid: "owner-walter" });

    expect(owner.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("lets VM context resolve its own assigned-agent authorization", async () => {
    const target = app({ boundTenant: WALTER });
    const response = await request(target).post("/internal/computer/agent-context").send({ agentId: "octogee-alice-coach" });
    expect(response.status).toBe(200);
  });

  it("lets the byosub flow broker perform its own roster authorization for new flows", async () => {
    const ownedGateway = await request(app({ boundTenant: WALTER, flows: {} }))
      .post("/internal/byok/byosub-flow")
      .send({
        flowId: "fresh-flow-123",
        agentId: "octogee-alice-coach",
        provider: "anthropic",
      });

    const foreignGateway = await request(app({ boundTenant: WALTER, flows: {} }))
      .post("/internal/byok/byosub-flow")
      .send({
        gatewayId: "other",
        flowId: "fresh-flow-123",
        agentId: "octogee-alice-coach",
        provider: "anthropic",
      });

    expect(ownedGateway.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("passes byosub credential syncback to route-level roster authorization", async () => {
    const ownedGateway = await request(app({ boundTenant: WALTER }))
      .post("/internal/byok/byosub-cred-syncback")
      .send({ agentId: "octogee-alice-coach", provider: "openai", credential: "{}" });
    const foreignGateway = await request(app({ boundTenant: WALTER }))
      .post("/internal/byok/byosub-cred-syncback")
      .send({ gatewayId: "other", agentId: "octogee-alice-coach", provider: "openai", credential: "{}" });

    expect(ownedGateway.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it.each(["agent-usage-status", "broker-inspect"])("passes %s to route-level roster authorization", async route => {
    const ownedGateway = await request(app({ boundTenant: WALTER }))
      .post(`/internal/byok/${route}`)
      .send({ agentId: "octogee-alice-coach" });
    const foreignGateway = await request(app({ boundTenant: WALTER }))
      .post(`/internal/byok/${route}`)
      .send({ gatewayId: "other", agentId: "octogee-alice-coach" });

    expect(ownedGateway.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("passes session context to route-level agent and channel authorization", async () => {
    const ownedGateway = await request(app({ boundTenant: WALTER }))
      .post("/internal/openclaw/activity/session-context")
      .send({
        agentId: "octogee-alice-coach",
        channelId: "mattermost-task-channel",
      });
    const foreignGateway = await request(app({ boundTenant: WALTER }))
      .post("/internal/openclaw/activity/session-context")
      .send({
        gatewayId: "other",
        agentId: "octogee-alice-coach",
        channelId: "mattermost-task-channel",
      });
    const platform = await request(
      app({ boundTenant: { kind: "platform", actor: "cron" } }),
    )
      .post("/internal/openclaw/activity/session-context")
      .send({
        agentId: "octogee-alice-coach",
        channelId: "mattermost-task-channel",
      });

    expect(ownedGateway.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
    expect(platform.status).toBe(403);
  });

  it("passes dispatch context only to the bound gateway tenant", async () => {
    const ownedGateway = await request(app({ boundTenant: WALTER }))
      .post("/internal/openclaw/activity/dispatch-context")
      .send({ agentId: "octogee-alice-coach" });
    const foreignGateway = await request(app({ boundTenant: WALTER }))
      .post("/internal/openclaw/activity/dispatch-context")
      .send({ gatewayId: "other", agentId: "octogee-alice-coach" });
    const platform = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post("/internal/openclaw/activity/dispatch-context")
      .send({ agentId: "octogee-alice-coach" });

    expect(ownedGateway.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
    expect(platform.status).toBe(403);
  });

  it("delegates exact OpenClaw Control routes only for the bound gateway tenant", async () => {
    for (const route of ["redeem", "authorize", "profile", "tool-conversation", "mattermost/authorize", "mattermost/channels"]) {
      const ownedGateway = await request(app({ boundTenant: WALTER }))
        .post(`/internal/openclaw-control/${route}`)
        .send({ gatewayId: "walter", uid: "victim" });
      const foreignGateway = await request(app({ boundTenant: WALTER }))
        .post(`/internal/openclaw-control/${route}`)
        .send({ gatewayId: "other" });

      expect(ownedGateway.status, route).toBe(200);
      expect(foreignGateway.status, route).toBe(403);
    }
  });

  it("delegates voice conversation and turn brokering only for the bound gateway tenant", async () => {
    for (const route of ["conversation", "turn"]) {
      const ownedGateway = await request(app({ boundTenant: WALTER }))
        .post(`/internal/voice/${route}`)
        .send({ gatewayId: "walter", uid: "victim", channelId: "c".repeat(26), text: "hello" });
      const foreignGateway = await request(app({ boundTenant: WALTER }))
        .post(`/internal/voice/${route}`)
        .send({ gatewayId: "other", uid: "victim", channelId: "c".repeat(26), text: "hello" });

      expect(ownedGateway.status, route).toBe(200);
      expect(foreignGateway.status, route).toBe(403);
    }
  });

  it("delegates opaque voice archive custody only to a gateway tenant for route-local authorization", async () => {
    const body = { voiceGrant: "g".repeat(43), sessionId: "native", entries: [{ transcriptId: "voice:native:1", role: "user", text: "Hello" }], truncated: false };
    expect((await request(app({ boundTenant: WALTER })).post("/internal/voice/archive").send(body)).status).toBe(200);
    expect((await request(app({})).post("/internal/voice/archive").send(body)).status).toBe(403);
    expect((await request(app({ boundTenant: { kind: "platform", actor: "cron" } })).post("/internal/voice/archive").send(body)).status).toBe(403);
    expect((await request(app({ boundTenant: WALTER })).post("/internal/voice/archive").send({ ...body, gatewayId: "other" })).status).toBe(403);
  });

  it("allows a gateway-bound caller to target only slugs assigned to that gateway", async () => {
    const owned = await request(app({ boundTenant: WALTER }))
      .post("/internal/probe")
      .send({ slug: "alice" });

    const foreign = await request(app({ boundTenant: WALTER }))
      .post("/internal/probe")
      .send({ slug: "victim" });

    expect(owned.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  it("does not let a matching gatewayId bypass slug ownership checks on ordinary routes", async () => {
    const owned = await request(app({ boundTenant: WALTER }))
      .post("/internal/probe")
      .send({ gatewayId: "walter", slug: "alice" });

    const foreign = await request(app({ boundTenant: WALTER }))
      .post("/internal/probe")
      .send({ gatewayId: "walter", slug: "victim" });

    expect(owned.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  it("allows Gitea broker slug access during a running inbound user migration", async () => {
    const inbound = await request(
      app({
        boundTenant: WALTER,
        operations: {
          inbound: {
            kind: "migrate-user",
            status: "running",
            inputUid: "victim",
            input: { uid: "victim", toGatewayId: "walter" },
          },
        },
      }),
    )
      .get("/internal/gitea/user-pubkey")
      .query({ slug: "victim" });

    const ordinaryRoute = await request(
      app({
        boundTenant: WALTER,
        operations: {
          inbound: {
            kind: "migrate-user",
            status: "running",
            inputUid: "victim",
            input: { uid: "victim", toGatewayId: "walter" },
          },
        },
      }),
    )
      .post("/internal/probe")
      .send({ slug: "victim" });

    expect(inbound.status).toBe(200);
    expect(ordinaryRoute.status).toBe(403);
  });

  it("refuses the Gitea inbound migration allowance when two users claim the slug", async () => {
    const onDenied = vi.fn(async () => {});
    const res = await request(
      app({
        boundTenant: WALTER,
        users: {
          victim: { username: "victim", provisioning: { openclaw: { slug: "victim", gatewayId: "other" } } },
          impostor: { username: "victim" },
        },
        operations: {
          inbound: {
            kind: "migrate-user",
            status: "running",
            inputUid: "victim",
            input: { uid: "victim", toGatewayId: "walter" },
          },
        },
        onDenied,
      }),
    )
      .get("/internal/gitea/user-pubkey")
      .query({ slug: "victim" });

    expect(res.status).toBe(403);
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringMatching(/^authorization check failed: /),
    }));
  });

  it("keeps the Gitea inbound migration allowance scoped to the target gateway", async () => {
    const res = await request(
      app({
        boundTenant: WALTER,
        operations: {
          inbound: {
            kind: "migrate-user",
            status: "running",
            inputUid: "victim",
            input: { uid: "victim", toGatewayId: "other" },
          },
        },
      }),
    )
      .get("/internal/gitea/user-pubkey")
      .query({ slug: "victim" });

    expect(res.status).toBe(403);
  });

  it("allows an authenticated stable gateway pod to bootstrap its configured user", async () => {
    const res = await request(app({
      boundTenant: WALTER_R2,
      gateways: { walter: configuredWalter() },
    }))
      .get("/internal/gitea/user-pubkey")
      .query({ slug: "victim" });

    expect(res.status).toBe(200);
  });

  it("passes configured user credential bootstrap to its stricter route-level authorization", async () => {
    const res = await request(app({
      boundTenant: WALTER_R2,
      gateways: { walter: configuredWalter() },
    }))
      .post("/internal/fleet/configured-builder-bootstrap")
      .send({ gatewayId: "walter", revisionId: "walter-r2", slug: "victim" });

    expect(res.status).toBe(200);
  });

  it("passes user identity reads to their route-level authorization without a named gateway", async () => {
    const res = await request(app({
      boundTenant: WALTER_R2,
      gateways: { walter: configuredWalter() },
    }))
      .post("/internal/fleet/builder-identity")
      .send({});

    expect(res.status).toBe(200);
  });

  it("passes configured user owner snapshots to their stricter route-level authorization", async () => {
    const target = app({
      boundTenant: WALTER_R2,
      gateways: { walter: configuredWalter() },
    });

    const owner = await request(target)
      .post("/internal/fleet/user-snapshot")
      .send({ gatewayId: "walter", uid: "victim" });
    const foreignGateway = await request(target)
      .post("/internal/fleet/user-snapshot")
      .send({ gatewayId: "other", uid: "victim" });

    expect(owner.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("passes isolated runtime state snapshot and prune routes to their allocation-bound authorization", async () => {
    const target = app({
      boundTenant: WALTER_R2,
      gateways: { walter: configuredWalter() },
    });

    const download = await request(target)
      .post("/internal/fleet/builder-runtime-state/download-url")
      .send({ gatewayId: "walter", revisionId: "walter-r2", slug: "victim" });
    const snapshot = await request(target)
      .post("/internal/fleet/builder-runtime-state/snapshot-urls")
      .send({
        gatewayId: "walter",
        revisionId: "walter-r2",
        slug: "victim",
        size: 1024,
        recoveryTiers: ["minute"],
      });
    const prune = await request(target)
      .post("/internal/fleet/builder-runtime-state/prune")
      .send({ gatewayId: "walter", revisionId: "walter-r2", slug: "victim" });
    const foreign = await request(target)
      .post("/internal/fleet/builder-runtime-state/download-url")
      .send({ gatewayId: "other", revisionId: "other", slug: "victim" });
    const anchorReport = await request(target)
      .post("/internal/fleet/agent-anchors/report")
      .send({ gatewayId: "walter", revisionId: "walter-r2", slug: "victim", anchors: [{ agentId: "octogee-victim-coach", storeId: "92c817cc-770f-466d-b4a6-4e9b02998363", schema: "octogee_agent_92c817cc770f466d" }], configuredAgentIds: ["octogee-victim-coach"] });
    const anchorRead = await request(target)
      .post("/internal/fleet/agent-anchors/read")
      .send({ gatewayId: "walter", revisionId: "walter-r2", slug: "victim" });
    const foreignAnchors = await request(target)
      .post("/internal/fleet/agent-anchors/read")
      .send({ gatewayId: "other", revisionId: "other", slug: "victim" });

    expect(download.status).toBe(200);
    expect(snapshot.status).toBe(200);
    expect(prune.status).toBe(200);
    expect(foreign.status).toBe(403);
    expect(anchorReport.status).toBe(200);
    expect(anchorRead.status).toBe(200);
    expect(foreignAnchors.status).toBe(403);
  });

  it("passes channel readiness to its user-membership broker and rejects a foreign gateway", async () => {
    const target = app({ boundTenant: WALTER, gateways: { walter: configuredWalter() } });
    const route = "/internal/channel-agent-readiness/authorize";
    expect((await request(target).post(route).send({ gatewayId: "walter", channelId: "a".repeat(26) })).status).toBe(200);
    expect((await request(target).post(route).send({ gatewayId: "other", channelId: "a".repeat(26) })).status).toBe(403);
  });

  it("passes vm-home checkpoint routes to their VM-bound authorization and rejects a claimed foreign gateway", async () => {
    const target = app({
      boundTenant: { ...WALTER, podName: "octogee-gw-walter", podUid: "4242" },
      gateways: { walter: configuredWalter() },
    });
    const routes = ["checkpoint-url", "commit", "download-url", "prune"] as const;

    for (const route of routes) {
      const own = await request(target)
        .post(`/internal/fleet/computer-home/${route}`)
        .send({ gatewayId: "walter", slug: "victim", size: 1 });
      const foreign = await request(target)
        .post(`/internal/fleet/computer-home/${route}`)
        .send({ gatewayId: "other", slug: "victim", size: 1 });
      expect(own.status, route).toBe(200);
      expect(foreign.status, route).toBe(403);
    }
  });

  it("admits the VM egress mode route for the gateway's own binding with an empty body and refuses a foreign gateway claim", async () => {
    const target = app({
      boundTenant: { ...WALTER, podName: "octogee-gw-walter", podUid: "4242" },
      gateways: { walter: configuredWalter() },
    });
    expect((await request(target).post("/internal/fleet/computer-egress").send({})).status).toBe(200);
    expect((await request(target).post("/internal/fleet/computer-egress").send({ mode: "desktop" })).status).toBe(200);
    expect((await request(target).post("/internal/fleet/computer-egress").send({ gatewayId: "other", mode: "desktop" })).status).toBe(403);
  });

  it("limits a retired VM's final-checkpoint binding to the runtime bundle and checkpoint upload routes", async () => {
    const target = app({
      boundTenant: { ...WALTER, podName: "octogee-gw-walter", podUid: "4242", finalHomeCheckpoint: true },
      gateways: { walter: configuredWalter({ desiredStatus: "retired" }) },
    });
    const send = (path: string, body: Record<string, unknown> = { gatewayId: "walter", slug: "alice", size: 1 }) =>
      request(target).post(path).send(body);

    for (const path of ["/internal/fleet/vm-runtime", "/internal/fleet/computer-home/checkpoint-url", "/internal/fleet/computer-home/commit", "/internal/fleet/computer-home/prune"]) {
      expect((await send(path)).status, path).toBe(200);
    }
    for (const path of [
      "/internal/fleet/computer-home/download-url",
      "/internal/fleet/user-snapshot",
      "/internal/fleet/configured-builder-bootstrap",
      "/internal/fleet/builder-identity",
      "/internal/fleet/builder-runtime-state/download-url",
      "/internal/openclaw-control/authorize",
      "/internal/workspace-git/authorize",
      "/internal/channel-agent-readiness/authorize",
      "/internal/byok/agent-usage-status",
      "/internal/byok/broker-inspect",
      "/internal/product-broker/list",
      "/internal/computer/agent-context",
    ]) {
      expect((await send(path)).status, path).toBe(403);
    }
    expect((await send("/internal/probe", { uid: "alice" })).status).toBe(403);
    expect((await send("/internal/probe", { gatewayId: "walter" })).status).toBe(403);
    expect((await send("/internal/fleet/computer-home/commit", { gatewayId: "other", slug: "alice", size: 1 })).status).toBe(403);
  });

  it("answers a retired VM with the denial text that released gateways compare against", async () => {
    const target = app({
      boundTenant: { ...WALTER, podName: "octogee-gw-walter", podUid: "4242", finalHomeCheckpoint: true },
      gateways: { walter: configuredWalter({ desiredStatus: "retired" }) },
    });

    const denied = await request(target)
      .post("/internal/fleet/npm-registry-credentials")
      .send({ gatewayId: "walter", slug: "alice" });

    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("forbidden: retired computer bindings may only reach final-checkpoint routes");
  });

  it("allows any pod of the gateway's own Deployment — identity, never lifecycle (GATEWAY-SIMPLE-ROLL-SPEC)", async () => {
    const anyPod = await request(app({
      boundTenant: {
        ...WALTER_R2,
        podName: "octogee-gateway-walter-r1-5bc5949d46-p946t",
      },
      gateways: { walter: configuredWalter() },
    }))
      .get("/internal/gitea/user-pubkey")
      .query({ slug: "victim" });

    expect(anyPod.status).toBe(200);
  });

  it("rejects unbound callers and revokes configured-user bootstrap while retiring", async () => {
    const unbound = await request(app({
      boundTenant: WALTER,
      gateways: { walter: configuredWalter() },
    }))
      .get("/internal/gitea/user-pubkey")
      .query({ slug: "victim" });
    const retiring = await request(app({
      boundTenant: WALTER_R2,
      gateways: {
        walter: configuredWalter({
          retirementClaim: { operationId: "retire-1", version: 1 },
        }),
      },
    }))
      .get("/internal/gitea/user-pubkey")
      .query({ slug: "victim" });

    expect(unbound.status).toBe(403);
    expect(retiring.status).toBe(403);
  });

  it("allows BYOS capture only for flows owned by the bound gateway", async () => {
    const owned = await request(
      app({
        boundTenant: WALTER,
        flows: {
          owned: { gatewayId: "walter" },
          foreign: { gatewayId: "other" },
        },
      }),
    )
      .post("/internal/probe")
      .send({ flowId: "owned" });

    const foreign = await request(
      app({
        boundTenant: WALTER,
        flows: {
          owned: { gatewayId: "walter" },
          foreign: { gatewayId: "other" },
        },
      }),
    )
      .post("/internal/probe")
      .send({ gatewayId: "walter", flowId: "foreign" });

    expect(owned.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  it("rejects unknown BYOS capture flows before the route handler runs", async () => {
    const res = await request(app({ boundTenant: WALTER, flows: {} }))
      .post("/internal/probe")
      .send({ flowId: "missing" });

    expect(res.status).toBe(403);
  });

  it("rejects targetless gateway-bound calls so global jobs stay platform-only", async () => {
    const res = await request(app({ boundTenant: WALTER }))
      .post("/internal/probe")
      .send({});

    expect(res.status).toBe(403);
  });

  it("admits targetless agent-import broker calls for route-local owner authorization", async () => {
    const target = app({ boundTenant: WALTER });
    const responses = await Promise.all([
      request(target).get("/internal/agent-imports/github/sources"),
      request(target).get("/internal/agent-imports/records/import-1"),
      request(target).patch("/internal/agent-imports/identity").send({ name: "Moof" }),
      request(target).delete("/internal/agent-imports/staging/import-1"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
  });
});

it.each(["/internal/fleet/npm-registry-credentials", "/internal/connectors/github-project-clone-access"])(
  "passes %s preparation to its operation-bound authorization while rejecting a foreign gateway", async (route) => {
    const target = app({ boundTenant: WALTER_R2 });
    const responses = await Promise.all([
      request(target).post(route).send({ gatewayId: "walter", slug: "victim", access: { kind: "project-clone", builderSlug: "victim", projectSlug: "project" } }),
      request(target).post(route).send({ gatewayId: "other", slug: "victim", access: { kind: "project-clone", builderSlug: "victim", projectSlug: "project" } }),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 403]);
  },
);
