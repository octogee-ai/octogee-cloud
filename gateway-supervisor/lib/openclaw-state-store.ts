import * as fs from "node:fs";
import * as path from "node:path";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

export type LocalStateStoreKind = "absent" | "anchor" | "sqlite";

export function clusterIsolatedGateway(env: NodeJS.ProcessEnv): boolean {
  return isIsolatedGatewayClassValue(env.GATEWAY_CLASS) && env.GATEWAY_RUNTIME_KIND === "cluster";
}

export function openclawStateRoot(env: NodeJS.ProcessEnv): string {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) return stateDir;
  const openclawDir = env.OPENCLAW_DIR?.trim();
  return openclawDir || path.join(env.HOME ?? "/home/node", ".openclaw");
}

export function localStateStorePath(stateRoot: string): string {
  return path.join(stateRoot, "state", "openclaw.sqlite");
}

export function clientCredentialStorePath(stateRoot: string): string {
  return path.join(stateRoot, "client", "credentials.sqlite");
}

export function localStateStoreKind(file: string): LocalStateStoreKind {
  if (!fs.existsSync(file)) return "absent";
  return readPostgresAgentAnchor(file) ? "anchor" : "sqlite";
}
