import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PRESTOP_STARTED_FILE = path.join(os.tmpdir(), "octogee-gateway-prestop-started");

export function markPreStopStarted(file: string = PRESTOP_STARTED_FILE): void {
  fs.writeFileSync(file, `${new Date().toISOString()}\n`);
}

export function clearPreStopStarted(file: string = PRESTOP_STARTED_FILE): void {
  fs.rmSync(file, { force: true });
}

export function preStopStarted(file: string = PRESTOP_STARTED_FILE): boolean {
  return fs.existsSync(file);
}
