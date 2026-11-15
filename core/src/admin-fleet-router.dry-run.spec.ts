import request from "supertest";
import type { Router } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FLEET,
  MANIFEST,
  SOURCE_SHA,
  VM_RUNTIME,
  gatewayRoot,
  harness,
  operation,
  placedUser,
  restoreRecoveryFleet,
  send,
  servingSharedGateway,
  sourceRecoveryFleet,
  type ChangingRequest,
  type Seed,
} from "./testing/admin-dry-run-app.js";
import { FIXTURE_SIZING_PROFILES } from "./testing/journal-store.js";

function unisolatedUserFleet(): Seed {
  return {
    "config/orchestrator": { defaultGatewayId: "shared-a", sharedGatewayIds: ["shared-a"], sizingProfiles: FIXTURE_SIZING_PROFILES },
    ...servingSharedGateway("shared-a"),
    ...placedUser("uid-lin", "lin", "shared-a"),
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("a dry run of a changing request", () => {
  it("plans a gateway restart with the state the journal would record", async () => {
    const h = harness();
    const before = h.snapshot();

    const res = await send(h.app, { method: "post", path: "/gateways/shared-b/restart" }, true).expect(200);

    expect(res.body).toEqual({
      dryRun: true,
      plans: [{
        what: "restart gateway",
        why: "Admin fleet request",
        kind: "restart-gateway",
        target: { gatewayId: "shared-b" },
        preActionStatus: { desiredStatus: "running", desiredRelease: 1 },
        mutation: { kind: "restart-gateway", gatewayId: "shared-b" },
        forced: false,
      }],
    });
    expect(h.snapshot()).toBe(before);
  });

  it("plans a deploy against the resolved build manifest", async () => {
    const h = harness();
    const before = h.snapshot();

    const res = await send(h.app, { method: "post", path: "/gateways/iso-ada/deploy", body: { sourceSha: SOURCE_SHA } }, true).expect(200);

    expect(res.body.plans).toEqual([expect.objectContaining({
      what: "deploy build to gateway",
      kind: "deploy-gateway-build",
      target: { gatewayId: "iso-ada" },
      preActionStatus: { desiredStatus: "running", desiredRelease: 2, latestRelease: 2 },
      mutation: { kind: "deploy-gateway-build", gatewayId: "iso-ada", sourceSha: SOURCE_SHA, manifestDigest: MANIFEST.manifestDigest },
      forced: false,
    })]);
    expect(h.snapshot()).toBe(before);
  });

  it("plans a retirement with the retention flags it was asked for", async () => {
    const h = harness();
    const before = h.snapshot();

    const res = await send(h.app, { method: "delete", path: "/gateways/idle?retainData=true" }, true).expect(200);

    expect(res.body.plans).toEqual([expect.objectContaining({
      what: "retire gateway",
      kind: "retire-gateway",
      target: { gatewayId: "idle" },
      preActionStatus: { desiredStatus: "running", desiredRelease: 1 },
      mutation: { kind: "retire-gateway", gatewayId: "idle", retainData: true },
    })]);
    expect(h.snapshot()).toBe(before);
  });

  it("plans a user migration from the user's current gateway", async () => {
    const h = harness();
    const before = h.snapshot();

    const res = await send(h.app, { method: "post", path: "/users/uid-ada/migrate", body: { to: "shared-b" } }, true).expect(200);

    expect(res.body.plans).toEqual([expect.objectContaining({
      what: "migrate user",
      target: { uid: "uid-ada", gatewayId: "shared-b" },
      preActionStatus: { gatewayId: "shared-a" },
      mutation: expect.objectContaining({ uid: "uid-ada", fromGatewayId: "shared-a", toGatewayId: "shared-b" }),
    })]);
    expect(h.snapshot()).toBe(before);
  });

  it("says why a VM gateway cannot be restarted", async () => {
    const h = harness({ ...FLEET, ...VM_RUNTIME });

    const res = await send(h.app, { method: "post", path: "/gateways/iso-ada/restart" }, true).expect(409);

    expect(res.body).toEqual({
      code: "gateway-restart-unsupported-runtime",
      error: "gateway restart works on a pod gateway only; iso-ada runs on a VM, which has no restart path",
      gatewayId: "iso-ada",
      runtime: "gce-vm",
    });
  });

  it("still restarts an isolated gateway that runs as a pod", async () => {
    const h = harness();

    const dry = await send(h.app, { method: "post", path: "/gateways/iso-ada/restart" }, true);
    const real = await send(h.app, { method: "post", path: "/gateways/iso-ada/restart" }, false);

    expect(dry.status).toBe(200);
    expect(real.status).toBe(202);
    expect(real.body).toMatchObject({ gatewayId: "iso-ada", operationId: expect.any(String) });
  });

  it("marks a forced request as forced", async () => {
    const h = harness();

    const res = await send(h.app, {
      method: "post",
      path: "/users/uid-ada/vm/replace",
      body: { force: true, acceptBootDataLoss: true },
    }, true).expect(200);

    expect(res.body.plans).toEqual([expect.objectContaining({ what: "replace VM", forced: true })]);
  });

  const busyGateway = operation("busy", { kind: "restart-gateway", status: "running", input: { gatewayId: "shared-b" } });
  const movingAda = operation("move-ada", {
    kind: "migrate-user", status: "pending", inputUid: "uid-ada", input: { uid: "uid-ada", toGatewayId: "shared-b" },
  });
  const sharedB = (overrides: Record<string, unknown>): Seed => ({
    "gateways/shared-b": gatewayRoot("shared-b", { liveRelease: 1, ...overrides }),
  });
  const claimedForRetirement = sharedB({
    retirementClaim: { operationId: "retire-1", version: 1, claimedAt: 1, phase: "claimed", liveRelease: 1, liveRuntimeIdentity: null, previousDesiredStatus: "running" },
  });
  const restartUnresolved = sharedB({ runtimeRestartFence: { attemptId: "restart-1" } });
  const parkSharedB: ChangingRequest = { method: "patch", path: "/gateways/shared-b", body: { desiredStatus: "paused" } };

  it.each<[string, number, ChangingRequest, Seed]>([
    ["restart of an unknown gateway", 404, { method: "post", path: "/gateways/nowhere/restart" }, FLEET],
    ["restart of a retired gateway", 409, { method: "post", path: "/gateways/gone/restart" }, FLEET],
    ["restart of a gateway that runs on a VM", 409, { method: "post", path: "/gateways/iso-ada/restart" }, { ...FLEET, ...VM_RUNTIME }],
    ["restart while an operation is in flight", 409, { method: "post", path: "/gateways/shared-b/restart" }, { ...FLEET, ...busyGateway }],
    ["deploy to an unknown gateway", 404, { method: "post", path: "/gateways/nowhere/deploy", body: { sourceSha: SOURCE_SHA } }, FLEET],
    ["deploy to a retired gateway", 409, { method: "post", path: "/gateways/gone/deploy", body: { sourceSha: SOURCE_SHA } }, FLEET],
    ["deploy to a shared gateway", 409, { method: "post", path: "/gateways/shared-b/deploy", body: { sourceSha: SOURCE_SHA } }, FLEET],
    [
      "shared gateway id the store would reject",
      400,
      { method: "post", path: "/gateways", body: { gatewayId: "fleet-live-teau", gatewayClass: "shared", sourceSha: SOURCE_SHA } },
      FLEET,
    ],
    ["retirement of an unknown gateway", 404, { method: "delete", path: "/gateways/nowhere" }, FLEET],
    ["retirement of a gateway with assigned users", 409, { method: "delete", path: "/gateways/shared-a" }, FLEET],
    ["migration to an unregistered gateway", 404, { method: "post", path: "/users/uid-ada/migrate", body: { to: "nowhere" } }, FLEET],
    ["migration to the user's current gateway", 409, { method: "post", path: "/users/uid-ada/migrate", body: { to: "shared-a" } }, FLEET],
    ["migration while another is in flight", 409, { method: "post", path: "/users/uid-ada/migrate", body: { to: "shared-b" } }, { ...FLEET, ...movingAda }],
    ["update of a gateway claimed for retirement", 409, parkSharedB, { ...FLEET, ...claimedForRetirement }],
    ["update of a gateway a user is moving to", 409, parkSharedB, { ...FLEET, ...movingAda }],
    ["update of a gateway whose restart outcome is unresolved", 409, parkSharedB, { ...FLEET, ...restartUnresolved }],
  ])("refuses a %s exactly as the real request does", async (_label, status, call, seed) => {
    const h = harness(seed);
    const before = h.snapshot();

    const dry = await send(h.app, call, true);
    expect(h.snapshot()).toBe(before);
    const real = await send(h.app, call, false);

    expect(dry.status).toBe(status);
    expect(real.status).toBe(status);
    expect(dry.body).toEqual(real.body);
  });

  it("leaves the Idempotency-Key unused for the real request", async () => {
    const h = harness();
    const restart = (target: string) => request(h.app).post(target).set("Idempotency-Key", "restart-once");

    const dry = await restart("/gateways/shared-b/restart?dryRun=true");
    const real = await restart("/gateways/shared-b/restart");
    const repeated = await restart("/gateways/shared-b/restart");

    expect([dry.status, real.status, repeated.status]).toEqual([200, 202, 409]);
  });

  it("refuses a marker that is neither true nor false instead of applying the change", async () => {
    const h = harness();
    const before = h.snapshot();

    const res = await request(h.app).post("/gateways/shared-b/restart?dryRun=yes").expect(400);

    expect(res.body.error).toBe("dryRun must be true or false");
    expect(h.snapshot()).toBe(before);
  });

  it("applies the change when the marker is false", async () => {
    const h = harness();
    const before = h.snapshot();

    const res = await request(h.app).post("/gateways/shared-b/restart?dryRun=false").expect(202);

    expect(res.body).toMatchObject({ gatewayId: "shared-b", operationId: expect.any(String) });
    expect(h.snapshot()).not.toBe(before);
  });

  it("advertises dry-run support on every response so a client can require it first", async () => {
    const h = harness();

    const read = await request(h.app).get("/operations").expect(200);
    const refused = await request(h.app).post("/gateways/nowhere/restart").expect(404);

    expect(read.headers["admin-api-capabilities"]).toBe("dry-run");
    expect(refused.headers["admin-api-capabilities"]).toBe("dry-run");
  });
});

describe("every changing route", () => {
  const routes: Record<string, ChangingRequest & { seed?: () => Seed }> = {
    "POST /rollouts": { method: "post", path: "/rollouts", body: { gatewayId: "shared-b", targetRelease: 2, imageTag: "abc1234" } },
    "POST /gateways": {
      method: "post",
      path: "/gateways",
      body: { gatewayId: "shared-c", sourceSha: SOURCE_SHA, gatewayClass: "shared" },
    },
    "PATCH /gateways/:id": { method: "patch", path: "/gateways/shared-b", body: { desiredStatus: "paused" } },
    "DELETE /gateways/:id": { method: "delete", path: "/gateways/idle" },
    "POST /gateways/:id/restart": { method: "post", path: "/gateways/shared-b/restart" },
    "POST /gateways/:id/deploy": { method: "post", path: "/gateways/iso-ada/deploy", body: { sourceSha: SOURCE_SHA } },
    "POST /gateways/:id/releases/:n/rollback": { method: "post", path: "/gateways/iso-ada/releases/1/rollback", body: {} },
    "POST /gateways/:id/recover-source": {
      method: "post", path: "/gateways/shared-0/recover-source", body: { sourceSha: SOURCE_SHA }, seed: sourceRecoveryFleet,
    },
    "POST /gateways/:id/recover-restore": {
      method: "post",
      path: "/gateways/shared-0/recover-restore",
      body: { sourceSha: SOURCE_SHA, operationId: "return-1", reauthorizeAttemptId: "retained-1" },
      seed: restoreRecoveryFleet,
    },
    "POST /gateways/:id/vm/replace": { method: "post", path: "/gateways/iso-ada/vm/replace", body: {} },
    "POST /users": { method: "post", path: "/users", body: { name: "lin", email: "lin@example.com" } },
    "POST /users/:uid/one-time-passwords": { method: "post", path: "/users/uid-ada/one-time-passwords" },
    "POST /users/:uid/delete": { method: "post", path: "/users/uid-ada/delete", body: { eraseNow: false } },
    "POST /users/:uid/assign": {
      method: "post", path: "/users/uid-bo/assign", body: { gatewayId: "shared-b" },
      seed: () => ({ ...FLEET, "users/uid-bo": { username: "bo", onboardingStep: "complete", provisioning: { status: "complete", openclaw: { slug: "bo" } } } }),
    },
    "POST /users/:uid/isolated-gateway": {
      method: "post", path: "/users/uid-lin/isolated-gateway", body: { sizingProfile: "hobby" }, seed: unisolatedUserFleet,
    },
    "POST /users/:uid/migrate": { method: "post", path: "/users/uid-ada/migrate", body: { to: "shared-b" } },
    "POST /users/:uid/unassign": { method: "post", path: "/users/uid-ada/unassign" },
    "PATCH /users/:uid/placement": { method: "patch", path: "/users/uid-ada/placement", body: { managedBy: "operator", gatewayId: null } },
    "POST /users/:uid/vm/replace": { method: "post", path: "/users/uid-ada/vm/replace", body: {} },
    "POST /shared-gateways": {
      method: "post",
      path: "/shared-gateways",
      body: { gatewayId: "shared-cccccccccccc", reason: "scale-out", automationState: { expectedSequence: null, replacements: [] } },
    },
    "POST /shared-gateways/:id/desired-status": {
      method: "post",
      path: "/shared-gateways/shared-b/desired-status",
      body: { decision: "begin-drain", expectedUpdatedAt: 1, automationState: { expectedSequence: null, replacements: [] } },
    },
    "POST /shared-gateways/:id/retire": {
      method: "post",
      path: "/shared-gateways/shared-b/retire",
      body: { expectedAutomationSequence: null, expectedUpdatedAt: 1 },
    },
    "POST /shared-gateways/replacements/:sourceGatewayId/finish": {
      method: "post",
      path: "/shared-gateways/replacements/shared-a/finish",
      body: { departedGatewayId: "shared-a", expectedAutomationSequence: 1 },
    },
    "POST /shared-gateways/:id/add-operations/:operationId/complete": {
      method: "post",
      path: "/shared-gateways/shared-b/add-operations/op-1/complete",
    },
  };

  function changingRoutes(router: Router): string[] {
    return router.stack.flatMap((layer) => {
      const route = layer.route as { path: string; methods: Record<string, boolean> } | undefined;
      const mounted = (layer.handle as { stack?: Router["stack"] }).stack;
      if (!route) return mounted ? changingRoutes({ stack: mounted } as Router) : [];
      return Object.keys(route.methods)
        .filter((method) => method !== "get")
        .map((method) => `${method.toUpperCase()} ${route.path}`);
    });
  }

  it("is listed here, so a new changing route cannot skip the dry run", () => {
    expect(changingRoutes(harness().router).sort()).toEqual(Object.keys(routes).sort());
  });

  it("has no lease routes and no idle setting: those are the product's to mount", async () => {
    const h = harness();

    expect((await request(h.app).get("/platform-runtime-config")).status).toBe(404);
    expect((await request(h.app).post("/users/uid-ada/activation-lease")).status).toBe(404);
    expect((await request(h.app).patch("/platform-runtime-config").send({ disposableGatewayIdleMs: 60_000 })).status).toBe(404);
  });

  it("has no shared gateway autoscaling setting and no bulk move: those are the product's to mount", async () => {
    const h = harness();

    expect((await request(h.app).patch("/placement/autoscaling").send({ enabled: true, usersPerGateway: 40 })).status).toBe(404);
    expect((await request(h.app).post("/gateway-migrations/bulk").send({ userIds: ["uid-ada"], toGatewayId: "shared-b" })).status).toBe(404);
  });

  it.each(Object.entries(routes))("%s answers a dry run with a plan and writes nothing", async (_route, call) => {
    vi.stubEnv("GATEWAY_SERVICE_ACCOUNT", "gateway@example.iam.gserviceaccount.com");
    const h = harness(call.seed?.() ?? FLEET);
    const before = h.snapshot();

    const res = await send(h.app, call, true);

    expect(res.body).toMatchObject({ dryRun: true, plans: [{ what: expect.any(String), forced: false }] });
    expect(res.status).toBe(200);
    expect(h.snapshot()).toBe(before);
    for (const effect of Object.values(h.effects)) expect(effect).not.toHaveBeenCalled();
  });

  it("refuses a dry run of a changing route that does not plan, instead of letting it apply", async () => {
    const h = harness();
    const applied = vi.fn();
    h.router.post("/later-changing-route", (_req, res) => {
      applied();
      res.status(202).json({ applied: true });
    });

    const res = await request(h.app).post("/later-changing-route?dryRun=true").expect(400);

    expect(res.body.error).toBe("this route does not answer dry runs");
    expect(applied).not.toHaveBeenCalled();
    await request(h.app).post("/later-changing-route").expect(202);
  });
});
