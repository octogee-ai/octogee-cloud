import { userAccountFromData, type UserAccount } from "@octogee/core/user-account";
import { installUserAccounts } from "../../lib/user-accounts.js";

export function installDocumentUserAccounts(read: (uid: string) => Record<string, unknown> | undefined): void {
  const get = async (uid: string): Promise<UserAccount | null> => {
    const data = read(uid);
    return data === undefined ? null : userAccountFromData(uid, data);
  };
  installUserAccounts({
    get,
    getMany: async (uids) => {
      const accounts = await Promise.all(uids.map(get));
      return new Map(accounts.flatMap((account) => (account === null ? [] : [[account.uid, account] as const])));
    },
    list: async () => new Map(),
  });
}
