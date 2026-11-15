import path from "node:path";

export function openClawDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCLAW_DIR?.trim();
  if (configured) return configured;
  const home = env.HOME?.trim();
  return home ? path.join(home, ".openclaw") : "/home/node/.openclaw";
}

export function openClawConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCLAW_CONFIG_PATH?.trim();
  return configured || path.join(openClawDir(env), "openclaw.json");
}
