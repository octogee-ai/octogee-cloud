import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import type { GatewaySizingProfile } from "@octogee/shared/types/sizing-profile";
import type { PlatformUserRecord } from "./platform-state/users.js";
import type { PlatformStateStore, Stored } from "./platform-state/store.js";
import type { UserAccountReader } from "./user-account.js";

export type SizingKeyReader = (uid: string, now: number) => Promise<string | null>;

export function accountSizingKeyReader(accounts: Pick<UserAccountReader, "get">): SizingKeyReader {
  return async (uid, now) => {
    const account = await accounts.get(uid);
    return account === null ? null : userEntitlements().sizingKey(account.planInputs, new Date(now));
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
