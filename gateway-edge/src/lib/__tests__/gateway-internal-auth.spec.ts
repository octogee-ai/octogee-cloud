import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createGatewayInternalAuthReviewer,
  isValidGatewayInternalAuth,
  resolveGatewayInternalAuthSecret,
} from "../gateway-internal-auth.js";
import type { Reviewer } from "../kubernetes-token-review.js";

async function withTokenFile<T>(body: string, fn: (tokenPath: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gateway-internal-auth-"));
  try {
    const tokenPath = path.join(dir, "token");
    writeFileSync(tokenPath, body);
    return await fn(tokenPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("gateway internal auth", () => {
  it("uses INTERNAL_SERVICE_KEY when present", () => {
    expect(
      resolveGatewayInternalAuthSecret({
        INTERNAL_SERVICE_KEY: "platform-key",
        GATEWAY_PROFILE: "isolated",
      }),
    ).toEqual({
      value: "platform-key",
      mode: "platform",
      headerName: "x-internal-service-key",
    });
  });

  it("uses a isolated gateway projected service-account token when the platform key is absent", async () => {
    await withTokenFile("projected-sa-token\n", (tokenPath) => {
      expect(
        resolveGatewayInternalAuthSecret({
          GATEWAY_CLASS: "isolated",
          GATEWAY_PROFILE: "isolated",
          OCTOGEE_API_SA_TOKEN_PATH: tokenPath,
        }),
      ).toEqual({
        value: "projected-sa-token",
        mode: "gateway-service-account",
        headerName: "x-k8s-sa-token",
      });
    });
  });

  it.each([["builder", "isolated"], ["isolated", "builder"], ["isolated", "isolated"]])(
    "uses the projected token when the class is %s and the profile is %s",
    async (gatewayClass, gatewayProfile) => {
      await withTokenFile("projected-sa-token\n", (tokenPath) => {
        expect(resolveGatewayInternalAuthSecret({
          GATEWAY_CLASS: gatewayClass,
          GATEWAY_PROFILE: gatewayProfile,
          OCTOGEE_API_SA_TOKEN_PATH: tokenPath,
        })).toMatchObject({ mode: "gateway-service-account" });
      });
    },
  );

  it("does not use a projected token for an unknown class", async () => {
    await withTokenFile("projected-sa-token\n", (tokenPath) => {
      expect(resolveGatewayInternalAuthSecret({
        GATEWAY_CLASS: "operator",
        GATEWAY_PROFILE: "isolated",
        OCTOGEE_API_SA_TOKEN_PATH: tokenPath,
      })).toBeNull();
    });
  });

  it("does not use a projected token outside the isolated runtime", async () => {
    await withTokenFile("projected-sa-token\n", (tokenPath) => {
      expect(
        resolveGatewayInternalAuthSecret({
          GATEWAY_CLASS: "shared",
          GATEWAY_PROFILE: "standard",
          OCTOGEE_API_SA_TOKEN_PATH: tokenPath,
        }),
      ).toBeNull();
    });
  });

  it("compares a platform key exactly", async () => {
    const env = { INTERNAL_SERVICE_KEY: "platform-key", GATEWAY_PROFILE: "standard" };
    await expect(isValidGatewayInternalAuth("platform-key", env)).resolves.toBe(true);
    await expect(isValidGatewayInternalAuth("wrong-token", env)).resolves.toBe(false);
  });

  it("validates a projected service-account caller through TokenReview", async () => {
    const reviewer: Reviewer = async (jwt) => jwt === "caller-jwt"
      ? {
          authenticated: true,
          namespace: "octogee-test",
          saName: "octogee-gw-walter",
          audiences: ["octogee-api"],
        }
      : { authenticated: false };
    await withTokenFile("projected-sa-token\n", async (tokenPath) => {
      const env = {
        GATEWAY_CLASS: "isolated",
        GATEWAY_PROFILE: "isolated",
        GATEWAY_ID: "walter",
        K8S_NAMESPACE: "octogee-test",
        OCTOGEE_API_SA_TOKEN_PATH: tokenPath,
      };
      await expect(isValidGatewayInternalAuth("caller-jwt", env, { reviewer })).resolves.toBe(true);
      await expect(isValidGatewayInternalAuth("wrong-token", env, { reviewer })).resolves.toBe(false);
    });
  });
});

describe("gateway internal auth on a gateway VM", () => {
  const vmEmail = "octogee-computer-test@octogee.iam.gserviceaccount.com";
  const googlePayload = (overrides: Record<string, unknown> = {}) => ({
    iss: "https://accounts.google.com",
    aud: "octogee-api",
    email: vmEmail,
    email_verified: true,
    google: {
      compute_engine: {
        project_id: "octogee",
        zone: "us-central1-a",
        instance_id: "5114356976453632468",
        instance_name: "octogee-pool-9a6a3a45",
      },
    },
    ...overrides,
  });
  const googleJwt = (() => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${enc({ alg: "RS256" })}.${enc(googlePayload())}.sig`;
  })();
  const env = {
    GATEWAY_CLASS: "isolated",
    GATEWAY_PROFILE: "isolated",
    GATEWAY_ID: "walter",
    K8S_NAMESPACE: "octogee-test",
    GATEWAY_COMPUTER_SERVICE_ACCOUNT_EMAIL: vmEmail,
    GATEWAY_COMPUTER_PROJECT_ID: "octogee",
    GATEWAY_COMPUTER_INSTANCE_ID: "5114356976453632468",
  };
  const kubernetes: Reviewer = async (jwt) => jwt === "k8s-caller-jwt"
    ? { authenticated: true, namespace: "octogee-test", saName: "octogee-gw-walter", audiences: ["octogee-api"] }
    : { authenticated: false };

  it("accepts the VM's Google identity token as the gateway service-account credential", async () => {
    const reviewer = createGatewayInternalAuthReviewer(env, { kubernetes, verify: async () => googlePayload(), onVmTokenRejected: () => {} });
    await withTokenFile("projected-sa-token\n", async (tokenPath) => {
      const fullEnv = { ...env, OCTOGEE_API_SA_TOKEN_PATH: tokenPath };
      await expect(isValidGatewayInternalAuth(googleJwt, fullEnv, { reviewer })).resolves.toBe(true);
      await expect(isValidGatewayInternalAuth("k8s-caller-jwt", fullEnv, { reviewer })).resolves.toBe(true);
    });
  });

  it("rejects another service account's Google token and does not consult Google without VM identity", async () => {
    const rejected: string[] = [];
    const otherSa = createGatewayInternalAuthReviewer(env, {
      kubernetes,
      verify: async () => googlePayload({ email: "someone-else@octogee.iam.gserviceaccount.com" }),
      onVmTokenRejected: (reason) => rejected.push(reason),
    });
    const verify = vi.fn(async () => googlePayload());
    const noVm = createGatewayInternalAuthReviewer(
      { GATEWAY_CLASS: "isolated", GATEWAY_PROFILE: "isolated", GATEWAY_ID: "walter", K8S_NAMESPACE: "octogee-test" },
      { kubernetes, verify },
    );
    await withTokenFile("projected-sa-token\n", async (tokenPath) => {
      const fullEnv = { ...env, OCTOGEE_API_SA_TOKEN_PATH: tokenPath };
      await expect(isValidGatewayInternalAuth(googleJwt, fullEnv, { reviewer: otherSa })).resolves.toBe(false);
      await expect(isValidGatewayInternalAuth(googleJwt, fullEnv, { reviewer: noVm })).resolves.toBe(false);
    });
    expect(verify).not.toHaveBeenCalled();
    expect(rejected).toEqual(["token is not the VM service account on a Compute Engine instance in this project"]);
  });
});
