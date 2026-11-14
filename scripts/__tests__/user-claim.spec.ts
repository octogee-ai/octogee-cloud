import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  userClaimFromIdentity,
  markUserClaimOverlayApplied,
  readUserClaim,
  writeUserClaim,
} from "@octogee/shared/server/user-claim";
import type { ClaimedUserIdentity } from "../../shared/types/user-identity.js";
import { configuredUserReport } from "../lib/user-claim.js";
import { projectCheckoutScopeForRuntime } from "../lib/user-lifecycle-broker-adapter.js";
import { markOwnedBootOverlayApplied } from "../entrypoints/user-claim.js";
import { runSystemConfigRestore } from "../entrypoints/system-config-restore.js";

const GATEWAY = "b-alice";
const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-user-claim-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function identity(overrides: Partial<ClaimedUserIdentity> = {}): ClaimedUserIdentity {
  return {
    gatewayId: GATEWAY, state: "claimed", ownerUid: "uid-alice", builderSlug: "alice",
    leaseId: "lease-1", generation: 4, ...overrides,
  };
}

function env(openclawDir: string): NodeJS.ProcessEnv {
  return { GATEWAY_CLASS: "isolated", OPENCLAW_DIR: openclawDir, GATEWAY_ID: GATEWAY };
}

describe("configured user report", () => {
  it("reports a claimed boot as claimed for its generation from the start", () => {
    const dir = tempDir();
    expect(configuredUserReport(env(dir))).toBeNull();
    writeUserClaim(dir, userClaimFromIdentity(identity(), 1_000));
    expect(configuredUserReport(env(dir))).toEqual({ state: "claimed", generation: 4 });
    markUserClaimOverlayApplied(dir, GATEWAY, 2_000);
    expect(configuredUserReport(env(dir))).toEqual({ state: "claimed", generation: 4 });
  });

  it("reports a VM claim with no lease generation as claimed", () => {
    const dir = tempDir();
    writeUserClaim(dir, userClaimFromIdentity(identity({ leaseId: null, generation: null }), 1_000));
    expect(configuredUserReport(env(dir))).toEqual({ state: "claimed", generation: null });
  });

  it("reports nothing for a Shared gateway", () => {
    const dir = tempDir();
    writeUserClaim(dir, userClaimFromIdentity(identity(), 1_000));
    expect(configuredUserReport({ ...env(dir), GATEWAY_CLASS: "shared" })).toBeNull();
  });
});

describe("user-claim entrypoint", () => {
  it("stamps a claimed boot's overlay before OpenClaw starts and refuses an unclaimed one", () => {
    const dir = tempDir();
    expect(() => markOwnedBootOverlayApplied(env(dir), () => 5)).toThrow("has no user claim");
    writeUserClaim(dir, userClaimFromIdentity(identity(), 1_000));
    expect(markOwnedBootOverlayApplied(env(dir), () => 5)).toBe("alice");
    expect(readUserClaim(dir, GATEWAY)?.overlayAppliedAt).toBe(5);
  });
});

describe("claimed boot", () => {
  it("checks out the claimed user's projects into its home once the claim exists", () => {
    const dir = tempDir();
    expect(projectCheckoutScopeForRuntime("alice", env(dir))).not.toBe("workspace-and-projects");
    writeUserClaim(dir, userClaimFromIdentity(identity(), 1_000));
    expect(projectCheckoutScopeForRuntime("alice", env(dir))).toBe("workspace-and-projects");
  });

  it("restores the claimed user's checkout in place", async () => {
    const dir = tempDir();
    writeUserClaim(dir, userClaimFromIdentity(identity(), 1_000));
    markUserClaimOverlayApplied(dir, GATEWAY, 2_000);
    fs.mkdirSync(path.join(dir, "system_config", ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, "system_config", "openclaw.json"), "{\"owner\":true}\n");
    const configPath = path.join(dir, "system_config", "openclaw.json");
    const restore = vi.fn(async () => ({ seeded: false, restored: true, configPath }));

    await runSystemConfigRestore({ env: env(dir), log: () => {}, restore });

    expect(restore).toHaveBeenCalledWith("alice", { log: expect.any(Function), openclawDir: dir });
    expect(fs.readFileSync(configPath, "utf8")).toBe("{\"owner\":true}\n");
    expect(readUserClaim(dir, GATEWAY)).toMatchObject({ overlayAppliedAt: 2_000 });
  });
});
