import { pathToFileURL } from "node:url";
import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { DEFAULT_OPENCLAW_DIR, markUserClaimOverlayApplied } from "@octogee/shared/server/user-claim";

const runtimeLogger = createServiceLogger("builder-claim");

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function markOwnedBootOverlayApplied(env: NodeJS.ProcessEnv, now: () => number = Date.now): string {
  const claim = markUserClaimOverlayApplied(
    env.OPENCLAW_DIR?.trim() || DEFAULT_OPENCLAW_DIR,
    required(env, "GATEWAY_ID"),
    now(),
  );
  return claim.builderSlug;
}

async function main(argv: string[]): Promise<number> {
  const [mode] = argv;
  if (mode === "mark-overlay-applied") {
    const slug = markOwnedBootOverlayApplied(process.env);
    runtimeLogger.info(`[user-claim] overlay applied for ${slug} before OpenClaw starts`);
    return 0;
  }
  throw new Error("usage: user-claim.ts mark-overlay-applied");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error: unknown) => {
    runtimeLogger.error(`[user-claim] Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
