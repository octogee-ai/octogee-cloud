import type { FleetBrokerAssignmentRosterEntry, FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import { snapshotConfigFingerprint } from "@octogee/core/user-snapshot-mapping";
import type { MountLane } from "./reconcile-loop.js";

export { snapshotConfigFingerprint };

// One roster fetch drives BOTH convergence inputs: the fingerprint map the reconcile
// compares, and the adapter snapshot cache the triggered ensure reads. Seeding them from
// the same snapshot is the invariant that makes a re-ensure apply exactly the content its
// fingerprint described — the broker adapter's cache has no TTL, so without the seed a
// drift-triggered ensure would re-apply the boot-time state while the bookkeeping records
// the new fingerprint as applied.
export interface DesiredUser {
  uid: string;
  fingerprint: string;
  lane: MountLane;
  ensureAllowed: boolean;
}

export function desiredUsers(
  users: readonly FleetBrokerUserSnapshot[],
  assignments: readonly FleetBrokerAssignmentRosterEntry[],
  seedSnapshot?: (snapshot: FleetBrokerUserSnapshot) => void,
): Map<string, DesiredUser> {
  const byUid = new Map(assignments.map((entry) => [entry.uid, entry]));
  const joined = users.map((user) => {
    const assignment = byUid.get(user.uid);
    if (!assignment) throw new Error(`missing canonical assignment for ${user.uid}`);
    return { user, assignment };
  });
  const map = new Map<string, DesiredUser>();
  for (const { user, assignment } of joined) {
    seedSnapshot?.(user);
    map.set(user.slug, {
      uid: user.uid,
      fingerprint: snapshotConfigFingerprint(user),
      lane: user.status === "complete" ? "move" : "create",
      ensureAllowed: assignment.state !== "quiescing" && !assignment.restorePending && !user.restoreAuthority,
    });
  }
  return map;
}
