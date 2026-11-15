import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { readFile, rm } from "fs/promises";
import path from "path";
import type { ClaudeSsoChild, ClaudeSsoDeps } from "./claude-sso-auth.js";
import { isSafeAgentId } from "./byosub-restore.js";
import { internalFetch } from "./internal-fetch.js";

export interface ClaudeSsoIoConfig {
  openclawDir: string;
  internalServiceKey: string;
  gatewayEdgeBaseUrl?: string;
  claudeBin?: string;
  log?: (m: string) => void;
}

function stripTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function defaultOctogeeApiBaseUrl(): string {
  const configured = process.env.OCTOGEE_API_URL;
  if (configured) return stripTrailingSlash(configured);
  const ns = process.env.K8S_NAMESPACE ?? "octogee";
  return `http://octogee-api.${ns}.svc.cluster.local:3001`;
}

export function claudeSsoStagingHomeDir(
  openclawDir: string,
  agentId: string,
): string {
  return path.join(
    openclawDir,
    "agents",
    agentId,
    "agent",
    "claude-home.sso-staging",
  );
}

export function claudeSsoCredentialsPath(
  openclawDir: string,
  agentId: string,
): string {
  return path.join(claudeSsoStagingHomeDir(openclawDir, agentId), ".claude", ".credentials.json");
}

export function realClaudeSsoDeps(cfg: ClaudeSsoIoConfig): ClaudeSsoDeps {
  const base = cfg.gatewayEdgeBaseUrl
    ? stripTrailingSlash(cfg.gatewayEdgeBaseUrl)
    : defaultOctogeeApiBaseUrl();
  const claudeBin = cfg.claudeBin ?? "claude";
  const log = cfg.log ?? (() => {});
  return {
    now: () => Date.now(),
    log: cfg.log,
    spawnClaudeSso: (agentId: string): ClaudeSsoChild => {
      if (!isSafeAgentId(agentId)) {
        throw new Error(
          `refusing to spawn Claude SSO for unsafe agentId ${JSON.stringify(agentId.slice(0, 80))}`,
        );
      }
      const stagingHome = claudeSsoStagingHomeDir(cfg.openclawDir, agentId);
      mkdirSync(stagingHome, { recursive: true, mode: 0o700 });
      const child = spawn(claudeBin, ["auth", "login", "--sso"], {
        env: {
          ...process.env,
          HOME: stagingHome,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      return {
        onStdout: (cb) => {
          child.stdout?.on("data", (d: Buffer) => cb(d.toString("utf8")));
          child.stderr?.on("data", (d: Buffer) => cb(d.toString("utf8")));
        },
        onExit: (cb) => {
          let fired = false;
          const fire = (code: number) => {
            if (fired) return;
            fired = true;
            cb(code);
          };
          child.on("exit", (code) => fire(code ?? -1));
          child.on("error", (err: Error) => {
            log(`claude-sso: child error for ${agentId} — ${err.message}`);
            fire(-1);
          });
        },
        writeStdin: (value) => {
          child.stdin?.write(value);
        },
        kill: () => {
          child.kill("SIGTERM");
        },
      };
    },
    readCredentials: async (agentId: string): Promise<string | null> => {
      if (!isSafeAgentId(agentId)) return null;
      try {
        return await readFile(
          claudeSsoCredentialsPath(cfg.openclawDir, agentId),
          "utf8",
        );
      } catch {
        return null;
      }
    },
    discardStaged: async (agentId: string) => {
      if (!isSafeAgentId(agentId)) return;
      await rm(claudeSsoStagingHomeDir(cfg.openclawDir, agentId), {
        recursive: true,
        force: true,
      });
    },
    postCapture: async (flowId: string, credential: string) => {
      try {
        const r = await internalFetch(`${base}/api/model-credentials/subscription/capture`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flowId, credential }),
        }, {
          internalServiceKey: cfg.internalServiceKey,
        });
        if (!r.ok) {
          const body = (await r.text().catch(() => "")).slice(0, 200);
          return { ok: false, reason: `capture ${r.status} ${body}` };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
  };
}
