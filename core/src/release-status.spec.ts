import { describe, expect, it } from "vitest";
import { MalformedRecordError } from "./platform-state/index.js";
import { createDocumentFixtureStore } from "./testing/journal-store.js";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";

import {
  observeGatewayRelease,
  readReleaseStatus,
  summarizeReleaseStatus,
  type ReleaseStatusGatewayInput,
} from "./release-status.js";

type DocData = Record<string, unknown>;
const NOW = 10_000_000;
const FRESH_HEARTBEAT_AT = NOW - 1_000;

function gatewayRoot(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): DocData {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 4,
    desiredRelease: 4,
    liveRelease: 4,
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

function runtime(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): DocData {
  return {
    docKind: "runtime",
    gatewayId,
    release: 4,
    lifecycle: "serving",
    heartbeat: {
      status: "ready",
      version: "abc1234-oc2026.7.1",
      lastHeartbeatAt: FRESH_HEARTBEAT_AT,
    },
    ...overrides,
  };
}

function release(gatewayId: string, number: number, imageTag = "abc1234-oc2026.7.1"): DocData {
  return {
    gatewayId,
    release: number,
    createdAt: 1,
    createdBy: "test",
    sourceRelease: null,
    note: null,
    payloadHash: "payload-hash",
    payload: {
      imageRepository: "repo/octogee-gateway",
      imageTag,
    },
  };
}

class ReadLog extends Map<string, DocData> {
  readonly reads: string[] = [];

  override get(path: string): DocData | undefined {
    this.reads.push(path);
    return super.get(path);
  }
}

function database(docs: Record<string, DocData>) {
  const records = new ReadLog(Object.entries(docs));
  return { store: createDocumentFixtureStore(records), reads: records.reads };
}

describe("release status", () => {
  it("derives the current Shared default from durable roots instead of a retired legacy default", async () => {
    const { store, reads } = database({
      "config/orchestrator": { defaultGatewayId: "shared-a" },
      "gateways/shared-a": gatewayRoot("shared-a", { desiredStatus: "retired" }),
      "gateways/shared-0": gatewayRoot("shared-0"),
      "gateways/shared-0/releases/4": release("shared-0", 4),
      "glmGateways/shared-0": runtime("shared-0"),
    });
    const status = await readReleaseStatus(store, NOW);
    expect(status).toMatchObject({ defaultGatewayId: "shared-0", defaultSelection: "selected" });
    expect(summarizeReleaseStatus(status)).toEqual({
      status: "converged", serving: 1, converged: 1, excluded: 1, blockers: [],
    });
    expect(reads).not.toContain("config/orchestrator");
  });

  it("reports release convergence separately from platform success and excludes paused and retired gateways", async () => {
    const { store } = database({
      "config/orchestrator": { defaultGatewayId: "shared-0" },
      "gateways/shared-0": gatewayRoot("shared-0"),
      "gateways/shared-0/releases/4": release("shared-0", 4),
      "glmGateways/shared-0": runtime("shared-0"),
      "gateways/builder": gatewayRoot("builder"),
      "gateways/builder/releases/4": release("builder", 4),
      "glmGateways/builder": runtime("builder", {
        heartbeat: { status: "ready", version: "abc1234-oc2026.7.1", lastHeartbeatAt: NOW - GATEWAY_UNREACHABLE_AFTER_MS - 1 },
      }),
      "gateways/paused": gatewayRoot("paused", { desiredStatus: "paused" }),
      "gateways/retired": gatewayRoot("retired", { desiredStatus: "retired" }),
    });
    const status = await readReleaseStatus(store, NOW);
    expect(summarizeReleaseStatus(status)).toEqual({
      status: "incomplete", serving: 2, converged: 1, excluded: 2,
      blockers: ["builder: heartbeat-stale"],
    });
    status.gateways.find((gateway) => gateway.gatewayId === "builder")!.observation = "converged";
    expect(summarizeReleaseStatus(status)).toMatchObject({ status: "converged", converged: 2 });
  });

  it.each(["unconfigured", "invalid"] as const)("does not report an empty fleet with %s default as converged", (defaultSelection) => {
    expect(summarizeReleaseStatus({ defaultGatewayId: null, defaultSelection, gateways: [] })).toMatchObject({ status: "incomplete", serving: 0, converged: 0 });
  });

  it("keeps invalid roots visible even when every readable running gateway converged", async () => {
    const { store } = database({
      "config/orchestrator": { defaultGatewayId: "missing" },
      "gateways/shared-0": gatewayRoot("shared-0"),
      "gateways/shared-0/releases/4": release("shared-0", 4),
      "glmGateways/shared-0": runtime("shared-0"),
      "gateways/invalid": gatewayRoot("invalid", { configSchemaVersion: 0, gatewayClass: "isolated" }),
    });
    expect(summarizeReleaseStatus(await readReleaseStatus(store, NOW))).toEqual({
      status: "incomplete", serving: 1, converged: 1, excluded: 0,
      blockers: ["invalid: invalid-root"],
    });
  });

  it("blocks convergence on invalid roots or a non-serving default", async () => {
    const { store } = database({
      "config/orchestrator": { defaultGatewayId: "default" },
      "gateways/default": gatewayRoot("default", { desiredStatus: "paused" }),
      "gateways/invalid": gatewayRoot("invalid", { configSchemaVersion: 0, gatewayClass: "isolated" }),
    });
    expect(summarizeReleaseStatus(await readReleaseStatus(store, NOW))).toEqual({
      status: "incomplete", serving: 0, converged: 0, excluded: 1,
      blockers: ["default gateway: paused", "invalid: invalid-root", "no serving gateways"],
    });
  });

  it("observes a converged release in one read pass", async () => {
    const { store, reads } = database({
      "config/orchestrator": { defaultGatewayId: "default" },
      "gateways/default": gatewayRoot("default"),
      "gateways/default/releases/4": release("default", 4),
      "glmGateways/default": runtime("default", {
        heartbeat: {
          status: "ready",
          version: `abc1234-oc2026.7.1@sha256:${"a".repeat(64)}`,
          lastHeartbeatAt: FRESH_HEARTBEAT_AT,
        },
      }),
    });

    await expect(readReleaseStatus(store, NOW)).resolves.toEqual({
      defaultGatewayId: "default",
      defaultSelection: "selected",
      gateways: [{
        gatewayId: "default",
        isDefault: true,
        desiredStatus: "running",
        desiredRelease: 4,
        liveRelease: 4,
        desiredImageTag: "abc1234-oc2026.7.1",
        runtimeRelease: 4,
        runtimeLifecycle: "serving",
        heartbeatStatus: "ready",
        heartbeatVersion: `abc1234-oc2026.7.1@sha256:${"a".repeat(64)}`,
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
        observation: "converged",
      }],
    });
    expect(reads.sort()).toEqual([
      "gateways/default",
      "gateways/default/releases/4",
      "glmGateways/default",
    ]);
  });

  it.each([
    {},
    { defaultGatewayId: "" },
    { defaultGatewayId: 4 },
    { defaultGatewayId: "default-r4" },
    { defaultGatewayId: "missing" },
  ])("ignores legacy orchestrator selection %j when deriving the Shared default", async (orchestrator) => {
    const { store } = database({
      "config/orchestrator": orchestrator,
      "gateways/default": gatewayRoot("default"),
      "gateways/default/releases/4": release("default", 4),
      "glmGateways/default": runtime("default"),
    });

    await expect(readReleaseStatus(store, NOW)).resolves.toMatchObject({
      defaultGatewayId: "default",
      defaultSelection: "selected",
      gateways: [{
        gatewayId: "default",
        isDefault: true,
        observation: "converged",
      }],
    });
  });

  it.each<{ roots: Record<string, DocData>; defaultGatewayId: string | null; defaultSelection: string }>([
    { roots: {}, defaultGatewayId: null, defaultSelection: "unconfigured" },
    { roots: { "gateways/shared-0": gatewayRoot("shared-0", { configSchemaVersion: 0 }) }, defaultGatewayId: "shared-0", defaultSelection: "invalid" },
  ])("blocks convergence with incomplete authoritative roots: $defaultSelection", async ({ roots, defaultGatewayId, defaultSelection }) => {
    const { store } = database({ "config/orchestrator": { defaultGatewayId: "legacy" }, ...roots });
    const status = await readReleaseStatus(store, NOW);
    expect(status).toMatchObject({ defaultGatewayId, defaultSelection });
    expect(summarizeReleaseStatus(status)).toMatchObject({ status: "incomplete", serving: 0, converged: 0 });
  });

  it("reports rollout drift without waiting for the fleet controller to reconcile", () => {
    const input: ReleaseStatusGatewayInput = {
      gatewayId: "default",
      desiredStatus: "running",
      desiredRelease: 4,
      liveRelease: 3,
      desiredImageTag: "abc1234-oc2026.7.1",
      runtime: {
        release: 3,
        lifecycle: "serving",
        heartbeatStatus: "ready",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
      },
    };

    expect(observeGatewayRelease(input, NOW)).toBe("rolling");
  });

  it.each([
    ["missing-release", {
      desiredStatus: "running",
      desiredImageTag: null,
    }],
    ["missing-runtime", {
      desiredStatus: "running",
      runtime: null,
    }],
    ["runtime-stale", {
      desiredStatus: "running",
      runtime: {
        release: 3,
        lifecycle: "serving",
        heartbeatStatus: "ready",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
      },
    }],
    ["not-serving", {
      desiredStatus: "running",
      runtime: {
        release: 4,
        lifecycle: "provisioning",
        heartbeatStatus: "ready",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
      },
    }],
    ["unhealthy", {
      desiredStatus: "running",
      runtime: {
        release: 4,
        lifecycle: "serving",
        heartbeatStatus: "unreachable",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
      },
    }],
    ["paused", {
      desiredStatus: "paused",
    }],
    ["retired", {
      desiredStatus: "retired",
    }],
  ] as const)("reports %s without waiting or mutating", (observation, overrides) => {
    const input: ReleaseStatusGatewayInput = {
      gatewayId: "default",
      desiredRelease: 4,
      liveRelease: 4,
      desiredImageTag: "abc1234-oc2026.7.1",
      runtime: {
        release: 4,
        lifecycle: "serving",
        heartbeatStatus: "ready",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
      },
      ...overrides,
    };

    expect(observeGatewayRelease(input, NOW)).toBe(observation);
  });

  it("reports a heartbeat that is not serving the desired release tag", () => {
    expect(observeGatewayRelease({
      gatewayId: "default",
      desiredStatus: "running",
      desiredRelease: 4,
      liveRelease: 4,
      desiredImageTag: "abc1234-oc2026.7.1",
      runtime: {
        release: 4,
        lifecycle: "serving",
        heartbeatStatus: "ready",
        heartbeatVersion: "old-tag",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
      },
    }, NOW)).toBe("version-drift");
  });

  it("recognizes the release tag when the desired payload is digest-pinned", () => {
    expect(observeGatewayRelease({
      gatewayId: "default",
      desiredStatus: "running",
      desiredRelease: 4,
      liveRelease: 4,
      desiredImageTag: `abc1234-oc2026.7.1@sha256:${"a".repeat(64)}`,
      runtime: {
        release: 4,
        lifecycle: "serving",
        heartbeatStatus: "ready",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
      },
    }, NOW)).toBe("converged");
  });

  it("reports an old ready heartbeat as stale instead of converged", () => {
    expect(observeGatewayRelease({
      gatewayId: "default",
      desiredStatus: "running",
      desiredRelease: 4,
      liveRelease: 4,
      desiredImageTag: "abc1234-oc2026.7.1",
      runtime: {
        release: 4,
        lifecycle: "serving",
        heartbeatStatus: "ready",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: NOW - GATEWAY_UNREACHABLE_AFTER_MS - 1,
      },
    }, NOW)).toBe("heartbeat-stale");
  });

  it("accepts the fleet controller's booting heartbeat and reports it as unhealthy", async () => {
    const { store } = database({
      "config/orchestrator": { defaultGatewayId: "default" },
      "gateways/default": gatewayRoot("default"),
      "gateways/default/releases/4": release("default", 4),
      "glmGateways/default": runtime("default", {
        heartbeat: {
          status: "booting",
          version: "abc1234-oc2026.7.1",
          lastHeartbeatAt: FRESH_HEARTBEAT_AT,
        },
      }),
    });

    await expect(readReleaseStatus(store, NOW)).resolves.toMatchObject({
      gateways: [{
        gatewayId: "default",
        heartbeatStatus: "booting",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
        observation: "unhealthy",
      }],
    });
  });

  it("fails closed on a document that is not a durable gateway root instead of omitting it", async () => {
    const { store } = database({
      "config/orchestrator": { defaultGatewayId: "default" },
      "gateways/default": { gatewayId: "default" },
    });

    await expect(readReleaseStatus(store, NOW)).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("surfaces durable roots with unreadable configuration instead of silently omitting them", async () => {
    const { store } = database({
      "config/orchestrator": { defaultGatewayId: "default" },
      "gateways/default": gatewayRoot("default", { configSchemaVersion: 0, gatewayClass: "isolated" }),
    });

    await expect(readReleaseStatus(store, NOW)).resolves.toEqual({
      defaultGatewayId: null,
      defaultSelection: "unconfigured",
      gateways: [{
        gatewayId: "default",
        isDefault: false,
        desiredStatus: null,
        desiredRelease: null,
        liveRelease: null,
        desiredImageTag: null,
        runtimeRelease: null,
        runtimeLifecycle: null,
        heartbeatStatus: null,
        heartbeatVersion: null,
        lastHeartbeatAt: null,
        observation: "invalid-root",
      }],
    });
  });

  it.each([
    ["missing heartbeat", {
      docKind: "runtime",
      gatewayId: "default",
      release: 4,
      lifecycle: "serving",
    }],
    ["non-finite heartbeat", runtime("default", {
      heartbeat: {
        status: "ready",
        version: "abc1234-oc2026.7.1",
        lastHeartbeatAt: Number.NaN,
      },
    })],
    ["out-of-range numeric heartbeat", runtime("default", {
      heartbeat: {
        status: "ready",
        version: "abc1234-oc2026.7.1",
        lastHeartbeatAt: 8.64e15 + 1,
      },
    })],
  ])("reports %s runtime data as missing instead of crashing or trusting it", async (
    _caseName,
    malformedRuntime,
  ) => {
    const { store } = database({
      "config/orchestrator": { defaultGatewayId: "default" },
      "gateways/default": gatewayRoot("default"),
      "gateways/default/releases/4": release("default", 4),
      "glmGateways/default": malformedRuntime,
    });

    await expect(readReleaseStatus(store, NOW)).resolves.toMatchObject({
      gateways: [{
        gatewayId: "default",
        runtimeRelease: null,
        runtimeLifecycle: null,
        heartbeatStatus: null,
        heartbeatVersion: null,
        lastHeartbeatAt: null,
        observation: "missing-runtime",
      }],
    });
  });

  it("fails closed on a runtime record that names another gateway", async () => {
    const { store } = database({
      "gateways/default": gatewayRoot("default"),
      "gateways/default/releases/4": release("default", 4),
      "glmGateways/default": runtime("other"),
    });

    await expect(readReleaseStatus(store, NOW)).rejects.toBeInstanceOf(MalformedRecordError);
  });
});
