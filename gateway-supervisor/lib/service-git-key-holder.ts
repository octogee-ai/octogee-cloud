import * as fs from "node:fs";
import * as path from "node:path";
import { CUSTOMER_KEYS_DIR } from "./config.js";

const SERVICE_KEY_HOLDER_FILE = "service-holder";

function holderPath(slug: string): string {
  return path.join(CUSTOMER_KEYS_DIR, slug, SERVICE_KEY_HOLDER_FILE);
}

export function serviceGitKeyHolder(slug: string): string | null {
  try {
    return fs.readFileSync(holderPath(slug), "utf-8").trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function recordServiceGitKeyHolder(slug: string, gatewayId: string): void {
  fs.writeFileSync(holderPath(slug), `${gatewayId}\n`, { mode: 0o600 });
}

export function clearServiceGitKeyHolder(slug: string): void {
  fs.rmSync(holderPath(slug), { force: true });
}
