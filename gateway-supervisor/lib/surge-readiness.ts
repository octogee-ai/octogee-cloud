import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const MARKER = ".surge-handoff-ready.json";

export interface SurgeReadinessGate {
  released: () => Promise<boolean>;
  release: (input: { targetPodUid: string }) => Promise<void>;
  hold: () => Promise<void>;
}

function markerMatchesPod(value: unknown, expectedPodUid: string | undefined): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const targetPodUid = (value as { targetPodUid?: unknown }).targetPodUid;
  if (typeof targetPodUid !== "string" || !targetPodUid) return false;
  return expectedPodUid === undefined || targetPodUid === expectedPodUid;
}

export function createSurgeReadinessGate(
  openclawDir: string,
  expectedPodUid?: string,
): SurgeReadinessGate {
  const markerPath = path.join(openclawDir, MARKER);
  return {
    hold: () => fs.rm(markerPath, { force: true }),
    async released() {
      try {
        const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
        return markerMatchesPod(marker, expectedPodUid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        if (error instanceof SyntaxError) return false;
        throw error;
      }
    },
    async release({ targetPodUid }) {
      await fs.mkdir(openclawDir, { recursive: true });
      const tempPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify({ targetPodUid }), {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(tempPath, markerPath);
    },
  };
}
