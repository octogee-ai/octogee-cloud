import { describe, expect, it, vi } from "vitest";
import { releaseGitKeysBeforeRootDelete } from "./gateway-root-deletion.js";

function gate(releaseGatewayGitKeys: (gatewayId: string) => Promise<unknown>) {
  return { client: { releaseGatewayGitKeys: vi.fn(releaseGatewayGitKeys) as never }, log: vi.fn() };
}

describe("releasing a gateway's git keys before its root is deleted", () => {
  it("proves the release for that gateway once the provisioning service holds none of its rows", async () => {
    const keys = gate(async () => ({ remaining: 0 }));

    const release = await releaseGitKeysBeforeRootDelete(keys, "builder-jack");

    expect(keys.client.releaseGatewayGitKeys).toHaveBeenCalledWith("builder-jack");
    expect(release).toEqual({ outcome: "released", proof: expect.objectContaining({ gatewayId: "builder-jack" }) });
  });

  it("keeps the root while the provisioning service still holds rows for the gateway", async () => {
    const release = await releaseGitKeysBeforeRootDelete(gate(async () => ({ remaining: 3 })), "builder-jack");

    expect(release).toEqual({ outcome: "kept", reason: "the provisioning service still holds 3 git key rows for builder-jack" });
  });

  it.each([[{}], [{ remaining: "0" }], [{ remaining: -1 }], [{ remaining: 0.5 }], [null]])("keeps the root when the release answers %j instead of a count of remaining rows", async (body) => {
    const release = await releaseGitKeysBeforeRootDelete(gate(async () => body), "builder-jack");

    expect(release).toEqual({ outcome: "kept", reason: expect.stringContaining("did not answer how many git key rows remain for builder-jack") });
  });

  it("keeps the root and names the failure when the release request fails", async () => {
    const release = await releaseGitKeysBeforeRootDelete(gate(async () => { throw new Error("503 unavailable"); }), "builder-jack");

    expect(release).toEqual({ outcome: "kept", reason: "releasing the git keys of builder-jack failed: 503 unavailable" });
  });

  it("proves the release without a request when no provisioning service is configured, and says so in the log", async () => {
    const log = vi.fn();

    await expect(releaseGitKeysBeforeRootDelete({ client: null, log }, "builder-jack"))
      .resolves.toEqual({ outcome: "released", proof: expect.objectContaining({ gatewayId: "builder-jack" }) });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("no provisioning service is configured, so the root of builder-jack is deleted without releasing git keys"));
  });
});
