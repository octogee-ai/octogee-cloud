import { describe, expect, it } from "vitest";
import {
  buildHelmTargetMap,
  buildInstancesMap,
  diffInstancesMap,
  isImageRoll,
  isReplicasOnlyUpdate,
  type ReconcileChange,
} from "../reconcile-plan";
import type { GatewayDesiredState, HelmInstancesMap } from "@octogee/shared/types/glm";
import type { SizingTier } from "@octogee/shared/types/sizing";

const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

function mkDesired(overrides: Partial<GatewayDesiredState>): GatewayDesiredState {
  return {
    gatewayId: "default",
    imageRepository: REPO,
    imageTag: "abc1234",
    desiredStatus: "running",
    createdBy: "ci:abc1234",
    ...overrides,
  };
}

describe("sizingTier transition safety (stale Firestore values)", () => {
  // A pre-rename tier like "operator" can still sit in glmGateways desired
  // state. The actual-state reader (readPersonalKnobs) drops unknown tiers, so
  // forwarding a stale value here would get schema-rejected by the chart and
  // the gateway would diff + retry forever. Both sides must treat an unknown
  // tier as unset → profile default.
  const STALE = "operator" as unknown as SizingTier;

  it("buildInstancesMap omits a stale/legacy sizingTier", () => {
    const map = buildInstancesMap([mkDesired({ sizingTier: STALE })]);
    expect(map.default.sizingTier).toBeUndefined();
  });

  it("still forwards a valid sizingTier", () => {
    const map = buildInstancesMap([mkDesired({ sizingTier: "l" })]);
    expect(map.default.sizingTier).toBe("l");
  });

  const withResidualComputeClass = { ...mkDesired({}), computeClass: "octogee-gateway-spot" };

  it("never forwards a residual computeClass to the chart", () => {
    const map = buildInstancesMap([withResidualComputeClass]);
    expect(map.default).not.toHaveProperty("computeClassOverride");
  });

  it("no perpetual update when desired holds a stale tier that actual already dropped", () => {
    const actual = buildInstancesMap([mkDesired({})]);
    const desired = buildHelmTargetMap([mkDesired({ sizingTier: STALE })], actual);
    expect(diffInstancesMap(actual, desired)).toEqual([]);
  });

  it("a residual computeClass on the durable doc is not drift", () => {
    const actual = buildInstancesMap([mkDesired({})]);
    const desired = buildHelmTargetMap([withResidualComputeClass], actual);
    expect(diffInstancesMap(actual, desired)).toEqual([]);
  });
});

describe("buildInstancesMap", () => {
  it("renders one instance entry per `running` desired-state doc", () => {
    const map = buildInstancesMap([
      mkDesired({ gatewayId: "default", imageTag: "abc" }),
    ]);
    expect(map).toEqual({
      default: {
        enabled: true,
        image: { repository: REPO, tag: "abc" },
        gatewayId: "default",
        replicas: 1,
        serviceAccountName: "octogee-gw-default",
        serviceAccount: { create: true },
      },
    });
  });

  it("paused desired-status renders replicas=0 (release stays, pod scales to zero)", () => {
    const map = buildInstancesMap([
      mkDesired({ gatewayId: "default", desiredStatus: "paused" }),
    ]);
    expect(map.default).toMatchObject({ enabled: true, replicas: 0 });
  });

  it("keeps enabled=true for desiredStatus=draining — pod stays up; new placements are blocked elsewhere", () => {
    const map = buildInstancesMap([
      mkDesired({ gatewayId: "default", desiredStatus: "draining" }),
    ]);
    expect(map.default.enabled).toBe(true);
  });

  it("omits desiredStatus=retired entirely (instance slot is gone)", () => {
    const map = buildInstancesMap([
      mkDesired({ gatewayId: "default", desiredStatus: "running" }),
      mkDesired({ gatewayId: "old", desiredStatus: "retired" }),
    ]);
    expect(Object.keys(map).sort()).toEqual(["default"]);
  });

  it("renders multiple running instances side by side", () => {
    const map = buildInstancesMap([
      mkDesired({ gatewayId: "default", imageTag: "abc" }),
      mkDesired({ gatewayId: "canary", imageTag: "def" }),
    ]);
    expect(map.default).toMatchObject({ gatewayId: "default", image: { tag: "abc" } });
    expect(map.canary).toMatchObject({ gatewayId: "canary", image: { tag: "def" } });
  });

  it("never renders the user's owner identity into its instance values", () => {
    const map = buildInstancesMap([
      mkDesired({ gatewayId: "jack", gatewayClass: "isolated", builderSlug: "jack", ownerUid: "uid-jack" }),
    ]);
    expect(map.jack).toMatchObject({ gatewayClass: "isolated" });
    expect(map.jack).not.toHaveProperty("builderSlug");
    expect(map.jack).not.toHaveProperty("ownerUid");
  });

  it("preserves personal gateway helm knobs from desired state", () => {
    const map = buildInstancesMap([
      mkDesired({
        gatewayId: "walter",
        serviceAccountName: "octogee-gateway-walter",
        gatewayContainerSecurityContext: {
          allowPrivilegeEscalation: true,
          capabilities: { drop: ["ALL"] },
        },
      }),
    ]);
    expect(map.walter).toMatchObject({
      serviceAccountName: "octogee-gateway-walter",
      gatewayContainerSecurityContext: {
        allowPrivilegeEscalation: true,
      },
    });
  });

  it("returns an empty map when no desired state exists", () => {
    const map = buildInstancesMap([]);
    expect(map).toEqual({});
  });

  it("propagates the user profile onto the Helm instance value", () => {
    const map = buildInstancesMap([
      mkDesired({ gatewayId: "walter", gatewayClass: "isolated", imageProfile: "isolated" }),
    ]);
    expect(map.walter.profile).toBe("isolated");
  });

  it("defaults isolated gateways to a locked dedicated ServiceAccount and Control UI", () => {
    const map = buildInstancesMap([
      mkDesired({
        gatewayId: "walter",
        gatewayClass: "isolated",
        imageProfile: "isolated",
      }),
    ]);
    expect(map.walter).toMatchObject({
      serviceAccountName: "octogee-gw-walter",
      serviceAccount: { create: true },
      builderAccess: {
        controlUiEnabled: false,
        reason: "runtime-trust-boundary-not-provisioned",
      },
    });
  });

  it("enables Control UI for an isolated gateway with a user owner", () => {
    const map = buildInstancesMap([
      mkDesired({ gatewayId: "walter", gatewayClass: "isolated", imageProfile: "isolated", ownerUid: "uid-chris" }),
    ]);
    expect(map.walter.builderAccess).toMatchObject({
      controlUiEnabled: true,
    });
  });

  it("defaults Control UI on for an owned isolated gateway", () => {
    const map = buildInstancesMap([
      mkDesired({
        gatewayId: "hobby",
        gatewayClass: "isolated",
        imageProfile: "isolated",
        ownerUid: "uid-hobby",
        builderAccess: {},
      }),
    ]);
    expect(map.hobby.builderAccess).toMatchObject({
      controlUiEnabled: true,
    });
  });

  it("enables runtime access for an owned isolated gateway without Operator Workload Identity", () => {
    const map = buildInstancesMap([
      mkDesired({ gatewayId: "jack", gatewayClass: "isolated", ownerUid: "uid-jack" }),
    ]);
    expect(map.jack.builderAccess).toMatchObject({
      reason: "owned-runtime-gateway",
    });
    expect(map.jack.serviceAccountName).toBe("octogee-gw-jack");
    expect(map.jack.serviceAccount).toEqual({ create: true });
  });

  it("injects resolved API-server egress CIDRs into an owned isolated gateway with Control UI", () => {
    const map = buildInstancesMap(
      [mkDesired({ gatewayId: "walter", gatewayClass: "isolated", imageProfile: "isolated", ownerUid: "uid-chris" })],
      undefined,
      ["10.128.0.2/32", "34.118.224.1/32"],
    );
    expect(map.walter.builderAccess).toMatchObject({
      kubeApiServerEgressCidrs: ["10.128.0.2/32", "34.118.224.1/32"],
    });
  });

  it("does not inject egress CIDRs into a shared gateway", () => {
    const map = buildInstancesMap([mkDesired({ gatewayId: "default" })], undefined, ["10.128.0.2/32"]);
    expect(map.default.builderAccess).toBeUndefined();
  });

  it("leaves a working isolated gateway's egress intact when no CIDRs resolved", () => {
    const map = buildInstancesMap(
      [
        mkDesired({
          gatewayId: "walter",
          gatewayClass: "isolated",
          imageProfile: "isolated",
          ownerUid: "uid-chris",
          builderAccess: { controlUiEnabled: true, kubeApiServerEgressCidrs: ["10.128.0.2/32"] },
        }),
      ],
      undefined,
      [],
    );
    expect(map.walter.builderAccess?.kubeApiServerEgressCidrs).toEqual(["10.128.0.2/32"]);
  });

  it("does not let a isolated gateway inherit the platform default ServiceAccount", () => {
    const map = buildInstancesMap([
      mkDesired({
        gatewayId: "walter",
        gatewayClass: "isolated",
        imageProfile: "isolated",
        serviceAccountName: "octogee-gateway",
      }),
    ]);
    expect(map.walter.serviceAccountName).toBe("octogee-gw-walter");
    expect(map.walter.serviceAccount).toEqual({ create: true });
  });

  it("leaves a generated user ServiceAccount GSA-less", () => {
    const map = buildInstancesMap([
      mkDesired({
        gatewayId: "walter-canary-2026",
        gatewayClass: "isolated",
        imageProfile: "isolated",
        ownerUid: "uid-chris",
        serviceAccountName: "octogee-gw-walter-canary-2026",
        serviceAccount: { create: true },
      }),
    ]);
    expect(map["walter-canary-2026"].serviceAccount).toEqual({ create: true });
    expect(map["walter-canary-2026"].builderAccess).toMatchObject({
      controlUiEnabled: true,
    });
  });

  it("does not require a platform gateway GSA for a generated user ServiceAccount", () => {
    const map = buildInstancesMap([
        mkDesired({
          gatewayId: "walter-canary-2026",
          gatewayClass: "isolated",
          imageProfile: "isolated",
          serviceAccountName: "octogee-gw-walter-canary-2026",
          serviceAccount: { create: true },
        }),
      ]);
    expect(map["walter-canary-2026"].serviceAccount).toEqual({ create: true });
  });

  it("strips Workload Identity from an explicit generated ServiceAccount", () => {
    const map = buildInstancesMap([
      mkDesired({
        gatewayId: "walter",
        gatewayClass: "isolated",
        imageProfile: "isolated",
        serviceAccountName: "octogee-gw-walter",
        serviceAccount: {
          create: true,
          annotations: {
            "iam.gke.io/gcp-service-account": "custom@octogee.iam.gserviceaccount.com",
          },
        },
      }),
    ]);
    expect(map.walter.serviceAccount).toEqual({ create: true });
  });

  it("preserves an explicit custom user ServiceAccount name", () => {
    const map = buildInstancesMap([
      mkDesired({
        gatewayId: "walter",
        gatewayClass: "isolated",
        imageProfile: "isolated",
        serviceAccountName: "custom-user-ksa",
      }),
    ]);
    expect(map.walter.serviceAccountName).toBe("custom-user-ksa");
    expect(map.walter.serviceAccount).toBeUndefined();
  });

  it("defaults standard gateways to a generated ServiceAccount with no platform annotation values", () => {
    const map = buildInstancesMap([
      mkDesired({
        gatewayId: "default",
        profile: "standard",
        serviceAccountName: "octogee-gateway",
      }),
    ]);
    expect(map.default.serviceAccountName).toBe("octogee-gw-default");
    expect(map.default.serviceAccount).toEqual({ create: true });
  });

  it("does not annotate a standard generated ServiceAccount", () => {
    const map = buildInstancesMap([
      mkDesired({
        gatewayId: "default",
        profile: "standard",
        serviceAccountName: "octogee-gateway",
      }),
    ]);
    expect(map.default.serviceAccount).toEqual({ create: true });
  });

  it("never carries a persistence knob in Helm values (emptyDir only)", () => {
    const map = buildInstancesMap([
      mkDesired({ gatewayId: "walter", gatewayClass: "isolated", imageProfile: "isolated" }),
    ]);
    expect("persistence" in map.walter).toBe(false);
  });

  it("omits default shared/standard class/profile fields from helm values", () => {
    const map = buildInstancesMap([
      mkDesired({ gatewayId: "default" }),
    ]);
    expect(map.default).not.toHaveProperty("gatewayClass");
    expect(map.default).not.toHaveProperty("imageProfile");
    expect(map.default).not.toHaveProperty("profile");
  });
});

describe("diffInstancesMap", () => {
  const baseInstance = (tag: string) => ({
    enabled: true,
    image: { repository: REPO, tag },
    gatewayId: "gw-test",
  });

  it("reports no changes when desired == actual", () => {
    const actual: HelmInstancesMap = { default: baseInstance("abc") };
    const desired: HelmInstancesMap = { default: baseInstance("abc") };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual([]);
  });

  it("reports a `create` when desired has an instance actual doesn't", () => {
    const actual: HelmInstancesMap = { default: baseInstance("abc") };
    const desired: HelmInstancesMap = {
      default: baseInstance("abc"),
      canary: { enabled: true, image: { repository: REPO, tag: "def" }, gatewayId: "gw-canary" },
    };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "create", gatewayId: "canary" });
  });

  it("reports `drift` (NOT `remove`) when actual has an instance desired doesn't — never auto-deletes", () => {
    const actual: HelmInstancesMap = {
      default: baseInstance("abc"),
      old: baseInstance("xyz"),
    };
    const desired: HelmInstancesMap = { default: baseInstance("abc") };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual([
      { kind: "drift", gatewayId: "old", current: actual.old },
    ]);
  });

  it("reports an `update` when image tag differs for the same instance", () => {
    const actual: HelmInstancesMap = { default: baseInstance("abc") };
    const desired: HelmInstancesMap = { default: baseInstance("def") };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual<ReconcileChange[]>([
      { kind: "update", gatewayId: "default", from: actual.default, to: desired.default },
    ]);
  });

  it("reports an update when replicas flips (pause/resume path)", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("abc"), replicas: 1 } };
    const desired: HelmInstancesMap = { default: { ...baseInstance("abc"), replicas: 0 } };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual<ReconcileChange[]>([
      { kind: "update", gatewayId: "default", from: actual.default, to: desired.default },
    ]);
  });

  it("reports an update when sizingTier flips (change-tier path)", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("abc"), sizingTier: "m" } };
    const desired: HelmInstancesMap = { default: { ...baseInstance("abc"), sizingTier: "l" } };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual<ReconcileChange[]>([
      { kind: "update", gatewayId: "default", from: actual.default, to: desired.default },
    ]);
  });

  it("reports exactly one update when image, sizingTier, and replicas all differ (no double-counting)", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("abc"), sizingTier: "m", replicas: 1 } };
    const desired: HelmInstancesMap = { default: { ...baseInstance("def"), sizingTier: "l", replicas: 0 } };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "update", gatewayId: "default" });
  });

  it("reports an update when personal gateway helm knobs change", () => {
    const actual: HelmInstancesMap = {
      walter: {
        enabled: true,
        image: { repository: REPO, tag: "abc" },
        gatewayId: "walter",
      },
    };
    const desired: HelmInstancesMap = {
      walter: {
        ...actual.walter,
        serviceAccountName: "octogee-gateway-walter",
        gatewayContainerSecurityContext: { allowPrivilegeEscalation: true },
      },
    };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual<ReconcileChange[]>([
      { kind: "update", gatewayId: "walter", from: actual.walter, to: desired.walter },
    ]);
  });

  it("does NOT report an update when a helm-knob object differs only in key order (stable compare — no per-tick reconcile churn)", () => {
    const actual: HelmInstancesMap = {
      walter: {
        enabled: true,
        image: { repository: REPO, tag: "abc" },
        gatewayId: "walter",
        gatewayContainerSecurityContext: {
          allowPrivilegeEscalation: true,
          capabilities: { drop: ["ALL"] },
        },
      },
    };

const desired: HelmInstancesMap = {
      walter: {
        enabled: true,
        gatewayId: "walter",
        image: { tag: "abc", repository: REPO },
        gatewayContainerSecurityContext: {
          capabilities: { drop: ["ALL"] },
          allowPrivilegeEscalation: true,
        },
      },
    };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual<ReconcileChange[]>([]);
  });

  it("reports an `update` when enabled flips from true to false (drain)", () => {
    const actual: HelmInstancesMap = { default: baseInstance("abc") };
    const desired: HelmInstancesMap = {
      default: { ...baseInstance("abc"), enabled: false },
    };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("update");
  });

  it("reports multiple independent changes in a single diff (create + update + drift)", () => {
    const actual: HelmInstancesMap = {
      stale: baseInstance("old"),
      default: baseInstance("abc"),
    };
    const desired: HelmInstancesMap = {
      default: baseInstance("def"),
      canary: { ...baseInstance("ghi"), gatewayId: "gw-canary" },
    };
    const changes = diffInstancesMap(actual, desired);
    const kinds = changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(["create", "drift", "update"]);
  });
});

describe("buildHelmTargetMap", () => {
  const REPO_PATH = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
  const desired = (overrides: Partial<GatewayDesiredState>): GatewayDesiredState => ({
    gatewayId: "default",
    imageRepository: REPO_PATH,
    imageTag: "abc1234",
    desiredStatus: "running",
    createdBy: "ci:abc1234",
    ...overrides,
  });

  it("preserves drifted instances (in actual but no glmGateways doc) — never deletes", () => {
    const actual: HelmInstancesMap = {
      default: { enabled: true, image: { repository: REPO_PATH, tag: "abc" }, gatewayId: "gw-test" },
      old: { enabled: true, image: { repository: REPO_PATH, tag: "xyz" }, gatewayId: "old" },
    };
    const target = buildHelmTargetMap([desired({})], actual);
    expect(Object.keys(target).sort()).toEqual(["default", "old"]);
    expect(target.old).toEqual(actual.old);
  });

  it("applies non-retired glmGateways on top of actual (overriding the matching instance)", () => {
    const actual: HelmInstancesMap = {
      default: { enabled: true, image: { repository: REPO_PATH, tag: "old" }, gatewayId: "gw-test" },
    };
    const target = buildHelmTargetMap(
      [desired({ gatewayId: "default", imageTag: "new" })],
      actual,
    );
    expect(target.default.image.tag).toBe("new");
  });

  it("adds new instances from glmGateways that aren't in actual yet (the create case)", () => {
    const actual: HelmInstancesMap = {};
    const target = buildHelmTargetMap(
      [desired({ gatewayId: "canary" })],
      actual,
    );
    expect(target.canary.gatewayId).toBe("canary");
  });

  it("removes a retired instance from target when no users are mounted (helm uninstalls)", () => {
    const actual: HelmInstancesMap = {
      default: { enabled: true, image: { repository: REPO_PATH, tag: "abc" }, gatewayId: "gw-test" },
      canary: { enabled: true, image: { repository: REPO_PATH, tag: "def" }, gatewayId: "canary" },
    };
    const mounted = new Map<string, readonly string[]>([
      ["gw-test", ["alice", "bob"]],
      ["canary", []],
    ]);
    const target = buildHelmTargetMap(
      [
        desired({ gatewayId: "canary", desiredStatus: "retired" }),
      ],
      actual,
      mounted,
    );
    expect(Object.keys(target).sort()).toEqual(["default"]);
  });

  it("preserves a retired instance from target while users are still mounted (drain wait)", () => {
    const actual: HelmInstancesMap = {
      default: { enabled: true, image: { repository: REPO_PATH, tag: "abc" }, gatewayId: "gw-test" },
      canary: { enabled: true, image: { repository: REPO_PATH, tag: "def" }, gatewayId: "canary" },
    };
    const mounted = new Map<string, readonly string[]>([
      ["canary", ["alice"]],
    ]);
    const target = buildHelmTargetMap(
      [
        desired({ gatewayId: "canary", desiredStatus: "retired" }),
      ],
      actual,
      mounted,
    );
    expect(target.canary).toEqual(actual.canary);
  });

  it("removes a retired instance whose heartbeat doc never existed (stranded crash-looping canary case)", () => {
    const actual: HelmInstancesMap = {
      default: { enabled: true, image: { repository: REPO_PATH, tag: "abc" }, gatewayId: "gw-test" },
      crashloop: { enabled: true, image: { repository: REPO_PATH, tag: "bad" }, gatewayId: "crashloop" },
    };
    const mounted = new Map<string, readonly string[]>([["gw-test", []]]);
    const target = buildHelmTargetMap(
      [
        desired({ gatewayId: "crashloop", desiredStatus: "retired" }),
      ],
      actual,
      mounted,
    );
    expect(Object.keys(target).sort()).toEqual(["default"]);
  });

  it("returns the unchanged actual map when no desired-state docs exist (drift-only state)", () => {
    const actual: HelmInstancesMap = {
      default: { enabled: true, image: { repository: REPO_PATH, tag: "abc" }, gatewayId: "gw-test" },
    };
    const target = buildHelmTargetMap([], actual);
    expect(target).toEqual(actual);
  });
});

describe("chart-template drift detection", () => {
  const baseInstance = (tag: string) => ({
    enabled: true,
    image: { repository: REPO, tag },
    gatewayId: "gw-test",
  });

  const desired = (overrides: Partial<GatewayDesiredState>): GatewayDesiredState => ({
    gatewayId: "default",
    imageRepository: REPO,
    imageTag: "abc",
    desiredStatus: "running",
    createdBy: "ci:abc",
    ...overrides,
  });

  it("buildInstancesMap stamps the chartFingerprint onto every live entry when provided", () => {
    const map = buildInstancesMap([desired({})], "fp-aaa");
    expect(map.default.chartFingerprint).toBe("fp-aaa");
  });

  it("buildInstancesMap omits chartFingerprint when not provided (boot/legacy callers)", () => {
    const map = buildInstancesMap([desired({})]);
    expect(map.default.chartFingerprint).toBeUndefined();
  });

  it("buildHelmTargetMap stamps the desired fingerprint onto live entries (overrides actual)", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("abc"), chartFingerprint: "fp-old" } };
    const target = buildHelmTargetMap([desired({})], actual, new Map(), "fp-new");
    expect(target.default.chartFingerprint).toBe("fp-new");
  });

  it("diffInstancesMap returns `update` when actual has no fingerprint and desired has one (transition case)", () => {
    const actual: HelmInstancesMap = { default: baseInstance("abc") };
    const desiredMap: HelmInstancesMap = { default: { ...baseInstance("abc"), chartFingerprint: "fp-new" } };
    const changes = diffInstancesMap(actual, desiredMap);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "update", gatewayId: "default" });
  });

  it("diffInstancesMap returns no changes when both sides carry the same fingerprint", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("abc"), chartFingerprint: "fp-same" } };
    const desiredMap: HelmInstancesMap = { default: { ...baseInstance("abc"), chartFingerprint: "fp-same" } };
    expect(diffInstancesMap(actual, desiredMap)).toEqual([]);
  });

  it("diffInstancesMap returns `update` when fingerprints differ but image tag is identical (chart-only drift)", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("abc"), chartFingerprint: "fp-old" } };
    const desiredMap: HelmInstancesMap = { default: { ...baseInstance("abc"), chartFingerprint: "fp-new" } };
    const changes = diffInstancesMap(actual, desiredMap);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("update");
  });
});

describe("chart-drift comparison is caller-gated (issue #997 — PROD must not auto-roll)", () => {
  const baseInstance = (tag: string) => ({
    enabled: true,
    image: { repository: REPO, tag },
    gatewayId: "gw-prod",
  });

  it("compareChartFingerprint:false — chart-only drift produces NO changes (a glm-controller image bump must not roll user pods)", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("sha"), chartFingerprint: "fp-old" } };
    const desiredMap: HelmInstancesMap = { default: { ...baseInstance("sha"), chartFingerprint: "fp-new" } };
    expect(
      diffInstancesMap(actual, desiredMap, { compareChartFingerprint: false }),
    ).toEqual([]);
  });

  it("compareChartFingerprint:false — the undefined→fingerprint transition is also suppressed (fresh fleet controller image must not roll the existing release)", () => {
    const actual: HelmInstancesMap = { default: baseInstance("sha") };
    const desiredMap: HelmInstancesMap = { default: { ...baseInstance("sha"), chartFingerprint: "fp-new" } };
    expect(
      diffInstancesMap(actual, desiredMap, { compareChartFingerprint: false }),
    ).toEqual([]);
  });

  it("compareChartFingerprint:false — an image-tag change still rolls (operator-driven PROD rollout via promote-gateway.ts)", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("sha-old"), chartFingerprint: "fp-old" } };
    const desiredMap: HelmInstancesMap = { default: { ...baseInstance("sha-new"), chartFingerprint: "fp-new" } };
    const changes = diffInstancesMap(actual, desiredMap, {
      compareChartFingerprint: false,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "update", gatewayId: "default" });
  });

  it("compareChartFingerprint defaults to true — chart-only drift is detected", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("sha"), chartFingerprint: "fp-old" } };
    const desiredMap: HelmInstancesMap = { default: { ...baseInstance("sha"), chartFingerprint: "fp-new" } };
    const changes = diffInstancesMap(actual, desiredMap);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("update");
  });
});

describe("isReplicasOnlyUpdate", () => {
  const REPO2 = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
  const base = () => ({
    enabled: true as const,
    image: { repository: REPO2, tag: "abc" },
    gatewayId: "gw-test",
  });

  it("returns true when only replicas differs (paused: 1 → 0)", () => {
    const change: ReconcileChange = {
      kind: "update",
      gatewayId: "default",
      from: { ...base(), replicas: 1 },
      to: { ...base(), replicas: 0 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(true);
  });

  it("returns true when only replicas differs (resume: 0 → 1)", () => {
    const change: ReconcileChange = {
      kind: "update",
      gatewayId: "default",
      from: { ...base(), replicas: 0 },
      to: { ...base(), replicas: 1 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(true);
  });

  it("returns false when replicas AND image tag differ (chart-shape change → helm)", () => {
    const change: ReconcileChange = {
      kind: "update",
      gatewayId: "default",
      from: { ...base(), image: { repository: REPO2, tag: "abc" }, replicas: 1 },
      to: { ...base(), image: { repository: REPO2, tag: "def" }, replicas: 0 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(false);
  });

  it("returns false when replicas AND sizingTier differ", () => {
    const change: ReconcileChange = {
      kind: "update",
      gatewayId: "default",
      from: { ...base(), sizingTier: "l", replicas: 1 },
      to: { ...base(), sizingTier: "m", replicas: 0 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(false);
  });

  it("returns false when a helm-knob object differs (object diff)", () => {
    const change: ReconcileChange = {
      kind: "update",
      gatewayId: "walter",
      from: { ...base(), gatewayContainerSecurityContext: { allowPrivilegeEscalation: false }, replicas: 1 },
      to: { ...base(), gatewayContainerSecurityContext: { allowPrivilegeEscalation: true }, replicas: 0 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(false);
  });

  it("returns false on `create` kind", () => {
    const change: ReconcileChange = {
      kind: "create",
      gatewayId: "default",
      to: { ...base(), replicas: 1 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(false);
  });

  it("returns false on `drift` kind", () => {
    const change: ReconcileChange = {
      kind: "drift",
      gatewayId: "default",
      current: { ...base(), replicas: 0 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(false);
  });

  it("returns false when chartFingerprint differs", () => {
    const change: ReconcileChange = {
      kind: "update",
      gatewayId: "default",
      from: { ...base(), chartFingerprint: "fp-old", replicas: 1 },
      to: { ...base(), chartFingerprint: "fp-new", replicas: 0 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(false);
  });

  it("returns false when nothing actually differs (defensive — diffInstancesMap wouldn't emit this, but the predicate must be honest)", () => {
    const inst = { ...base(), replicas: 1 };
    const change: ReconcileChange = {
      kind: "update",
      gatewayId: "default",
      from: inst,
      to: inst,
    };
    expect(isReplicasOnlyUpdate(change)).toBe(false);
  });
});

describe("isImageRoll — the in-place-roll detector behind the mounted-gateway guard", () => {
  const REPO3 = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
  const USER_REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder";
  const base = () => ({
    enabled: true as const,
    image: { repository: REPO3, tag: "abc" },
    gatewayId: "gw-test",
  });

  it("returns true when the image TAG changes (the classic SHA roll)", () => {
    expect(
      isImageRoll({
        kind: "update",
        gatewayId: "default",
        from: { ...base(), image: { repository: REPO3, tag: "abc" } },
        to: { ...base(), image: { repository: REPO3, tag: "def" } },
      }),
    ).toBe(true);
  });

  it("returns true when only the image REPOSITORY changes (profile/repo switch)", () => {
    expect(
      isImageRoll({
        kind: "update",
        gatewayId: "walter",
        from: { ...base(), image: { repository: REPO3, tag: "abc" } },
        to: { ...base(), image: { repository: USER_REPO, tag: "abc" } },
      }),
    ).toBe(true);
  });

  it("returns false for a replicas-only (pause/resume) update — must still apply in place", () => {
    expect(
      isImageRoll({
        kind: "update",
        gatewayId: "default",
        from: { ...base(), replicas: 1 },
        to: { ...base(), replicas: 0 },
      }),
    ).toBe(false);
  });

  it("returns false for a config-only update at the same image (egress/builderAccess)", () => {
    expect(
      isImageRoll({
        kind: "update",
        gatewayId: "walter",
        from: { ...base(), builderAccess: { controlUiEnabled: false } },
        to: { ...base(), builderAccess: { controlUiEnabled: true } },
      }),
    ).toBe(false);
  });

  it("returns false on create and drift (only a live in-place upgrade can drop sessions)", () => {
    expect(isImageRoll({ kind: "create", gatewayId: "x", to: base() })).toBe(false);
    expect(isImageRoll({ kind: "drift", gatewayId: "x", current: base() })).toBe(false);
  });
});
