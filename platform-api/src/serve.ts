import http from "node:http";
import type { Express } from "express";
import { platformStateStore } from "../../gateway-edge/src/lib/platform-state.js";
import { logger } from "../../gateway-edge/src/middleware/logging.js";
import { createGracefulShutdown } from "./lib/graceful-shutdown.js";
import { mattermostChannelHostFromEnv } from "@octogee/core/channel-host";
import { controlUiCommandUrl, convergeControlUiCommands } from "@octogee/core/mattermost/control-ui-command";

async function convergeControlUiCommandsAtBoot(): Promise<void> {
  try {
    const summary = await convergeControlUiCommands({
      host: mattermostChannelHostFromEnv(),
      url: controlUiCommandUrl(process.env.K8S_NAMESPACE),
      isWorkspaceTeam: async (teamId) =>
        (await platformStateStore.workspaces.records.findByMattermostTeamId(teamId)) !== null,
      log: (message, meta) => logger.error(message, meta ?? {}),
    });
    logger.info("[mattermost] /ui command convergence finished", { ...summary });
  } catch (error) {
    logger.warn("[mattermost] /ui command convergence did not run", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function serveApi(app: Express): void {
  const port = parseInt(process.env.PORT || "3001", 10);
  const server = app.listen(port, () => {
    (app.locals.attachUpgradeHandlers as ((s: http.Server) => void) | undefined)?.(server);
    logger.info(`octogee-api boot — listening on port ${port}`, {
      port,
      env: process.env.K8S_NAMESPACE || "local",
      sha: process.env.BUILD_SHA || "unknown",
      node: process.version,
    });
    void convergeControlUiCommandsAtBoot();
  });
  const shutdown = createGracefulShutdown({
    server,
    flushPostHog: app.locals.productShutdown as (() => Promise<void>) | undefined,
    closePlatformState: () => platformStateStore.close(),
    onError(message, error) {
      process.exitCode = 1;
      logger.error(message, { error });
    },
  });
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
}
