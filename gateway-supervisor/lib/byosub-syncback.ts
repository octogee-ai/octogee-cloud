import { createHash } from "crypto";

export interface AuthFingerprint {
  sha256: string;
  size: number;
}

export function fingerprintCredential(credential: string | null): AuthFingerprint | null {
  if (credential === null) return null;
  const buf = Buffer.from(credential, "utf-8");
  return {
    sha256: createHash("sha256").update(buf).digest("hex"),
    size: buf.length,
  };
}

export function decideSyncBack(
  prev: AuthFingerprint | null,
  cur: AuthFingerprint | null,
): { changed: boolean; reason: string } {
  if (!cur) return { changed: false, reason: "credential absent" };
  if (!prev) return { changed: true, reason: "first observation" };
  if (prev.sha256 !== cur.sha256) {
    return { changed: true, reason: "content changed (token rotated)" };
  }
  return { changed: false, reason: "unchanged" };
}

export interface SyncBackTarget {
  agentId: string;
  readCredential: () => string | null | Promise<string | null>;
}

export interface SyncBackResult {
  pushed: number;
  observed: number;
  failed: number;
  prev: Map<string, AuthFingerprint | null>;
}

export async function syncBackSweep(opts: {
  targets: SyncBackTarget[];
  prev: Map<string, AuthFingerprint | null>;
  mode: "observe" | "active";
  pushCredential?: (agentId: string, payload: string) => Promise<void>;
  logFn?: (m: string) => void;
}): Promise<SyncBackResult> {
  const log = opts.logFn ?? (() => {});
  const prev = new Map(opts.prev);
  let pushed = 0;
  let observed = 0;
  let failed = 0;
  for (const t of opts.targets) {
    const credential = await t.readCredential();
    const cur = fingerprintCredential(credential);
    const d = decideSyncBack(prev.get(t.agentId) ?? null, cur);
    if (!d.changed || !cur || credential === null) continue;
    if (opts.mode === "observe") {
      observed++;
      prev.set(t.agentId, cur);
      log(
        `byosub-syncback[observe]: ${t.agentId} ${d.reason} sha=${cur.sha256.slice(0, 12)} size=${cur.size}`,
      );
      continue;
    }
    try {
      if (opts.pushCredential) await opts.pushCredential(t.agentId, credential);
      pushed++;
      prev.set(t.agentId, cur); 
      log(`byosub-syncback[active]: pushed ${t.agentId} (${d.reason})`);
    } catch (e) {
      failed++;
      log(
        `byosub-syncback[active]: WARN push failed for ${t.agentId} — ${(e as Error).message}`,
      );
    }
  }
  return { pushed, observed, failed, prev };
}
