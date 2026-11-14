import express, { Router } from "express";
import type { Firestore } from "firebase-admin/firestore";
import request from "supertest";
import { vi } from "vitest";
import {
  GATEWAY_RELEASES_SUBCOLLECTION,
  releasePayloadHash,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";

import { addAdminFleetRoutes, type FleetRouterDeps } from "../admin-fleet-router.js";
import type { CentralReleaseAuthority, ReleaseDigestManifest } from "../artifact-registry.js";
import type { PlatformStateStore } from "../platform-state/store.js";
import { createDocumentFixtureStore } from "./journal-store.js";
import { noUserAccounts } from "../user-account.js";

export type Seed = Record<string, Record<string, unknown>>;

export const SOURCE_SHA = "a".repeat(40);
export const MANIFEST: ReleaseDigestManifest = {
  sourceSha: SOURCE_SHA,
  manifestDigest: `sha256:${"b".repeat(64)}`,
  openclawVersion: "2026.8.1",
  openclawSourceSha: "f".repeat(40),
  repository: "registry.example/platform",
  surfaces: {
    gateway: {
      "octogee-gateway": `sha256:${"c".repeat(64)}`,
      "octogee-gateway-builder": `sha256:${"d".repeat(64)}`,
      "gateway-edge": `sha256:${"e".repeat(64)}`,
    },
    platform: {},
  },
};
export const PAYLOAD: ReleasePayload = { imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway", imageTag: "abc1234" };

export function gatewayRoot(gatewayId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "operator",
    updatedAt: 1,
    updatedBy: "operator",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: null,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: "standard",
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    modelBrokerLimits: null,
    preemption: null,
    coOwnerUids: [],
    ...overrides,
  };
}

export function release(gatewayId: string, number: number, payload: ReleasePayload = PAYLOAD): Seed {
  return {
    [`gateways/${gatewayId}/${GATEWAY_RELEASES_SUBCOLLECTION}/${number}`]: {
      gatewayId,
      release: number,
      createdAt: 1,
      createdBy: "operator",
      sourceRelease: null,
      note: null,
      payloadHash: releasePayloadHash(payload),
      payload,
    },
  };
}

export function servingSharedGateway(gatewayId: string): Seed {
  const observedAt = Date.now();
  return {
    [`gateways/${gatewayId}`]: gatewayRoot(gatewayId, { liveRelease: 1 }),
    ...release(gatewayId, 1),
    [`${GLM_GATEWAYS_COLLECTION}/${gatewayId}`]: {
      docKind: "runtime",
      gatewayId,
      release: 1,
      lifecycle: "serving",
      createdAt: 1,
      createdByOperationId: null,
      helm: {},
      heartbeat: {
        status: "ready",
        lastHeartbeatAt: observedAt,
        version: "abc1234",
        startedAt: observedAt - 1_000,
        mountedCustomers: [],
      },
      lastError: { message: null, at: null },
    },
  };
}

export function isolatedGateway(gatewayId: string, ownerUid: string, slug: string): Seed {
  return {
    [`gateways/${gatewayId}`]: gatewayRoot(gatewayId, {
      gatewayClass: "isolated",
      imageProfile: "isolated",
      profile: "isolated",
      sizingTier: "s",
      ownerUid,
      builderSlug: slug,
      latestRelease: 2,
      desiredRelease: 2,
    }),
    ...release(gatewayId, 1),
    ...release(gatewayId, 2, { ...PAYLOAD, imageTag: "deadbee" }),
  };
}

export function placedUser(uid: string, slug: string, gatewayId: string): Seed {
  return {
    [`users/${uid}`]: {
      username: slug,
      provisioning: { status: "complete", openclaw: { slug, gatewayId, status: "complete" } },
    },
    [`gateways/${gatewayId}/assignments/${uid}`]: {
      uid,
      slug,
      gatewayId,
      source: "onboarding",
      state: "serving",
      epoch: 1,
      createdAt: 1,
      updatedAt: 1,
      updatedByOperationId: null,
    },
  };
}

export function operation(id: string, row: Record<string, unknown>): Seed {
  return { [`${GLM_OPERATIONS_COLLECTION}/${id}`]: row };
}

export const FLEET: Seed = {
  "config/orchestrator": { defaultGatewayId: "shared-a", sharedGatewayIds: ["shared-a", "shared-b"] },
  ...servingSharedGateway("shared-a"),
  ...servingSharedGateway("shared-b"),
  ...isolatedGateway("iso-ada", "uid-ada", "ada"),
  "gateways/idle": gatewayRoot("idle"),
  "gateways/gone": gatewayRoot("gone", { desiredStatus: "retired" }),
  ...placedUser("uid-ada", "ada", "shared-a"),
};

export const VM_RUNTIME: Seed = {
  [`${GLM_GATEWAYS_COLLECTION}/iso-ada`]: {
    docKind: "runtime", gatewayId: "iso-ada", release: 2, lifecycle: "serving", createdAt: 1, createdByOperationId: null,
    helm: {}, runtime: "gce-vm", lastError: { message: null, at: null },
  },
};

export function sourceRecoveryFleet(): Seed {
  const seed: Seed = {
    "gateways/shared-0": gatewayRoot("shared-0", { desiredStatus: "draining", liveRelease: 1 }),
    ...release("shared-0", 1),
  };
  for (const [index, slug] of ["jdog99", "oct01"].entries()) {
    const uid = `source-user-${index}`;
    const agentId = `octogee-${slug}-coach`;
    seed[`users/${uid}`] = { username: slug, provisioning: { openclaw: { gatewayId: "shared-0", status: "complete" } } };
    seed[`gateways/shared-0/assignments/${uid}`] = {
      uid, slug, gatewayId: "shared-0", source: "onboarding", state: "serving", epoch: index + 1,
      createdAt: 1, updatedAt: 1, updatedByOperationId: null,
    };
    seed[`users/${uid}/agentStores/${agentId}`] = {
      agentId, gatewayId: "shared-0", assignmentEpoch: index + 1,
      storeId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, schema: `source_${index}`, recordedAt: 1,
    };
  }
  return seed;
}

export function restoreRecoveryFleet(): Seed {
  const receipt = { uid: "u", attemptId: "retained-1", gatewayId: "shared-0", assignmentEpoch: 3, claimStartedAt: 200, dispatchedAt: 100 };
  return {
    "gateways/shared-0": gatewayRoot("shared-0"),
    ...release("shared-0", 1),
    ...operation("return-1", { restoreAttempt: receipt }),
  };
}

export interface DryRunInstall {
  addProductRoutes?: (router: Router, deps: {
    db: Firestore;
    store: PlatformStateStore;
    requestNativeReturnSourceRecovery?: FleetRouterDeps["requestNativeReturnSourceRecovery"];
  }) => void;
}

export function harness(seed: Seed = FLEET, install: DryRunInstall = {}) {
  const records = new Map<string, Record<string, unknown>>(Object.entries(structuredClone(seed)));
  const effects = {
    provisionGatewayAuthSecret: vi.fn(async () => ({})),
    suspendAuthUser: vi.fn(async () => undefined),
    revokeConnectorGrantsForUser: vi.fn(async () => undefined),
    requestNativeReturnSourceRecovery: vi.fn(async () => false),
    createAccount: vi.fn(async (account: { userId: string }) => ({ kind: "created" as const, userId: account.userId })),
    setChatPassword: vi.fn(async () => undefined),
    setGitPassword: vi.fn(async () => "ws-ada"),
  };
  const releaseAuthority: CentralReleaseAuthority = {
    resolveManifest: vi.fn(async () => MANIFEST),
    aliasesFor: vi.fn(() => []),
    keepTagsFor: vi.fn(() => []),
    ensureAliases: vi.fn(async () => []),
  };
  const router = Router();
  const store = createDocumentFixtureStore(records);
  install.addProductRoutes?.(router, {
    db: {} as Firestore, store, requestNativeReturnSourceRecovery: effects.requestNativeReturnSourceRecovery,
  });
  addAdminFleetRoutes(router, {
    accounts: noUserAccounts,
    store,
    logger: { info: vi.fn(), warn: vi.fn() },
    computerReplacementEnabled: true,
    listGatewayBuilds: vi.fn(async () => []),
    releaseEnvironment: "test",
    releaseAuthority,
    provisionGatewayAuthSecret: effects.provisionGatewayAuthSecret,
    suspendAuthUser: effects.suspendAuthUser,
    revokeConnectorGrantsForUser: effects.revokeConnectorGrantsForUser,
    requestNativeReturnSourceRecovery: effects.requestNativeReturnSourceRecovery,
    userAccounts: { create: effects.createAccount },
    userSignIn: {
      channels: { setUserPassword: effects.setChatPassword },
      git: { setUserPassword: effects.setGitPassword },
    },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { uid: "operator", isAdmin: true });
    next();
  });
  app.use(router);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  const snapshot = () => JSON.stringify([...records.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return { app, router, records, effects, snapshot };
}

export type Method = "post" | "patch" | "delete";

export interface ChangingRequest {
  method: Method;
  path: string;
  body?: Record<string, unknown>;
}

export function send(app: express.Express, call: ChangingRequest, dryRun: boolean) {
  const separator = call.path.includes("?") ? "&" : "?";
  const target = dryRun ? `${call.path}${separator}dryRun=true` : call.path;
  const pending = request(app)[call.method](target);
  return call.body === undefined ? pending : pending.send(call.body);
}
