import { fileURLToPath } from "node:url";
import { installUserEntitlements, staticUserEntitlements } from "@octogee/shared/types/user-entitlements";

process.env.OCTOGEE_DEPLOYMENT_TARGETS = fileURLToPath(new URL("./src/fixtures/deployment-targets.json", import.meta.url));

installUserEntitlements(staticUserEntitlements);

for (const name of ["ANTHROPIC_BASE_URL", "OPENROUTER_BASE_URL", "PLATFORM_OPENAI_BASE_URL", "PLATFORM_VERTEX_BASE_URL"]) {
  delete process.env[name];
}
process.env.PUBLIC_APP_ORIGINS ||= "https://octogee.com,https://app.octogee.com";
