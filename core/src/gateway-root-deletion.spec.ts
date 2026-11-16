import { describe, expect, it, vi } from "vitest";
import { releaseGitKeysBeforeRootDelete } from "./gateway-root-deletion.js";

describe("releasing a gateway's git keys before its root is deleted", () => {
  it("proves the release for that gateway once the provisioning service holds none of its rows", async () => {
    const keys = { releaseGatewayGitKeys: vi.fn(async () => ({ remaining: 0 })) };

    const release = await releaseGitKeysBeforeRootDelete(keys, "builder-jack");

    expect(keys.releaseGatewayGitKeys).toHaveBeenCalledWith("builder-jack");
    expect(release).toEqual({ outcome: "released", proof: expect.objectContaining({ gatewayId: "builder-jack" }) });
  });

  it("keeps the root while the provisioning service still holds rows for the gateway", async () => {
    const release = await releaseGitKeysBeforeRootDelete({ releaseGatewayGitKeys: async () => ({ remaining: 3 }) }, "builder-jack");

    expect(release).toEqual({ outcome: "kept", reason: "the provisioning service still holds 3 git key rows for builder-jack" });
  });

  it("keeps the root and names the failure when the release request fails", async () => {
    const release = await releaseGitKeysBeforeRootDelete({ releaseGatewayGitKeys: async () => { throw new Error("503 unavailable"); } }, "builder-jack");

    expect(release).toEqual({ outcome: "kept", reason: "releasing the git keys of builder-jack failed: 503 unavailable" });
  });

  it("proves the release without a request when no provisioning service is configured", async () => {
    await expect(releaseGitKeysBeforeRootDelete(null, "builder-jack"))
      .resolves.toEqual({ outcome: "released", proof: expect.objectContaining({ gatewayId: "builder-jack" }) });
  });
});
