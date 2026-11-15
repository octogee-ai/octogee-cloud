import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TENANT_BINDING_AUDIENCE,
  createKubernetesTokenReviewer,
  type TokenReviewHttpRequest,
} from "../token-review.js";

const tempDirs: string[] = [];

async function tempFile(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-review-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  await writeFile(file, body);
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function authenticatedBody(
  saName = "octogee-gw-walter",
  audiences: string[] = [TENANT_BINDING_AUDIENCE],
) {
  return {
    status: {
      authenticated: true,
      audiences,
      user: {
        username: `system:serviceaccount:octogee:${saName}`,
        extra: {
          "authentication.kubernetes.io/pod-name": ["octogee-gateway-walter-r7-5bc5949d46-p946t"],
          "authentication.kubernetes.io/pod-uid": ["b0de5f4c-2d38-4dc9-9bb7-3f20a0d7beef"],
        },
      },
    },
  };
}

describe("createKubernetesTokenReviewer", () => {
  it("submits TokenReview with octogee-api audience and parses the verified pod identity", async () => {
    const reviewerTokenPath = await tempFile("reviewer-token", "reviewer-jwt\n");
    const caPath = await tempFile("ca.crt", "ca-data");
    const calls: TokenReviewHttpRequest[] = [];
    const reviewer = createKubernetesTokenReviewer({
      apiHost: "kubernetes.local",
      apiPort: "6443",
      reviewerTokenPath,
      caPath,
      transport: async (req) => {
        calls.push(req);
        return { status: 201, body: authenticatedBody() };
      },
    });

    await expect(reviewer("caller-jwt")).resolves.toEqual({
      authenticated: true,
      namespace: "octogee",
      saName: "octogee-gw-walter",
      audiences: [TENANT_BINDING_AUDIENCE],
      podName: "octogee-gateway-walter-r7-5bc5949d46-p946t",
      podUid: "b0de5f4c-2d38-4dc9-9bb7-3f20a0d7beef",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://kubernetes.local:6443/apis/authentication.k8s.io/v1/tokenreviews",
    );
    expect(calls[0].bearerToken).toBe("reviewer-jwt");
    expect(calls[0].ca).toBe("ca-data");
    expect(calls[0].body).toMatchObject({
      spec: { token: "caller-jwt", audiences: [TENANT_BINDING_AUDIENCE] },
    });
  });

  it("rejects unauthenticated, malformed, or wrong-audience TokenReview responses", async () => {
    const reviewerTokenPath = await tempFile("reviewer-token", "reviewer-jwt");
    const caPath = await tempFile("ca.crt", "ca-data");
    const bodies = [
      { status: { authenticated: false } },
      authenticatedBody("octogee-gw-walter", ["wrong-audience"]),
      { status: { authenticated: true, audiences: [TENANT_BINDING_AUDIENCE], user: {} } },
    ];
    const reviewer = createKubernetesTokenReviewer({
      reviewerTokenPath,
      caPath,
      transport: async () => ({ status: 200, body: bodies.shift() }),
    });

    await expect(reviewer("one")).resolves.toEqual({ authenticated: false });
    await expect(reviewer("two")).resolves.toEqual({ authenticated: false });
    await expect(reviewer("three")).resolves.toEqual({ authenticated: false });
  });

  it("does not treat malformed private pod claims as a pod identity", async () => {
    const reviewerTokenPath = await tempFile("reviewer-token", "reviewer-jwt");
    const caPath = await tempFile("ca.crt", "ca-data");
    const reviewer = createKubernetesTokenReviewer({
      reviewerTokenPath,
      caPath,
      transport: async () => ({
        status: 200,
        body: {
          status: {
            authenticated: true,
            audiences: [TENANT_BINDING_AUDIENCE],
            user: {
              username: "system:serviceaccount:octogee:octogee-gw-walter",
              extra: {
                "authentication.kubernetes.io/pod-name": ["one", "two"],
                "authentication.kubernetes.io/pod-uid": "not-an-array",
              },
            },
          },
        },
      }),
    });

    await expect(reviewer("caller-jwt")).resolves.toEqual({
      authenticated: true,
      namespace: "octogee",
      saName: "octogee-gw-walter",
      audiences: [TENANT_BINDING_AUDIENCE],
    });
  });

  it("throws on TokenReview HTTP errors", async () => {
    const reviewerTokenPath = await tempFile("reviewer-token", "reviewer-jwt");
    const caPath = await tempFile("ca.crt", "ca-data");
    const reviewer = createKubernetesTokenReviewer({
      reviewerTokenPath,
      caPath,
      transport: async () => ({ status: 503, body: {} }),
    });

    await expect(reviewer("caller-jwt")).rejects.toThrow("TokenReview HTTP 503");
  });

  it("caches successful token reviews for the configured TTL", async () => {
    const reviewerTokenPath = await tempFile("reviewer-token", "reviewer-jwt");
    const caPath = await tempFile("ca.crt", "ca-data");
    let now = 1_000;
    let transportCalls = 0;
    const reviewer = createKubernetesTokenReviewer({
      reviewerTokenPath,
      caPath,
      now: () => now,
      cacheTtlMs: 10_000,
      transport: async () => {
        transportCalls += 1;
        return { status: 200, body: authenticatedBody() };
      },
    });

    await reviewer("caller-jwt");
    await reviewer("caller-jwt");
    now += 11_000;
    await reviewer("caller-jwt");

    expect(transportCalls).toBe(2);
  });

  it("re-reviews a cached success when asked for a fresh review and drops the stale entry", async () => {
    const reviewerTokenPath = await tempFile("reviewer-token", "reviewer-jwt");
    const caPath = await tempFile("ca.crt", "ca-data");
    let podDeleted = false;
    let transportCalls = 0;
    const reviewer = createKubernetesTokenReviewer({
      reviewerTokenPath,
      caPath,
      now: () => 1_000,
      cacheTtlMs: 30_000,
      transport: async () => {
        transportCalls += 1;
        return {
          status: 201,
          body: podDeleted ? { status: { authenticated: false } } : authenticatedBody(),
        };
      },
    });

    await expect(reviewer("caller-jwt")).resolves.toMatchObject({ authenticated: true });
    podDeleted = true;
    await expect(reviewer("caller-jwt")).resolves.toMatchObject({ authenticated: true });
    await expect(reviewer("caller-jwt", { fresh: true })).resolves.toEqual({ authenticated: false });
    await expect(reviewer("caller-jwt")).resolves.toEqual({ authenticated: false });

    expect(transportCalls).toBe(3);
  });
});
