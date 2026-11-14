import type { PlatformStateStore } from "@octogee/core/platform-state";
import { userAccountDocument } from "@octogee/core/platform-state-user-accounts";
import type { SizingKeyReader } from "@octogee/core/sizing-key";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";

type UserDocument = Record<string, unknown>;

export interface UserDocuments {
  account(uid: string): Promise<UserDocument | undefined>;
  agent(uid: string): Promise<UserDocument | undefined>;
  systemConfig(uid: string): Promise<UserDocument | undefined>;
}

export function platformStateUserDocuments(store: Pick<PlatformStateStore, "users">): UserDocuments {
  return {
    account: async (uid) => {
      const record = await store.users.accounts.get(uid);
      return record === null ? undefined : userAccountDocument(record);
    },
    agent: async () => undefined,
    systemConfig: async () => undefined,
  };
}

export function userDocumentsSizingKeyReader(documents: Pick<UserDocuments, "account">): SizingKeyReader {
  return async (uid, now) => {
    const account = await documents.account(uid);
    return account === undefined ? null : userEntitlements().sizingKey(account, new Date(now));
  };
}
