import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { log, OPENCLAW_DIR } from "./config.js";

export interface PreStopMarker {
  file: string;
  podId: string;
}

export function podPreStopMarker(openclawDir: string = OPENCLAW_DIR): PreStopMarker {
  return {
    file: path.join(openclawDir, "prestop-started"),
    podId: process.env.POD_UID?.trim() || os.hostname(),
  };
}

export function markPreStopStarted(marker: PreStopMarker = podPreStopMarker()): void {
  fs.writeFileSync(marker.file, `${marker.podId}\n`, { mode: 0o600 });
}

export function clearPreStopStarted(marker: PreStopMarker = podPreStopMarker()): void {
  fs.rmSync(marker.file, { force: true });
}

export function clearLeftoverPreStopMarker(marker: PreStopMarker = podPreStopMarker()): void {
  try {
    clearPreStopStarted(marker);
  } catch (error) {
    log(
      `[prestop-marker] a prestop marker left by an earlier container could not be removed, so no key is resynced on this pod: ${error instanceof Error ? error.message : String(error)}`,
      { status: "failed" },
    );
  }
}

export function preStopStarted(marker: PreStopMarker = podPreStopMarker()): boolean {
  try {
    return fs.readFileSync(marker.file, "utf-8").trim() === marker.podId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
