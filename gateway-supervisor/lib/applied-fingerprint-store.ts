import * as fs from "node:fs";
import { replaceFileAtomically } from "./atomic-file.js";

// On-disk mirror of the reconcile's applied-fingerprint bookkeeping. Persistence keeps
// a container restart with the emptyDir intact from forgetting what was applied; a
// missing entry is treated as STALE, so forgetting would mean
// a needless-but-harmless re-ensure sweep, never a masked change.
//
// Corrupt or missing files load as empty — every mounted user then re-ensures once,
// which is the post-roll convergence sweep, not a failure mode.

export function loadAppliedFingerprints(filePath: string): Map<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  const map = new Map<string, string>();
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [slug, fp] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof fp === "string" && fp.length > 0) map.set(slug, fp);
    }
  }
  return map;
}

export function saveAppliedFingerprints(filePath: string, applied: ReadonlyMap<string, string>): void {
  replaceFileAtomically(filePath, JSON.stringify(Object.fromEntries(applied)));
}
