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

export const NEEDS_FULL_ATTACH_FINGERPRINT = "";

const IMPORT_RECONCILE_PENDING_SUFFIX = "!import-reconcile-pending";

export function importReconciliationPending(fingerprint: string): boolean {
  return fingerprint.includes(IMPORT_RECONCILE_PENDING_SUFFIX);
}

export function pendingImportAppliedFingerprint(fingerprint: string): string | undefined {
  const suffix = [PENDING_CLONE_FINGERPRINT_SUFFIX, IMPORT_RECONCILE_PENDING_SUFFIX]
    .find(candidate => fingerprint.endsWith(candidate));
  const base = suffix ? fingerprint.slice(0, -suffix.length) : fingerprint;
  if (!/^[0-9a-f]{16}$/.test(base)) return undefined;
  return base + IMPORT_RECONCILE_PENDING_SUFFIX;
}
