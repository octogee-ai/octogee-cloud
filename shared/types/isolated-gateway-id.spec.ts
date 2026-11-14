import { describe, expect, it } from "vitest";

import {
  isolatedGatewayIdForSlug,
  isolatedGatewayId,
} from "./isolated-gateway-id";
import { isValidNewGatewayId } from "./glm";

describe("isolatedGatewayIdForSlug", () => {
  it("uses builder-<slug> when the canonical slug fits the gateway id contract", () => {
    expect(isolatedGatewayIdForSlug("jack")).toBe("builder-jack");
  });

  it("shortens long slugs and appends a stable hash without leaving the gateway id contract", () => {
    const first = isolatedGatewayIdForSlug("this-is-a-very-long-builder-slug");
    const second = isolatedGatewayIdForSlug("this-is-a-very-long-builder-slug");
    expect(first).toBe(second);
    expect(first).toMatch(/^builder-this-is-a-ver-[0-9a-f]{8}$/u);
    expect(isValidNewGatewayId(first)).toBe(true);
  });

  it("rejects a value that is not a canonical user slug", () => {
    expect(() => isolatedGatewayIdForSlug("Chris user")).toThrow("invalid user slug");
    expect(() => isolatedGatewayIdForSlug("chris--user")).toThrow("invalid user slug");
  });
});

describe("isolatedGatewayId", () => {
  it("binds the identity to one activation generation", () => {
    const first = isolatedGatewayId("jack", 1, "lease-one", "s");
    const retry = isolatedGatewayId("jack", 1, "lease-one", "s");
    const next = isolatedGatewayId("jack", 2, "lease-two", "s");

    expect(first).toBe(retry);
    expect(next).not.toBe(first);
    expect(isValidNewGatewayId(first)).toBe(true);
    expect(isValidNewGatewayId(next)).toBe(true);
  });

  it("names the runtime by shortened slug and instance size for pod listings", () => {
    expect(isolatedGatewayId("jack", 1, "lease-one", "s")).toMatch(
      /^jack-s-[0-9a-f]{8}$/u,
    );
    expect(isolatedGatewayId("jack", 1, "lease-one", "m")).toMatch(
      /^jack-m-[0-9a-f]{8}$/u,
    );
  });

  it("rejects a sizing tier outside the catalog", () => {
    expect(() =>
      isolatedGatewayId("jack", 1, "lease-one", "xxl" as never),
    ).toThrow("invalid isolated runtime sizing tier");
  });

  it("keeps long and reserved-looking slugs inside the new-gateway contract", () => {
    for (const slug of [
      "this-is-a-very-long-builder-slug",
      "builder-with-green",
      "builder-with-blue",
    ]) {
      const gatewayId = isolatedGatewayId(slug, 999_999, "lease-collision-seed", "s");
      expect(gatewayId.length).toBeLessThanOrEqual(32);
      expect(gatewayId).toContain("-s-");
      expect(isValidNewGatewayId(gatewayId)).toBe(true);
    }
  });
});
