import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { OPENCLAW_DIR } from "./config.js";

export interface PreStopMarker {
  file: string;
  podId: string;
}

export function podPreStopMarker(): PreStopMarker {
  return {
    file: path.join(OPENCLAW_DIR, "prestop-started"),
    podId: process.env.POD_UID?.trim() || os.hostname(),
  };
}

export function markPreStopStarted(marker: PreStopMarker = podPreStopMarker()): void {
  fs.writeFileSync(marker.file, `${marker.podId}\n`, { mode: 0o600 });
}

export function clearPreStopStarted(marker: PreStopMarker = podPreStopMarker()): void {
  fs.rmSync(marker.file, { force: true });
}

export function preStopStarted(marker: PreStopMarker = podPreStopMarker()): boolean {
  try {
    return fs.readFileSync(marker.file, "utf-8").trim() === marker.podId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
