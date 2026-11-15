#!/usr/bin/env tsx
import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("runner-metrics-exporter");

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_HEARTBEAT_DIR,
  readHeartbeats,
  type RunnerHeartbeat,
  renderPrometheus,
} from "../lib/runner-heartbeat.js";
import { openClawDir } from "../lib/openclaw-config-path.js";
import {
  readSystemConfigStatus,
  renderSystemConfigMetrics,
  type SystemConfigObservedStatus,
} from "../lib/system-config-status.js";

// Always-on (all gateway profiles) Prometheus exporter for the in-pod runner
// heartbeats. One scrape target for every supervised runner; a single
// ServiceMonitor points Prometheus here. See
// docs/specs/GATEWAY-RUNNER-OBSERVABILITY-SPEC.md.
export interface RunnerMetricsExporterOptions {
  port?: number;
  dir?: string;
  read?: (dir: string) => RunnerHeartbeat[];
  render?: (heartbeats: RunnerHeartbeat[], now: number) => string;
  now?: () => number;
  warn?: (message: string) => void;
  openclawDir?: string;
  readSystemConfig?: (openclawDir: string) => SystemConfigObservedStatus;
  renderSystemConfig?: (status: SystemConfigObservedStatus, now: number) => string;
}

export function createRunnerMetricsHandler(
  options: Omit<RunnerMetricsExporterOptions, "port" | "warn"> = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const dir = options.dir ?? process.env.OCTOGEE_RUNNER_HEARTBEAT_DIR ?? DEFAULT_HEARTBEAT_DIR;
  const read = options.read ?? readHeartbeats;
  const render = options.render ?? renderPrometheus;
  const now = options.now ?? Date.now;

  return (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url === "/metrics") {
      const observedAt = now();
      const configDir = options.openclawDir ?? openClawDir();
      const status = (options.readSystemConfig ?? readSystemConfigStatus)(configDir);
      const body = render(read(dir), observedAt) +
        (options.renderSystemConfig ?? renderSystemConfigMetrics)(status, observedAt);
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  };
}

export function createRunnerMetricsServer(
  options: Omit<RunnerMetricsExporterOptions, "port" | "warn"> = {},
): Server {
  return createServer(createRunnerMetricsHandler(options));
}

export function startRunnerMetricsExporter(options: RunnerMetricsExporterOptions = {}): Server {
  const port = options.port ?? Number(process.env.OCTOGEE_RUNNER_METRICS_PORT ?? 9092);
  const dir = options.dir ?? process.env.OCTOGEE_RUNNER_HEARTBEAT_DIR ?? DEFAULT_HEARTBEAT_DIR;
  const warn = options.warn ?? runtimeLogger.warn;
  const server = createRunnerMetricsServer({ ...options, dir });

  server.listen(port, () => {
    warn(`[runner-metrics-exporter] listening on :${port} (heartbeats: ${dir})`);
  });

  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  process.on("SIGINT", () => server.close(() => process.exit(0)));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startRunnerMetricsExporter();
}
