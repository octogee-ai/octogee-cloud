import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("github-cli-auth-hydrate");
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { GithubCliAuthError, hydrateGithubCliAuth } from "../lib/github-cli-auth-hydrate.js";

export async function runGithubCliAuthConvergence(opts: {
  signal: AbortSignal;
  hydrate?: typeof hydrateGithubCliAuth;
  wait?: (signal: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): Promise<void> {
  const hydrate = opts.hydrate ?? hydrateGithubCliAuth;
  const wait = opts.wait ?? ((signal) => sleep(60_000, undefined, { signal }));
  const log = opts.log ?? runtimeLogger.info;
  const warn = opts.warn ?? runtimeLogger.error;
  let lastResult: string | undefined;
  while (!opts.signal.aborted) {
    try {
      const result = await hydrate();
      if (result === "skipped") return;
      if (result === "hydrated") log("[github-cli-auth] refreshed user GitHub CLI authentication");
      if (result === "cleared" && lastResult !== result) log("[github-cli-auth] GitHub authentication disconnected or unavailable to this user");
      lastResult = result;
    } catch (error) {
      const reason = error instanceof GithubCliAuthError ? error.message : "local filesystem, gateway credential, or network failure";
      warn(`[github-cli-auth] ${reason}; retrying in 60s`);
    }
    try {
      await wait(opts.signal);
    } catch (error) {
      if (!opts.signal.aborted) throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  await runGithubCliAuthConvergence({ signal: controller.signal });
}
