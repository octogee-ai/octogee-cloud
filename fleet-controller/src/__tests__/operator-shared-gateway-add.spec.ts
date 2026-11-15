import express, { Router } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAdminFleetRoutes, type FleetRouterDeps } from "@octogee/core/admin-fleet-router";
import {
  ReleaseDigestManifestNotFoundError,
  type CentralReleaseAuthority,
  type ReleaseDigestManifest,
} from "@octogee/core/artifact-registry";
import type { GatewayArtifact } from "@octogee/core/gateway-live-release";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { noUserAccounts } from "@octogee/core/user-account";
import { isReleasePayload, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { gatewayUpsertOptsFromRelease, type DurableGateway } from "../converge-gateway.js";

type Records = Map<string, Record<string, unknown>>;

const SOURCE_SHA = "a".repeat(40);
const MISMATCHED_SHA = "8".repeat(40);
const REGISTRY = "us-central1-docker.pkg.dev/octogee/octogee";

function build(sourceSha = SOURCE_SHA): ReleaseDigestManifest {
  return {
    sourceSha,
    manifestDigest: `sha256:${"b".repeat(64)}`,
    openclawVersion: "2026.11.3",
    openclawSourceSha: "f".repeat(40),
    repository: REGISTRY,
    surfaces: {
      gateway: {
        "octogee-gateway": `sha256:${"c".repeat(64)}`,
        "octogee-gateway-builder": `sha256:${"d".repeat(64)}`,
        "gateway-edge": `sha256:${"e".repeat(64)}`,
      },
      platform: {},
    },
  };
}

const PLATFORM_BUILD: GatewayArtifact = {
  imageRepository: `${REGISTRY}/octogee-gateway`,
  imageTag: `1234567-oc2026.11.3@sha256:${"1".repeat(64)}`,
  profileImages: {
    builder: {
      imageRepository: `${REGISTRY}/octogee-gateway-builder`,
      imageTag: `1234567-oc2026.11.3@sha256:${"2".repeat(64)}`,
    },
  },
  gatewayEdgeImage: {
    imageRepository: `${REGISTRY}/gateway-edge`,
    imageTag: `1234567@sha256:${"3".repeat(64)}`,
  },
};

function authority(manifests: Record<string, ReleaseDigestManifest>): CentralReleaseAuthority {
  return {
    resolveManifest: vi.fn(async (sourceSha: string) => {
      const manifest = manifests[sourceSha];
      if (manifest === undefined) throw new ReleaseDigestManifestNotFoundError(sourceSha);
      return manifest;
    }),
    aliasesFor: vi.fn(() => []),
    keepTagsFor: vi.fn(() => []),
    ensureAliases: vi.fn(async () => []),
  };
}

function adminApi(records: Records, overrides: Partial<FleetRouterDeps> = {}) {
  const router = Router();
  const provisionGatewayAuthSecret = vi.fn(async () => ({}));
  addAdminFleetRoutes(router, {
    accounts: noUserAccounts,
    store: createDocumentFixtureStore(records),
    logger: { info: vi.fn(), warn: vi.fn() },
    provisionGatewayAuthSecret,
    listGatewayBuilds: vi.fn(async () => []),
    releaseEnvironment: "test",
    releaseAuthority: authority({ [SOURCE_SHA]: build(), [MISMATCHED_SHA]: build() }),
    suspendAuthUser: vi.fn(async () => undefined),
    revokeConnectorGrantsForUser: vi.fn(async () => undefined),
    ...overrides,
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { uid: "operator-uid", isAdmin: true });
    next();
  });
  return { app: app.use(router), provisionGatewayAuthSecret };
}

function convergenceOf(records: Records, gatewayId: string) {
  const root = records.get(`gateways/${gatewayId}`) as unknown as DurableGateway;
  const release = records.get(`gateways/${gatewayId}/releases/${root.desiredRelease}`);
  const payload = release?.payload as ReleasePayload;
  expect(isReleasePayload(payload)).toBe(true);
  return gatewayUpsertOptsFromRelease({
    namespace: "fleet",
    gateway: root,
    artifact: payload,
    replicas: 1,
    chartPath: "/charts/octogee-gateway",
  });
}

function journalOf(records: Records, kind: string): Record<string, unknown>[] {
  return [...records.entries()]
    .filter(([path, data]) => path.startsWith("glmOperations/") && data.kind === kind)
    .map(([, data]) => data);
}

function sharedRoot(gatewayId: string): Record<string, unknown> {
  return {
    gatewayId, createdAt: 1, createdBy: "operator", updatedAt: 1, updatedBy: "operator",
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running", configSchemaVersion: 1,
    profile: null, gatewayClass: "shared", imageProfile: "standard", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: null, builderSlug: null, modelBrokerLimits: null,
  };
}

beforeEach(() => vi.stubEnv("GATEWAY_SERVICE_ACCOUNT", "gateway@fleet.example"));
afterEach(() => vi.unstubAllEnvs());

describe("an operator adds a shared gateway", () => {
  it("records the named build's gateway and gateway-edge images in a release convergence accepts", async () => {
    const records: Records = new Map();
    const { app } = adminApi(records);

    const res = await request(app)
      .post("/gateways")
      .send({ gatewayId: "shared-ops1", sourceSha: SOURCE_SHA })
      .expect(202);

    expect(res.body).toMatchObject({ gatewayId: "shared-ops1", sourceSha: SOURCE_SHA, release: 1 });
    expect(typeof res.body.operationId).toBe("string");
    const opts = convergenceOf(records, "shared-ops1");
    expect(opts).toMatchObject({
      gatewayId: "shared-ops1",
      imageRepository: `${REGISTRY}/octogee-gateway`,
      imageTag: `aaaaaaa-oc2026.11.3@sha256:${"c".repeat(64)}`,
      gatewayEdgeImageRepository: `${REGISTRY}/gateway-edge`,
      gatewayEdgeImageTag: `aaaaaaa-oc2026.11.3@sha256:${"e".repeat(64)}`,
    });
    expect(records.get("gateways/shared-ops1")).toMatchObject({ createdBy: "operator-uid", gatewayClass: "shared" });
  });

  it("uses the build the platform is running when no build is named", async () => {
    const records: Records = new Map();
    const { app } = adminApi(records, { platformArtifact: PLATFORM_BUILD });

    const res = await request(app).post("/gateways").send({ gatewayId: "shared-ops2" }).expect(202);

    expect(res.body).toMatchObject({ gatewayId: "shared-ops2", sourceSha: null, release: 1 });
    expect(convergenceOf(records, "shared-ops2")).toMatchObject({
      imageTag: PLATFORM_BUILD.imageTag,
      gatewayEdgeImageTag: PLATFORM_BUILD.gatewayEdgeImage!.imageTag,
    });
  });

  it("answers 400 and writes nothing when no build is named and the platform build is not known", async () => {
    const records: Records = new Map();
    const { app, provisionGatewayAuthSecret } = adminApi(records);

    const res = await request(app).post("/gateways").send({ gatewayId: "shared-ops3" }).expect(400);

    expect(res.body.error).toMatch(/build is required/);
    expect(provisionGatewayAuthSecret).not.toHaveBeenCalled();
    expect(records.get("gateways/shared-ops3")).toBeUndefined();
  });

  it("refuses image references in place of a build", async () => {
    const records: Records = new Map();
    const { app } = adminApi(records, { platformArtifact: PLATFORM_BUILD });

    const res = await request(app)
      .post("/gateways")
      .send({ gatewayId: "shared-ops4", imageRepository: `${REGISTRY}/octogee-gateway`, imageTag: "abc1234" })
      .expect(400);

    expect(res.body).toMatchObject({ fields: ["imageRepository", "imageTag"] });
    expect(records.get("gateways/shared-ops4")).toBeUndefined();
  });

  describe("the dry run gives the apply's answer", () => {
    const cases: Array<{ name: string; body: Record<string, unknown>; seed?: Records; status: number; error: RegExp }> = [
      { name: "a malformed build", body: { gatewayId: "shared-ops5", sourceSha: "abc1234" }, status: 400, error: /sourceSha/ },
      { name: "a build with no manifest", body: { gatewayId: "shared-ops5", sourceSha: "9".repeat(40) }, status: 404, error: /no build manifest/ },
      { name: "a manifest for another commit", body: { gatewayId: "shared-ops5", sourceSha: MISMATCHED_SHA }, status: 409, error: /does not match/ },
      { name: "an id the store's naming rule refuses", body: { gatewayId: "fleet-live-teau", sourceSha: SOURCE_SHA }, status: 400, error: /shared-/ },
      { name: "an id over the store's length limit", body: { gatewayId: `shared-${"x".repeat(30)}`, sourceSha: SOURCE_SHA }, status: 400, error: /gatewayId/ },
      {
        name: "an id already in use",
        body: { gatewayId: "shared-ops5", sourceSha: SOURCE_SHA },
        seed: new Map([["gateways/shared-ops5", sharedRoot("shared-ops5")]]),
        status: 409,
        error: /already exists/,
      },
    ];

    it.each(cases)("for $name", async ({ body, seed, status, error }) => {
      for (const dryRun of [true, false]) {
        const records: Records = new Map(seed);
        const { app, provisionGatewayAuthSecret } = adminApi(records);
        const res = await request(app).post(`/gateways${dryRun ? "?dryRun=true" : ""}`).send(body);
        expect(res.status).toBe(status);
        expect(String(res.body.error)).toMatch(error);
        expect(provisionGatewayAuthSecret).not.toHaveBeenCalled();
        expect(journalOf(records, "add-gateway")).toEqual([]);
      }
    });

    it("plans the add for a valid build without writing it", async () => {
      const records: Records = new Map();
      const { app, provisionGatewayAuthSecret } = adminApi(records);

      const res = await request(app)
        .post("/gateways?dryRun=true")
        .send({ gatewayId: "shared-ops6", sourceSha: SOURCE_SHA })
        .expect(200);

      expect(res.body).toMatchObject({ dryRun: true });
      expect(JSON.stringify(res.body)).toContain(`sha256:${"b".repeat(64)}`);
      expect(provisionGatewayAuthSecret).not.toHaveBeenCalled();
      expect(records.get("gateways/shared-ops6")).toBeUndefined();
    });
  });
});
