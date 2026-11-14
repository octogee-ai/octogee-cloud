import type { Firestore } from "firebase-admin/firestore";

import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import type { GatewaySizingProfile } from "./platform-state/config.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
import type { PlatformStateStore, Stored } from "./platform-state/store.js";

export type SizingKeyReader = (uid: string, now: number) => Promise<string | null>;

export function firestoreSizingKeyReader(db: Pick<Firestore, "doc">): SizingKeyReader {
  return async (uid, now) => {
    const snapshot = await db.doc(`users/${uid}`).get();
    return snapshot.exists ? userEntitlements().sizingKey(snapshot.data() ?? {}, new Date(now)) : null;
  };
}

const SIZING_KEY_READ_ATTEMPTS = 3;

export class SizingKeyChangedError extends Error {
  constructor(readonly uid: string) {
    super(`User ${uid} changed while its sizing key was read`);
    this.name = "SizingKeyChangedError";
  }
}

export interface CurrentSizingKey {
  readonly sizingKey: string | null;
  readonly profile: GatewaySizingProfile | null;
  readonly assertCurrent: (user: Stored<PlatformUserRecord> | null) => void;
}

export async function withCurrentSizingKey<T>(
  input: { store: PlatformStateStore; readSizingKey: SizingKeyReader; uid: string; now: number },
  run: (current: CurrentSizingKey) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const revision = (await input.store.users.records.get(input.uid))?.revision ?? null;
    const sizingKey = await input.readSizingKey(input.uid, input.now);
    const profile = sizingKey === null ? null : await input.store.config.orchestrator.getSizingProfile(sizingKey);
    const assertCurrent = (user: Stored<PlatformUserRecord> | null): void => {
      if ((user?.revision ?? null) !== revision) throw new SizingKeyChangedError(input.uid);
    };
    try {
      return await run({ sizingKey, profile, assertCurrent });
    } catch (error) {
      if (!(error instanceof SizingKeyChangedError) || attempt === SIZING_KEY_READ_ATTEMPTS) throw error;
    }
  }
}
