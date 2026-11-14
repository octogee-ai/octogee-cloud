import { describe, expect, it } from "vitest";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import {
  isRecoverableGatewayRelease,
  resolveGatewayPlacement,
  resolveLiveRevisionAsSource,
  resolveSourceRevision,
} from "../index.js";

const database = createDocumentFixtureStore;

function durableGateway(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: null,
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
    ...overrides,
  };
}

function servingRuntime(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    docKind: "runtime",
    gatewayId,
    release: 1,
    lifecycle: "serving",
    ...overrides,
  };
}

describe("durable migration root resolution", () => {
  it("rejects a source root with no authoritative gateway class", async () => {
    const source = durableGateway("source");
    delete source.gatewayClass;
    const db = database({
      "gateways/source": source,
      "glmGateways/source": servingRuntime("source"),
      "gateways/source/assignments/uid-alice": {
        uid: "uid-alice", slug: "alice", gatewayId: "source", source: "migrate-user", state: "serving", epoch: 7,
      },
    });
    await expect(resolveSourceRevision(db, "uid-alice", "source")).resolves.toBeNull();
    await expect(resolveLiveRevisionAsSource(db, "source")).resolves.toBeNull();
  });

  it("keeps a claimed retired gateway out of ordinary migration sources and destinations", async () => {
    const claimedRetired = durableGateway("default", {
      desiredStatus: "retired",
      retirementClaim: {
        operationId: "retire-1",
        version: 1,
        claimedAt: 10,
        phase: "claimed",
        liveRelease: 1,
        liveRuntimeIdentity: null,
        previousDesiredStatus: "running",
      },
    });
    const db = database({
      "gateways/default": claimedRetired,
      "glmGateways/default": servingRuntime("default"),
    });

    await expect(resolveGatewayPlacement(db, "default")).resolves.toEqual({
      ok: false,
      reason: "revision-not-ready",
    });
    await expect(resolveLiveRevisionAsSource(db, "default")).resolves.toBeNull();
  });

  it("names what blocks an isolated gateway that has not gone live", async () => {
    const blocker = "the isolated gateway image is linux/amd64 only, and this cluster has no amd64 node";
    const db = database({
      "gateways/pod": durableGateway("pod", {
        gatewayClass: "isolated", imageProfile: "isolated", sizingTier: "s", liveRelease: null, ownerUid: "uid-lin", builderSlug: "lin",
      }),
      "glmGateways/pod": servingRuntime("pod", { lifecycle: "provisioning", runtime: "cluster", lastError: { message: blocker, at: 5 } }),
      "gateways/shared": durableGateway("shared", { liveRelease: null }),
      "glmGateways/shared": servingRuntime("shared", { lifecycle: "provisioning", lastError: { message: "a shared gateway error", at: 5 } }),
    });

    await expect(resolveGatewayPlacement(db, "pod")).resolves.toEqual({ ok: false, reason: "no-live-revision", blocker });
    await expect(resolveGatewayPlacement(db, "shared")).resolves.toEqual({ ok: false, reason: "no-live-revision" });
  });

  it("binds an unassigned source to the exact stable live root generation", async () => {
    const db = database({
      "gateways/source": durableGateway("source", { updatedAt: 17 }),
      "glmGateways/source": servingRuntime("source"),
    });

    await expect(
      resolveSourceRevision(db, "uid-alice", "source"),
    ).resolves.toEqual({
      revisionId: "source",
      release: 1,
      assignmentMode: "unassigned-live",
      rootUpdatedAt: 17,
      gatewayClass: "shared",
    });
  });

  it("keeps an assigned draining gateway valid as a migration source", async () => {
    const db = database({
      "gateways/source": durableGateway("source", { desiredStatus: "draining" }),
      "gateways/source/assignments/uid-alice": {
        uid: "uid-alice",
        slug: "alice",
        gatewayId: "source",
        source: "migrate-user",
        state: "serving",
        epoch: 7,
      },
      "glmGateways/source": servingRuntime("source"),
    });

    await expect(
      resolveSourceRevision(db, "uid-alice", "source"),
    ).resolves.toEqual({
      revisionId: "source",
      release: 1,
      epoch: 7,
      assignmentMode: "assigned",
      gatewayClass: "shared",
    });
  });

  it("does not bind an unassigned source while its durable root is unconverged", async () => {
    const db = database({
      "gateways/source": durableGateway("source", {
        updatedAt: 18,
        desiredRelease: 2,
      }),
      "glmGateways/source": servingRuntime("source"),
    });

    await expect(
      resolveSourceRevision(db, "uid-alice", "source"),
    ).resolves.toBeNull();
  });

  it("does not recover a pending Helm release for a paused durable root", async () => {
    const db = database({
      "gateways/default": durableGateway("default", { desiredStatus: "paused" }),
      "glmGateways/default": servingRuntime("default"),
    });

    await expect(isRecoverableGatewayRelease(db, "default")).resolves.toBe(false);
  });

  it("does not recover a pending Helm release whose runtime is marked failed", async () => {
    const db = database({
      "gateways/default": durableGateway("default"),
      "glmGateways/default": servingRuntime("default", { lifecycle: "failed" }),
    });

    await expect(isRecoverableGatewayRelease(db, "default")).resolves.toBe(false);
  });

  it("recovers a pending Helm release for a healthy running root", async () => {
    const db = database({
      "gateways/default": durableGateway("default"),
      "glmGateways/default": servingRuntime("default"),
    });

    await expect(isRecoverableGatewayRelease(db, "default")).resolves.toBe(true);
  });

  it("rejects a destination that has only a gateway-shaped legacy root", async () => {
    const db = database({
      "gateways/target": {
        gatewayId: "target",
        latestRelease: 1,
        desiredRelease: 1,
        liveRelease: 1,
        desiredStatus: "running",
      },
      "glmGateways/target": servingRuntime("target"),
    });

    await expect(resolveGatewayPlacement(db, "target")).resolves.toBeNull();
  });

  it("rejects a source that has only a gateway-shaped legacy root", async () => {
    const db = database({
      "gateways/source": {
        gatewayId: "source",
        latestRelease: 1,
        desiredRelease: 1,
        liveRelease: 1,
        desiredStatus: "running",
      },
      "glmGateways/source": servingRuntime("source"),
    });

    await expect(resolveLiveRevisionAsSource(db, "source")).resolves.toBeNull();
  });

  it("refuses a destination whose runtime doc claims a foreign gateway identity", async () => {
    const db = database({
      "gateways/target": durableGateway("target"),
      "glmGateways/target": servingRuntime("other", { gatewayId: "other" }),
    });

    await expect(resolveGatewayPlacement(db, "target")).rejects.toThrow(MalformedRecordError);
  });

  it("refuses an assigned source whose runtime doc claims a foreign gateway identity", async () => {
    const db = database({
      "gateways/source": durableGateway("source"),
      "gateways/source/assignments/uid-alice": {
        slug: "alice",
        gatewayId: "source",
        source: "migrate-user",
      },
      "glmGateways/source": servingRuntime("other", { gatewayId: "other" }),
    });

    await expect(
      resolveSourceRevision(db, "uid-alice", "source"),
    ).rejects.toThrow(MalformedRecordError);
  });
});
