import { describe, expect, it } from "vitest";
import { normalizeTenantPolicyPath } from "./tenant-route-policy.js";

describe("normalizeTenantPolicyPath", () => {
  it("lowercases paths and removes trailing slashes while preserving root", () => {
    expect(normalizeTenantPolicyPath("/API/Notifications/INGEST/")).toBe("/api/notifications/ingest");
    expect(normalizeTenantPolicyPath("/api/workspaces///")).toBe("/api/workspaces");
    expect(normalizeTenantPolicyPath("/")).toBe("/");
  });
});
