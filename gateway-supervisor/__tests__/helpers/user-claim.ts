import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import { userClaimFromIdentity, userClaimPath, writeUserClaim } from "@octogee/shared/server/user-claim";

export const TEST_CLAIM_GATEWAY_ID = "gw-test";

export function writeTestUserClaim(openclawDir: string, builderSlug: string, gatewayId = TEST_CLAIM_GATEWAY_ID): void {
  mkdirSync(openclawDir, { recursive: true });
  rmSync(userClaimPath(openclawDir), { force: true });
  writeUserClaim(openclawDir, userClaimFromIdentity({
    gatewayId,
    state: "claimed",
    ownerUid: `uid-${builderSlug}`,
    builderSlug,
    leaseId: null,
    generation: null,
  }, 1));
}

export function withUserClaim<T extends Record<string, string | undefined>>(
  env: T,
  builderSlug: string,
): T & { OPENCLAW_DIR: string; GATEWAY_ID: string } {
  const openclawDir = env.OPENCLAW_DIR || mkdtempSync(path.join(tmpdir(), "octogee-claim-"));
  const gatewayId = env.GATEWAY_ID?.trim() || TEST_CLAIM_GATEWAY_ID;
  writeTestUserClaim(openclawDir, builderSlug, gatewayId);
  return { ...env, OPENCLAW_DIR: openclawDir, GATEWAY_ID: gatewayId };
}

export function clearUserClaim(): void {
  if (process.env.OPENCLAW_DIR) rmSync(userClaimPath(process.env.OPENCLAW_DIR), { force: true });
}

export function stubUserClaim(builderSlug: string): void {
  if (!builderSlug) {
    clearUserClaim();
    return;
  }
  const previous = { OPENCLAW_DIR: process.env.OPENCLAW_DIR, GATEWAY_ID: process.env.GATEWAY_ID };
  const env = withUserClaim(previous, builderSlug);
  process.env.OPENCLAW_DIR = env.OPENCLAW_DIR;
  process.env.GATEWAY_ID = env.GATEWAY_ID;
  onTestFinished(() => {
    rmSync(userClaimPath(env.OPENCLAW_DIR), { force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
