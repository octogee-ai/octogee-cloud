import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("vm-gateway-agent");
import { chown, mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { runVmGatewayAgent } from "../lib/vm-gateway-agent/agent.js";
import { createDockerEngine } from "../lib/vm-gateway-agent/docker-engine.js";
import { createDesktopControl } from "../lib/vm-gateway-agent/desktop-control.js";
import { createHomeFs, homeShell } from "../lib/vm-gateway-agent/home-fs.js";
import { createMetadataClient } from "../lib/vm-gateway-agent/metadata.js";
import { createSurgeOpenClawProcessSupervisorClient } from "../lib/surge-openclaw-process-gate.js";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const log = runtimeLogger.info;
const stateRoot = process.env.VM_STATE_ROOT?.trim() || "/srv/octogee";
await runVmGatewayAgent(
  {
    gatewayId: requireEnv("GATEWAY_ID"),
    apiUrl: requireEnv("OCTOGEE_API_URL").replace(/\/$/, ""),
    stateRoot,
    engine: createDockerEngine({ socketPath: process.env.DOCKER_SOCKET?.trim() || "/var/run/docker.sock" }),
    holdOpenClaw: async (openclawDir) => { await createSurgeOpenClawProcessSupervisorClient(openclawDir).holdNormal(); },
    metadata: createMetadataClient(),
    fetchImpl: fetch,
    fs: {
      mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
      writeFile: (path, content, mode) => writeFile(path, content, { mode }),
      readFile: (path) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
      chown,
      diskUsage: async (path) => {
        const stats = await statfs(path);
        return { sizeBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
      },
    },
    home: { shell: homeShell, fs: createHomeFs(stateRoot), desktop: createDesktopControl() },
    now: () => Date.now(),
    log,
    logError: runtimeLogger.error,
  },
  {
    intervalMs: Number(process.env.VM_AGENT_INTERVAL_MS ?? 30_000),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
);
