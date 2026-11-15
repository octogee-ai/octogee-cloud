import { describe, expect, it } from "vitest";

import { revisionIdFromGatewayPodName } from "./gateway-pod-revision.js";

describe("revisionIdFromGatewayPodName", () => {
  it("resolves the bare gateway id from the stable-name Deployment's pod name", () => {
    expect(revisionIdFromGatewayPodName(
      "default",
      "octogee-gateway-default-5bc5949d46-p946t",
    )).toBe("default");
    // Legacy revision-suffixed pods resolve too — the suffix is just part of the
    // generated pod name under the bare prefix.
    expect(revisionIdFromGatewayPodName(
      "default",
      "octogee-gateway-default-r27-5bc5949d46-p946t",
    )).toBe("default");
  });

  it("refuses cross-gateway and malformed pod identities", () => {
    expect(revisionIdFromGatewayPodName("default", undefined)).toBeNull();
    expect(revisionIdFromGatewayPodName("default", "octogee-gateway-default")).toBeNull();
    expect(revisionIdFromGatewayPodName(
      "default",
      "octogee-gateway-other-5bc5949d46-p946t",
    )).toBeNull();
    expect(revisionIdFromGatewayPodName("default", "octogee-gateway-default-")).toBeNull();
  });
});
