import { linkSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function replaceFileAtomically(path: string, contents: string, mode = 0o600): void {
  publishFile(path, contents, mode, renameSync);
}

export function seedFileAtomically(path: string, contents: string, mode = 0o600): void {
  publishFile(path, contents, mode, (pending, destination) => {
    try {
      linkSync(pending, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  });
}

function publishFile(path: string, contents: string, mode: number, publish: (pending: string, destination: string) => void): void {
  const staging = mkdtempSync(join(dirname(path), ".octogee-write-"));
  try {
    const pending = join(staging, "pending");
    writeFileSync(pending, contents, { encoding: "utf8", flag: "wx", mode });
    publish(pending, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
