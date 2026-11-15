import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { deriveByosubHealth } from "@octogee/core/model-credentials/byosub";
import {
  createByosubHealthRouter,
  type ByosubHealthDeps,
} from "../routes/byosub-health.js";
import {
  CLAUDE_CLI_DEFAULT_PROFILE_ID,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
} from "@octogee/core/model-credential-materializer";

const PROFILE = OPENAI_CODEX_DEFAULT_PROFILE_ID;
const CLAUDE_PROFILE = CLAUDE_CLI_DEFAULT_PROFILE_ID;
const NOW = 1_700_000_000_000;

// A codex auth-state that deriveCodexAuthHealth reads as permanently dead.
const DEAD_STATE = JSON.stringify({
  usageStats: { [PROFILE]: { disabledReason: "auth_permanent" } },
});

function base() {
  return {
    storePresent: true,
    profileExpiresAt: null,
    authStateText: "",
    profileId: PROFILE,
    now: NOW,
  };
}

describe("deriveByosubHealth — ref (expectation) ✕ store (reality)", () => {
  it("not mounted on this pod → not_on_this_pod (even if a ref says it should be here)", () => {
    expect(
      deriveByosubHealth({ ...base(), mountedHere: false, refProvider: "openai" }),
    ).toEqual({ connected: false, status: "not_on_this_pod" });
  });

  it("mounted, no byosub ref → not_connected (user never set up BYOS)", () => {
    expect(
      deriveByosubHealth({ ...base(), mountedHere: true, refProvider: null }),
    ).toEqual({ connected: false, status: "not_connected" });
  });

  it("mounted + ref present but pod store ABSENT → missing (the durability failure the shallow check can't see)", () => {
    expect(
      deriveByosubHealth({
        ...base(),
        mountedHere: true,
        refProvider: "openai",
        storePresent: false,
      }),
    ).toEqual({ connected: false, status: "missing", provider: "openai" });
  });

  it("mounted + ref + store present + clean auth-state → healthy, connected", () => {
    expect(
      deriveByosubHealth({
        ...base(),
        mountedHere: true,
        refProvider: "openai",
        storePresent: true,
        authStateText: "",
      }),
    ).toEqual({ connected: true, status: "healthy", provider: "openai" });
  });

  it("mounted + ref + store present but codex marked it permanently dead → needs_reauth", () => {
    expect(
      deriveByosubHealth({
        ...base(),
        mountedHere: true,
        refProvider: "openai",
        storePresent: true,
        authStateText: DEAD_STATE,
      }),
    ).toEqual({ connected: false, status: "needs_reauth", provider: "openai" });
  });

  it("mounted + ref + store present but profile expired → needs_reauth", () => {
    expect(
      deriveByosubHealth({
        ...base(),
        mountedHere: true,
        refProvider: "anthropic",
        profileId: CLAUDE_PROFILE,
        profileExpiresAt: NOW - 1,
      }),
    ).toEqual({ connected: false, status: "needs_reauth", provider: "anthropic" });
  });

  it("missing ranks below not_on_this_pod: a wrong-pod probe never masquerades as a durability failure", () => {
    // mountedHere=false dominates regardless of store state — the client asked
    // the wrong pod (mid-migration / stale gatewayId), not a real materialization gap.
    expect(
      deriveByosubHealth({
        ...base(),
        mountedHere: false,
        refProvider: "openai",
        storePresent: false,
      }).status,
    ).toBe("not_on_this_pod");
  });
});

function appWith(deps: ByosubHealthDeps) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { uid?: string }).uid = "uid-1";
    next();
  });
  app.use("/api/g/:gatewayId/byosub", createByosubHealthRouter(deps));
  app.use("/probe/byosub", createByosubHealthRouter(deps));
  return app;
}

function healthPath(gatewayId = "default"): string {
  return `/api/g/${gatewayId}/byosub/health`;
}

function fakeDeps(over: Partial<ByosubHealthDeps> = {}): ByosubHealthDeps {
  return {
    resolveUserGateway: async () => ({
      slug: "smile-wring-011b",
      gatewayId: "default",
      refProvider: "openai",
    }),
    localGatewayId: () => "default",
    isMounted: () => true,
    readStorePresent: () => true,
    readProfileExpiresAt: () => null,
    readAuthStateText: () => "",
    now: () => NOW,
    ...over,
  };
}

describe("GET /byosub/health route glue", () => {
  it("limits broker and filesystem checks for repeated health polling", async () => {
    const resolveUserGateway = vi.fn(async () => null);
    const client = request(appWith(fakeDeps({ resolveUserGateway })));
    for (let attempt = 0; attempt < 120; attempt++) await client.get(healthPath()).expect(422);
    const limited = await client.get(healthPath()).expect(429);
    expect(limited.body).toEqual({ error: "Too many requests, please try again later." });
    expect(resolveUserGateway).toHaveBeenCalledTimes(120);
  });

  it("200 not_on_this_pod on the unscoped alias — no gateway-local proof without /api/g/<gatewayId>", async () => {
    const resolve = vi.fn(async () => ({
      slug: "smile-wring-011b",
      gatewayId: "default",
      refProvider: "openai" as const,
    }));
    const res = await request(appWith(fakeDeps({ resolveUserGateway: resolve }))).get(
      "/probe/byosub/health",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, status: "not_on_this_pod" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("200 not_on_this_pod when the scoped path reached a different gateway pod — no fs reads", async () => {
    const resolve = vi.fn(async () => ({
      slug: "smile-wring-011b",
      gatewayId: "operator-1",
      refProvider: "openai" as const,
    }));
    const mountRead = vi.fn(() => true);
    const storeRead = vi.fn(() => true);
    const stateRead = vi.fn(() => "");
    const res = await request(
      appWith(
        fakeDeps({
          resolveUserGateway: resolve,
          localGatewayId: () => "default",
          isMounted: mountRead,
          readStorePresent: storeRead,
          readAuthStateText: stateRead,
        }),
      ),
    ).get(healthPath("operator-1"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, status: "not_on_this_pod" });
    expect(resolve).not.toHaveBeenCalled();
    expect(mountRead).not.toHaveBeenCalled();
    expect(storeRead).not.toHaveBeenCalled();
    expect(stateRead).not.toHaveBeenCalled();
  });

  it("200 not_on_this_pod when the user is no longer assigned to the requested gateway — no fs reads", async () => {
    const mountRead = vi.fn(() => true);
    const storeRead = vi.fn(() => true);
    const stateRead = vi.fn(() => "");
    const res = await request(
      appWith(
        fakeDeps({
          resolveUserGateway: async () => ({
            slug: "smile-wring-011b",
            gatewayId: "default",
            refProvider: "openai",
          }),
          localGatewayId: () => "operator-1",
          isMounted: mountRead,
          readStorePresent: storeRead,
          readAuthStateText: stateRead,
        }),
      ),
    ).get(healthPath("operator-1"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, status: "not_on_this_pod" });
    expect(mountRead).not.toHaveBeenCalled();
    expect(storeRead).not.toHaveBeenCalled();
    expect(stateRead).not.toHaveBeenCalled();
  });

  it("422 not_provisioned when the user has no resolved gateway", async () => {
    const res = await request(appWith(fakeDeps({ resolveUserGateway: async () => null }))).get(
      healthPath(),
    );
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ connected: false, status: "not_provisioned" });
  });

  it("200 missing — ref present but the pod store didn't materialize (the durability regression)", async () => {
    const res = await request(appWith(fakeDeps({ readStorePresent: () => false }))).get(
      healthPath(),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, status: "missing", provider: "openai" });
  });

  it("200 healthy — mounted, ref present, store present, clean auth-state", async () => {
    const res = await request(appWith(fakeDeps())).get(healthPath());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true, status: "healthy", provider: "openai" });
  });

  it("checks for the OpenAI Codex profile specifically, not just any auth-profile store", async () => {
    const seen: Array<{ agentId: string; profileId?: string }> = [];
    const res = await request(
      appWith(
        fakeDeps({
          readStorePresent: (agentId, profileId) => {
            seen.push({ agentId, profileId });
            return profileId === PROFILE;
          },
        }),
      ),
    ).get(healthPath());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true, status: "healthy", provider: "openai" });
    expect(seen).toEqual([{ agentId: "octogee-smile-wring-011b-coach", profileId: PROFILE }]);
  });

  it("checks for the Claude CLI profile when the byosub ref is Anthropic", async () => {
    const seen: Array<{ agentId: string; profileId?: string }> = [];
    const res = await request(
      appWith(
        fakeDeps({
          resolveUserGateway: async () => ({
            slug: "smile-wring-011b",
            gatewayId: "default",
            refProvider: "anthropic",
          }),
          readStorePresent: (agentId, profileId) => {
            seen.push({ agentId, profileId });
            return profileId === CLAUDE_PROFILE;
          },
        }),
      ),
    ).get(healthPath());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true, status: "healthy", provider: "anthropic" });
    expect(seen).toEqual([{ agentId: "octogee-smile-wring-011b-coach", profileId: CLAUDE_PROFILE }]);
  });

  it("200 needs_reauth — Anthropic profile exists but its stored expiry is in the past", async () => {
    const res = await request(
      appWith(
        fakeDeps({
          resolveUserGateway: async () => ({
            slug: "smile-wring-011b",
            gatewayId: "default",
            refProvider: "anthropic",
          }),
          readProfileExpiresAt: () => NOW - 1,
        }),
      ),
    ).get(healthPath());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, status: "needs_reauth", provider: "anthropic" });
  });

  it("does not use profile expiry as a Codex reauth signal", async () => {
    const expiryRead = vi.fn(() => NOW - 1);
    const res = await request(
      appWith(
        fakeDeps({
          readProfileExpiresAt: expiryRead,
        }),
      ),
    ).get(healthPath());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true, status: "healthy", provider: "openai" });
    expect(expiryRead).not.toHaveBeenCalled();
  });

  it("422 + NO filesystem read when the resolved slug would build a path-unsafe agent id (traversal guard)", async () => {
    // primaryWorkspaceSlug can fall back to the client-writable `username`; this
    // route feeds the derived agent id into filesystem paths (codexAgentDir /
    // CUSTOMERS_DIR), so a slug like "../../etc" must be rejected BEFORE any fs
    // access — the existing /connection route only used the id as a Firestore map
    // key, where traversal is harmless.
    const storeRead = vi.fn(() => true);
    const stateRead = vi.fn(() => "");
    const mountRead = vi.fn(() => true);
    const res = await request(
      appWith(
        fakeDeps({
          resolveUserGateway: async () => ({
            slug: "../../etc",
            gatewayId: "default",
            refProvider: "openai",
          }),
          isMounted: mountRead,
          readStorePresent: storeRead,
          readAuthStateText: stateRead,
        }),
      ),
    ).get(healthPath());
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ connected: false, status: "not_provisioned" });
    expect(mountRead).not.toHaveBeenCalled();
    expect(storeRead).not.toHaveBeenCalled();
    expect(stateRead).not.toHaveBeenCalled();
  });

  it("passes the authenticated user id through to the central assignment broker", async () => {
    let seen: string | null = null;
    await request(
      appWith(
        fakeDeps({
          resolveUserGateway: async (uid) => {
            seen = uid;
            return {
              slug: "smile-wring-011b",
              gatewayId: "operator-1",
              refProvider: "openai",
            };
          },
          localGatewayId: () => "operator-1",
        }),
      ),
    ).get(healthPath("operator-1"));
    expect(seen).toBe("uid-1");
  });
});
