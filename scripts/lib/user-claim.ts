import { DEFAULT_OPENCLAW_DIR, readUserClaim } from "@octogee/shared/server/user-claim";
import type { ConfiguredUserReport } from "@octogee/shared/types/fleet-controller";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

export function configuredUserReport(env: NodeJS.ProcessEnv = process.env): ConfiguredUserReport | null {
  if (!isIsolatedGatewayClassValue(env.GATEWAY_CLASS)) return null;
  const claim = readUserClaim(env.OPENCLAW_DIR?.trim() || DEFAULT_OPENCLAW_DIR, env.GATEWAY_ID?.trim() || undefined);
  return claim ? { state: "claimed", generation: claim.generation } : null;
}
