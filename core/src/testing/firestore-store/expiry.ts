import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import type { ExpirySweepResult } from "../../platform-state/store.js";
import { FIRESTORE_FAILED_PRECONDITION, FIRESTORE_NOT_FOUND, firestoreErrorCode } from "./transaction.js";

export const FIRESTORE_ACCESS_GRANT_COLLECTIONS = [
  "gatewayTickets",
  "openclawControlTickets",
  "openclawControlSessions",
] as const;

async function deleteUnchanged(snapshot: QueryDocumentSnapshot): Promise<boolean> {
  try {
    await snapshot.ref.delete({ lastUpdateTime: snapshot.updateTime });
    return true;
  } catch (error) {
    const code = firestoreErrorCode(error);
    if (code === FIRESTORE_FAILED_PRECONDITION || code === FIRESTORE_NOT_FOUND) return false;
    throw error;
  }
}

async function sweepExpiredAccessGrants(db: Firestore, now: number, limit: number): Promise<number> {
  let deleted = 0;
  for (const collection of FIRESTORE_ACCESS_GRANT_COLLECTIONS) {
    const remaining = limit - deleted;
    if (remaining <= 0) break;
    const expired = await db.collection(collection).where("expiresAt", "<", now).limit(remaining).get();
    const outcomes = await Promise.all(expired.docs.map(deleteUnchanged));
    deleted += outcomes.filter(Boolean).length;
  }
  return deleted;
}

export async function sweepExpiredFirestoreState(db: Firestore, now: number, limit: number): Promise<ExpirySweepResult> {
  return {
    operations: 0,
    operationAudits: 0,
    accessGrants: await sweepExpiredAccessGrants(db, now, limit),
    modelBrokerUsageEvents: 0,
    subscriptionFlows: 0,
    connectFlows: 0,
  };
}
