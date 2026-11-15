import { describe, it, expect } from "vitest";
import { resolveGatewayGcpProject } from "../gcp-project.js";

describe("resolveGatewayGcpProject", () => {
  it("uses the per-gateway gcpProject when set (BYO-GCP)", () => {
    expect(
      resolveGatewayGcpProject({ gcpProject: "user-acme-prod", platformDefault: "octogee" }),
    ).toBe("user-acme-prod");
  });

  it("falls back to the platform default when gcpProject is absent (cattle / today)", () => {
    expect(resolveGatewayGcpProject({ platformDefault: "octogee" })).toBe("octogee");
  });

  it("treats empty-string gcpProject as absent", () => {
    expect(
      resolveGatewayGcpProject({ gcpProject: "", platformDefault: "octogee" }),
    ).toBe("octogee");
  });

  it("throws if neither a gcpProject nor a platform default is available — never silently empty", () => {
    expect(() => resolveGatewayGcpProject({ platformDefault: "" })).toThrow(/platform/i);
  });
});
