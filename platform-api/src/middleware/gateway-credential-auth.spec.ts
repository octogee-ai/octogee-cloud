import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import {
  GATEWAY_CREDENTIAL_TOKEN_AUDIENCE,
  GATEWAY_CREDENTIAL_TOKEN_HEADER,
  SIDECAR_BROKER_TOKEN_AUDIENCE,
  SIDECAR_BROKER_TOKEN_HEADER,
} from "@octogee/core/internal-fetch";
import type { BoundTenant } from "../lib/sa-to-tenant.js";
import type { Reviewer } from "../lib/token-review.js";
import { createGatewayCredentialAuth } from "./gateway-credential-auth.js";

const JWT = `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
const BOUND: BoundTenant = {
  kind: "gateway",
  gatewayId: "shared-blue",
  saName: "octogee-gw-shared-blue",
  podName: "octogee-gateway-shared-blue-abc123",
  podUid: "pod-uid-1",
};

function appWith(
  reviewer: Reviewer,
  mapped: BoundTenant | null = { kind: "gateway", gatewayId: "shared-blue" },
  bound: BoundTenant = BOUND,
  credentialOptions: { tokenHeader?: string; audience?: string } = {},
) {
  const app = express();
  app.use((req, _res, next) => {
    req.boundTenant = bound;
    next();
  });
  app.use(createGatewayCredentialAuth({
    reviewer,
    namespace: "octogee",
    mapIdentity: async () => mapped,
    logger: { warn: vi.fn() },
    ...credentialOptions,
  }));
  app.post("/secret", (_req, res) => res.status(204).end());
  return app;
}

function validReview(): Awaited<ReturnType<Reviewer>> {
  return {
    authenticated: true,
    saName: "octogee-gw-shared-blue",
    namespace: "octogee",
    audiences: [GATEWAY_CREDENTIAL_TOKEN_AUDIENCE],
    podName: "octogee-gateway-shared-blue-abc123",
    podUid: "pod-uid-1",
  };
}

describe("gateway credential capability", () => {
  it("requires the purpose-audience token in addition to the normal tenant binding", async () => {
    const reviewer = vi.fn<Reviewer>();
    const res = await request(appWith(reviewer)).post("/secret");

    expect(res.status).toBe(403);
    expect(reviewer).not.toHaveBeenCalled();
  });

  it("accepts the exact gateway and pod bound to the credential token", async () => {
    const reviewer = vi.fn<Reviewer>().mockResolvedValue(validReview());
    const res = await request(appWith(reviewer))
      .post("/secret")
      .set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT);

    expect(res.status).toBe(204);
    expect(reviewer).toHaveBeenCalledWith(JWT);
  });

  it("accepts a projected sidecar capability only for its separate header and audience", async () => {
    const review = { ...validReview(), audiences: [SIDECAR_BROKER_TOKEN_AUDIENCE] };
    const res = await request(appWith(
      vi.fn<Reviewer>().mockResolvedValue(review),
      undefined,
      undefined,
      {
        tokenHeader: SIDECAR_BROKER_TOKEN_HEADER,
        audience: SIDECAR_BROKER_TOKEN_AUDIENCE,
      },
    ))
      .post("/secret")
      .set(SIDECAR_BROKER_TOKEN_HEADER, JWT);

    expect(res.status).toBe(204);
  });

  it.each([
    ["different audience", { ...validReview(), audiences: ["octogee-api"] }],
    ["different service account", { ...validReview(), saName: "octogee-gw-shared-blue-alt" }],
    ["different pod", { ...validReview(), podUid: "pod-uid-attacker" }],
    ["missing pod binding", { ...validReview(), podName: undefined, podUid: undefined }],
  ])("rejects a token with %s", async (_label, reviewed) => {
    const res = await request(appWith(vi.fn<Reviewer>().mockResolvedValue(reviewed)))
      .post("/secret")
      .set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT);

    expect(res.status).toBe(403);
  });

  it("rejects a credential identity mapped to another gateway", async () => {
    const res = await request(appWith(
      vi.fn<Reviewer>().mockResolvedValue(validReview()),
      { kind: "gateway", gatewayId: "other-gateway" },
    ))
      .post("/secret")
      .set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT);

    expect(res.status).toBe(403);
  });
});
