import { describe, expect, it, vi } from "vitest";
import { releasePayloadHash } from "@octogee/shared/types/gateway-releases";
import { inspectSharedReleaseInputs } from "../inspect-installed-shared.js";

const payload = { imageRepository: "registry/octogee-gateway", imageTag: `1234567@sha256:${"a".repeat(64)}` };
const requested = { ...payload, imageTag: `7654321@sha256:${"a".repeat(64)}` };
const gateway = {
  gatewayId: "shared-aaaaaaaaaaaa", createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
  configSchemaVersion: 1, desiredStatus: "running", latestRelease: 1, desiredRelease: 1, liveRelease: 1,
  gatewayClass: "shared", imageProfile: "standard", profile: null, sizingTier: null, gcpProject: null,
  gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
  ownerUid: null, builderSlug: null, modelBrokerLimits: null,
};

describe("installed Shared release inspection command", () => {
  it("returns the controller's exact platform hash and only matching members", async () => {
    const matches = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const second = { ...gateway, gatewayId: "shared-bbbbbbbbbbbb" };
    expect(await inspectSharedReleaseInputs([{ gateway, payload }, { gateway: second, payload }], requested, matches)).toEqual({
      platformArtifactHash: releasePayloadHash(requested), gatewayIds: [gateway.gatewayId],
    });
    expect(matches).toHaveBeenCalledWith(gateway, payload, requested);
  });

  it.each([null, [null], [{}], [{ gateway: { ...gateway, latestRelease: -1 }, payload }],
    [{ gateway: { ...gateway, gatewayClass: "isolated" }, payload }], [{ gateway, payload: {} }],
  ].map(rows => [rows]))("rejects an invalid request before reading Helm %#", async rows => {
    const matches = vi.fn();
    await expect(inspectSharedReleaseInputs(rows, requested, matches)).rejects.toThrow();
    expect(matches).not.toHaveBeenCalled();
  });
});
