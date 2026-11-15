import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { pathToFileURL } from "node:url";
import { userClaimSlug } from "@octogee/shared/server/user-claim";
import { cleanUserProjectPlaceholders } from "../lib/user-project-storage.js";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

const logger = createServiceLogger("user-project-cleanup");

export async function runUserProjectCleanup(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isIsolatedGatewayClassValue(env.GATEWAY_CLASS)) throw new Error("project cleanup requires an isolated runtime");
  await cleanUserProjectPlaceholders({
    openclawDir: env.OPENCLAW_DIR ?? "/home/node/.openclaw",
    slug: userClaimSlug(env) ?? "",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runUserProjectCleanup().catch(error => {
    logger.error(`User project cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
