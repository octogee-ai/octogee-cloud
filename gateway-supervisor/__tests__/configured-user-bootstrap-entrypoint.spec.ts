import { describe, expect, it, vi } from "vitest";

import {
  resolveConfiguredUserBootstrapInput,
  runConfiguredUserBootstrap,
} from "../entrypoints/configured-user-bootstrap.js";
import { withUserClaim } from "./helpers/user-claim.js";

describe("configured-builder-bootstrap entrypoint", () => {
  it("requires the gateway identity and a user claim — nothing else (identity-pure boot)", () => {
    expect(() => resolveConfiguredUserBootstrapInput({
      ...withUserClaim({}, "alice"),
      GATEWAY_ID: "",
    })).toThrow("GATEWAY_ID");
    expect(() => resolveConfiguredUserBootstrapInput({
      OPENCLAW_DIR: withUserClaim({}, "alice").OPENCLAW_DIR.concat("-empty"),
      GATEWAY_ID: "walter",
      GATEWAY_BUILDER_SLUG: "alice",
    })).toThrow("user claim");
  });

  it("hydrates the configured user from the claimed identity", async () => {
    const hydrate = vi.fn().mockResolvedValue(undefined);
    const env = withUserClaim({ GATEWAY_ID: "walter" }, "alice");
    await runConfiguredUserBootstrap({ env, hydrate });
    expect(hydrate).toHaveBeenCalledWith({
      openclawDir: env.OPENCLAW_DIR,
      gatewayId: "walter",
      slug: "alice",
    });
  });

  it("writes the Desk into the Hobby desktop home only on an X11 cluster VM", () => {
    const base = withUserClaim({ GATEWAY_ID: "walter" }, "alice");
    expect(resolveConfiguredUserBootstrapInput({ ...base, GATEWAY_RUNTIME_KIND: "cluster", GATEWAY_COMPUTER_DESKTOP: "x11" }))
      .toEqual({ openclawDir: base.OPENCLAW_DIR, gatewayId: "walter", slug: "alice", desktopHome: "/home/octo" });
    expect(resolveConfiguredUserBootstrapInput({ ...base, GATEWAY_RUNTIME_KIND: "cluster" })).not.toHaveProperty("desktopHome");
    expect(resolveConfiguredUserBootstrapInput({ ...base, GATEWAY_RUNTIME_KIND: "gce-vm", GATEWAY_COMPUTER_DESKTOP: "omarchy" })).not.toHaveProperty("desktopHome");
  });
});
