// A converge that left a project checkout absent has not reached desired state. The applied
// store records this marker instead of the real fingerprint: unequal to every real fingerprint,
// so the level-triggered reconcile keeps selecting the user, and recognisable, so the
// retry re-runs only the checkout rather than the full attach.
const PENDING_CLONE_FINGERPRINT_SUFFIX = "!clones-pending";

export function pendingCloneAppliedFingerprint(fingerprint: string | undefined): string {
  return `${fingerprint ?? ""}${PENDING_CLONE_FINGERPRINT_SUFFIX}`;
}

export function pendingCloneOnlyStale(
  applied: string | undefined,
  desired: string | undefined,
): boolean {
  return applied !== undefined && applied === pendingCloneAppliedFingerprint(desired);
}
