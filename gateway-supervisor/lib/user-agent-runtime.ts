import fs from "node:fs";
import path from "node:path";

export function userAgentRuntimePresent(agentsDir: string, slug: string): boolean {
  const agentDir = path.join(agentsDir, `octogee-${slug}-coach`, "agent");
  try {
    const stat = fs.lstatSync(agentDir);
    return !stat.isDirectory() || fs.readdirSync(agentDir).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
