import { describe, expect, it } from "vitest";

import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { resolveRedeemGatewayUrl } from "./openclaw-runtime-broker.js";

const LEGACY_URL = "ws://retired-gateway.octogee-test.svc.cluster.local:18789";
const RUNTIME_URL = "ws://octogee-gateway-default.octogee-test.svc.cluster.local:18789";

function assignmentDoc(gatewayId = "default"): Record<string, unknown> {
  return { uid: "u1", slug: "acme", gatewayId, source: "onboarding" };
}

function desiredDoc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId: "default",
    desiredRelease: 7,
    latestRelease: 7,
    liveRelease: 7,
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
    ...extra,
  };
}

function runtimeDoc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    docKind: "runtime",
    gatewayId: "default",
    release: 7,
    lifecycle: "serving",
    heartbeat: { internalUrl: RUNTIME_URL },
    ...extra,
  };
}

async function resolveWith(
  gatewayData: Record<string, unknown> | undefined,
  documents: Record<string, Record<string, unknown> | undefined> = {},
) {
  const store = createDocumentFixtureStore({ ...documents, "gateways/default": gatewayData });
  return resolveRedeemGatewayUrl({ tx: store, gatewayId: "default", gateway: await store.gateways.roots.get("default") });
}

describe("resolveRedeemGatewayUrl", () => {
  it("rejects a legacy heartbeat without a durable gateway root", async () => {
    await expect(resolveWith(undefined, { "glmGateways/default": runtimeDoc({ heartbeat: { internalUrl: LEGACY_URL } }) }))
      .resolves.toEqual({ error: "gateway-root-invalid" });
  });

  it("requires a live release even when a user assignment exists", async () => {
    await expect(resolveWith(desiredDoc({ liveRelease: null }), {
      "gateways/default/assignments/u1": assignmentDoc(),
      "glmGateways/default": runtimeDoc(),
    })).resolves.toEqual({ error: "gateway-url-unresolved" });
  });

  it("uses the bound gateway runtime and ignores a flat root URL", async () => {
    await expect(resolveWith(desiredDoc({ internalUrl: LEGACY_URL }), {
      "gateways/default/assignments/u1": assignmentDoc(),
      "glmGateways/default": runtimeDoc(),
    })).resolves.toEqual({ url: RUNTIME_URL });
  });

  it("resolves the live runtime without a user assignment", async () => {
    await expect(resolveWith(desiredDoc({ internalUrl: LEGACY_URL }), { "glmGateways/default": runtimeDoc() }))
      .resolves.toEqual({ url: RUNTIME_URL });
  });

  it("resolves only an empty retired co-owner mirror on the desired root", async () => {
    await expect(resolveWith(desiredDoc({ coOwnerUids: [] }), { "glmGateways/default": runtimeDoc() }))
      .resolves.toEqual({ url: RUNTIME_URL });
    await expect(resolveWith(desiredDoc({ coOwnerUids: ["uid-former-helper"] }), { "glmGateways/default": runtimeDoc() }))
      .resolves.toEqual({ error: "gateway-root-invalid" });
  });

  it("rejects an unrealized gateway instead of dialing a flat root URL", async () => {
    const result = await resolveWith(desiredDoc({ internalUrl: LEGACY_URL, liveRelease: null }));
    expect("error" in result).toBe(true);
  });

  it("rejects an existing incomplete root instead of treating its flat URL as legacy", async () => {
    const result = await resolveWith({
      gatewayId: "default",
      desiredRelease: 7,
      latestRelease: 7,
      desiredStatus: "running",
      internalUrl: LEGACY_URL,
    });

    expect(result).toEqual({ error: "gateway-root-invalid" });
  });

  it("rejects a missing root", async () => {
    await expect(resolveWith(undefined)).resolves.toEqual({ error: "gateway-root-invalid" });
  });

  it("fails closed on a root stored under another gateway's id", async () => {
    await expect(resolveWith(desiredDoc({ gatewayId: "other" }))).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it.each([
    ["missing runtime", undefined],
    ["non-runtime registry document", { gatewayId: "default", lifecycle: "serving", heartbeat: { internalUrl: RUNTIME_URL } }],
    ["failed runtime", runtimeDoc({ lifecycle: "failed" })],
    ["retired runtime", runtimeDoc({ lifecycle: "retired" })],
    ["retired timestamp", runtimeDoc({ retiredAt: 1 })],
    ["missing URL", runtimeDoc({ heartbeat: {} })],
    ["empty URL", runtimeDoc({ heartbeat: { internalUrl: "" } })],
  ])("rejects a %s", async (_name, runtime) => {
    const result = await resolveWith(desiredDoc(), { "glmGateways/default": runtime });
    expect(result).toHaveProperty("error");
  });

  it("fails closed on a runtime stored under another gateway's id", async () => {
    await expect(resolveWith(desiredDoc(), { "glmGateways/default": runtimeDoc({ gatewayId: "other" }) }))
      .rejects.toBeInstanceOf(MalformedRecordError);
  });
});
