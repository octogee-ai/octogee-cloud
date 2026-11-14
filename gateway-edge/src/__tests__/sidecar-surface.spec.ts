import { installUserEntitlements, staticUserEntitlements, userEntitlements } from "@octogee/shared/types/user-entitlements";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const firestore = vi.hoisted(() => ({
  collection: vi.fn(() => ({
    doc: () => ({
      get: async () => ({ exists: false, data: () => undefined }),
      update: async () => undefined,
      collection: () => ({
        doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
      }),
    }),
    where: () => ({ where: () => ({ get: async () => ({ size: 0, docs: [] }) }) }),
  })),
  doc: vi.fn(() => ({
    get: async () => ({ exists: false, data: () => undefined }),
  })),
}));

vi.mock("../lib/db", () => ({
  db: {
    collection: firestore.collection,
    doc: firestore.doc,
  },
  FieldValue: {
    delete: () => ({ __op: "delete" }),
    increment: (n: number) => ({ __op: "increment", operand: n }),
    serverTimestamp: () => ({ __op: "serverTimestamp" }),
  },
  Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
}));

import { createApp } from "../index.js";
import { _setGatewayTokenReviewerForTests } from "../middleware/gateway-internal-auth.js";

let projectedTokenDir: string | null = null;

function configureGatewayServiceAccountAuth() {
  projectedTokenDir = mkdtempSync(join(tmpdir(), "octogee-sidecar-auth-"));
  const tokenPath = join(projectedTokenDir, "token");
  writeFileSync(tokenPath, "projected-reviewer-token\n");

  delete process.env.INTERNAL_SERVICE_KEY;
  process.env.GATEWAY_CLASS = "isolated";
  process.env.GATEWAY_PROFILE = "isolated";
  process.env.GATEWAY_ID = "walter";
  process.env.K8S_NAMESPACE = "octogee-test";
  process.env.K8S_SERVICE_ACCOUNT_NAME = "octogee-gw-walter";
  process.env.OCTOGEE_API_SA_TOKEN_PATH = tokenPath;

  const reviewer = vi.fn(async (jwt: string) =>
    jwt === "valid-ksa-token"
      ? {
          authenticated: true as const,
          namespace: "octogee-test",
          saName: "octogee-gw-walter",
          audiences: ["octogee-api"],
        }
      : { authenticated: false as const },
  );
  _setGatewayTokenReviewerForTests(reviewer);
  return reviewer;
}

describe("gateway-edge sidecar surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _setGatewayTokenReviewerForTests(null);
    delete process.env.INTERNAL_SERVICE_KEY;
    delete process.env.OPENCLAW_RUNTIME_BROKER_URL;
    delete process.env.GATEWAY_PROFILE;
    delete process.env.GATEWAY_CLASS;
    delete process.env.GATEWAY_ID;
    delete process.env.K8S_NAMESPACE;
    delete process.env.K8S_SERVICE_ACCOUNT_NAME;
    delete process.env.OCTOGEE_API_SA_TOKEN_PATH;
    if (projectedTokenDir) rmSync(projectedTokenDir, { recursive: true, force: true });
    projectedTokenDir = null;
  });

  it("does not expose legacy platform internal brokers on the sidecar app", async () => {
    process.env.INTERNAL_SERVICE_KEY = "surface-test-key";
    const app = createApp({ surface: "sidecar" });

    expect(
      (
        await request(app)
          .post("/internal/gitea/ensure-user")
          .set("X-Internal-Service-Key", "surface-test-key")
          .send({ slug: "alice", pubKey: "ssh-ed25519 AAA" })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post("/internal/billing/check-trial-expiry")
          .set("X-Internal-Service-Key", "surface-test-key")
          .send({})
      ).status,
    ).toBe(404);
  });

  it("does not let locality auth middleware mask removed cluster APIs", async () => {
    const app = createApp({ surface: "sidecar" });

    expect((await request(app).get("/api/workspace/files")).status).toBe(404);
    expect((await request(app).post("/api/byosub/capture").send({})).status).toBe(404);
    expect((await request(app).get("/api/connect/state")).status).toBe(404);
    expect((await request(app).post("/api/projects").send({})).status).toBe(404);
  });

  it("keeps intended sidecar locality leaves mounted at the auth boundary", async () => {
    const app = createApp({ surface: "sidecar" });

    expect((await request(app).get("/api/g/gw-walter/workspace/git/status")).status).toBe(401);
    expect((await request(app).get("/api/g/gw-walter/byosub/health")).status).toBe(401);
    expect((await request(app).get("/api/g/gw-walter/agent-imports/sources/github")).status).toBe(401);
    expect(
      (await request(app).post("/api/g/gw-walter/projects/acme/widget/publish").send({}))
        .status,
    ).toBe(404);
  });

  it("authorizes gateway-local git through octogee-api with the caller's bearer, never Firestore", async () => {
    configureGatewayServiceAccountAuth();
    process.env.OPENCLAW_RUNTIME_BROKER_URL = "http://octogee-api:3001";
    const brokerFetch = vi.fn(async () => new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", brokerFetch);
    const app = createApp({ surface: "sidecar" });

    const res = await request(app)
      .get("/api/g/walter/workspace/git/status?slug=alice&project=orbit")
      .set("authorization", "Bearer firebase-token");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
    expect(brokerFetch).toHaveBeenCalledTimes(1);
    const [url, init] = brokerFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://octogee-api:3001/internal/workspace-git/authorize");
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer firebase-token");
    expect(headers.get("x-k8s-sa-token")).toBe("projected-reviewer-token");
    expect(JSON.parse(String(init.body))).toEqual({
      gatewayId: "walter",
      slug: "alice",
      projectSlug: "orbit",
      access: "read",
      resolveGithubToken: false,
    });
    expect(firestore.collection).not.toHaveBeenCalled();
    expect(firestore.doc).not.toHaveBeenCalled();
  });

  it("keeps workspace commits mounted but retires the in-pod project publisher", async () => {
    const app = createApp({ surface: "sidecar" });

    const commit = await request(app)
      .post("/internal/workspace/commit")
      .send({ slug: "../alice" });
    expect(commit.status).toBe(400);
    expect(commit.body).toEqual({ error: "Invalid slug", code: "BAD_SLUG" });

    const publish = await request(app)
      .post("/internal/project/publish")
      .send({ slug: "../alice", projectSlug: "demo" });
    expect(publish.status).toBe(404);
  });

  it("mounts the owner automation deputy on the sidecar alone", async () => {
    const invalid = { agentId: "octogee-alice-coach", action: "save", params: {} };
    const sidecar = await request(createApp({ surface: "sidecar" })).post("/internal/owner-automations").send(invalid);
    expect(sidecar.status).toBe(400);
    expect(sidecar.body).toEqual({ error: "invalid_owner_automation" });
    expect((await request(createApp({ surface: "cluster" })).post("/internal/owner-automations").send(invalid)).status).toBe(404);
  });

  it("fronts the gateway VM's style and Desk note for the gateway's own identity only, on the sidecar alone", async () => {
    configureGatewayServiceAccountAuth();
    const sidecar = createApp({ surface: "sidecar" });
    expect((await request(sidecar).post("/internal/computer/style").send({ style: "familiar" })).status).toBe(401);
    const noVm = await request(sidecar).post("/internal/computer/desk/note").set("x-k8s-sa-token", "valid-ksa-token").send({ note: "hi" });
    expect(noVm.status).toBe(404);
    expect(noVm.body).toEqual({ error: "computer_unavailable" });
    expect((await request(createApp({ surface: "cluster" })).post("/internal/computer/style").send({ style: "familiar" })).status).toBe(404);
  });

  it("requires valid gateway KSA auth on sidecar connector materialization", async () => {
    const reviewer = configureGatewayServiceAccountAuth();
    const app = createApp({ surface: "sidecar" });

    const missing = await request(app).get("/internal/connectors/cloudflare/materialize");
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ error: "x-k8s-sa-token header required" });
    expect(reviewer).not.toHaveBeenCalled();

    const invalid = await request(app)
      .get("/internal/connectors/cloudflare/materialize")
      .set("x-k8s-sa-token", "invalid-ksa-token");
    expect(invalid.status).toBe(401);
    expect(invalid.body).toEqual({ error: "Invalid internal service key" });
    expect(reviewer).toHaveBeenCalledWith("invalid-ksa-token");
  });

  it("does not mount connector materialization on the cluster surface", async () => {
    const reviewer = configureGatewayServiceAccountAuth();
    const app = createApp({ surface: "cluster" });

    const res = await request(app)
      .get("/internal/connectors/cloudflare/materialize")
      .set("x-k8s-sa-token", "valid-ksa-token");

    expect(res.status).toBe(404);
    expect(reviewer).not.toHaveBeenCalled();
  });
});

it("initializes bare platform entitlements when constructing the edge app", () => {
  const previous = userEntitlements();
  const slot = Symbol.for("octogee.userEntitlements");
  try {
    Reflect.deleteProperty(globalThis, slot);
    createApp({ surface: "sidecar" });
    expect(userEntitlements()).toBe(staticUserEntitlements);
  } finally {
    installUserEntitlements(previous);
  }
});
