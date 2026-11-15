export interface SweepStuckReleasesDeps {
  // Revision ids whose Helm release is currently in a pending-* state.
  listPending: () => Promise<string[]>;
  // A pending release is eligible only when it is a canonical, non-retired
  // revision with a valid, non-retired durable root. Bare legacy ids are
  // intentionally excluded: the explicit legacy cleanup owns those releases.
  isRecoverableRevision: (revisionId: string) => Promise<boolean>;
  // Recover one stuck stable release (rollback-to-last-good / uninstall-stuck-first-install).
  recover: (revisionId: string) => Promise<string>;
  now: () => number;
  // A release must be CONTINUOUSLY pending for this long before we recover it.
  // Set comfortably > the helm `--wait` upgrade timeout so a legitimately
  // in-progress install/upgrade is never mistaken for a wedge.
  staleMs: number;
  log: (msg: string) => void;
}

export interface SweepStuckReleasesResult {
  pending: number;
  recovered: number;
  skipped: number;
}

// Heal orphaned helm wedges: a release left `pending-*` by an interrupted
// install/upgrade (e.g. the controller redeployed mid-`helm upgrade`) that no
// operation ever re-upserts — so the upsert pre-flight recovery never fires and it
// silently blocks rolls. `firstSeenPending` survives across ticks (held by
// startHelmRecoverySweeper) so a release must be pending for `staleMs` *continuously*
// before we touch it. The map is in-memory, so a controller restart resets the clock
// — intentionally: it makes the sweeper wait for stability rather than fight a
// deploy storm mid-burst.
// eslint-disable-next-line sonarjs/cognitive-complexity
export async function sweepStuckReleasesOnce(
  deps: SweepStuckReleasesDeps,
  firstSeenPending: Map<string, number>,
): Promise<SweepStuckReleasesResult> {
  let pending: string[];
  try {
    pending = await deps.listPending();
  } catch (err) {
    deps.log(
      `[helm-recovery-sweeper] ⚠ listPending failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { pending: 0, recovered: 0, skipped: 0 };
  }

  const recoverablePending: string[] = [];
  let skipped = 0;
  for (const revisionId of pending) {
    try {
      if (await deps.isRecoverableRevision(revisionId)) {
        recoverablePending.push(revisionId);
      } else {
        skipped += 1;
        deps.log(
          `[helm-recovery-sweeper] skipping unmanaged pending release ${revisionId}; legacy cleanup owns bare releases`,
        );
      }
    } catch (err) {
      skipped += 1;
      deps.log(
        `[helm-recovery-sweeper] cannot validate pending release ${revisionId} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const pendingSet = new Set(recoverablePending);
  // Releases that recovered/settled on their own: drop them so their clock resets.
  for (const gw of [...firstSeenPending.keys()]) {
    if (!pendingSet.has(gw)) firstSeenPending.delete(gw);
  }

  const now = deps.now();
  let recovered = 0;
  for (const revisionId of recoverablePending) {
    const firstSeen = firstSeenPending.get(revisionId);
    if (firstSeen === undefined) {
      firstSeenPending.set(revisionId, now); // first sighting — start the staleness clock
      continue;
    }
    if (now - firstSeen < deps.staleMs) continue; // pending, but not long enough yet

    deps.log(
      `[helm-recovery-sweeper] ${revisionId} stuck pending for ${Math.round((now - firstSeen) / 60_000)}m (no op re-upserting it) — recovering`,
    );
    try {
      const action = await deps.recover(revisionId);
      deps.log(`[helm-recovery-sweeper] ✅ recovered ${revisionId}: ${action}`);
      recovered += 1;
      firstSeenPending.delete(revisionId);
    } catch (err) {
      deps.log(
        `[helm-recovery-sweeper] ⚠ recover ${revisionId} failed — ${err instanceof Error ? err.message : String(err)} (retrying after staleMs)`,
      );
      firstSeenPending.set(revisionId, now); // back off a full staleMs before the next attempt
    }
  }
  return { pending: recoverablePending.length, recovered, skipped };
}

export interface StartHelmRecoverySweeperDeps extends SweepStuckReleasesDeps {
  intervalMs: number;
  runTick?: (
    deps: SweepStuckReleasesDeps,
    state: Map<string, number>,
  ) => Promise<SweepStuckReleasesResult>;
}

export function startHelmRecoverySweeper(deps: StartHelmRecoverySweeperDeps): () => void {
  const tick = deps.runTick ?? sweepStuckReleasesOnce;
  const firstSeenPending = new Map<string, number>();
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    (async () => {
      try {
        await tick(deps, firstSeenPending);
      } catch (err) {
        deps.log(
          `[helm-recovery-sweeper] ⚠ tick failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  }, deps.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
