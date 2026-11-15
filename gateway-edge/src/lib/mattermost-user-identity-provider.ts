import type { UserAccountsRepository, UserRecordsRepository } from "@octogee/core/platform-state";
import { mattermostBearerVerifier, type UserIdentityProvider } from "@octogee/core/user-identity-provider";
import { userDataWithUserState } from "@octogee/core/identity/user-platform-state";

export interface PlatformUserStore {
  readonly users: {
    readonly records: Pick<UserRecordsRepository, "get" | "findByMattermostUserId">;
    readonly accounts: Pick<UserAccountsRepository, "get">;
  };
}

export function platformStateUserLoader(store: PlatformUserStore): UserIdentityProvider["loadUser"] {
  return async (uid) => {
    const [record, account] = await Promise.all([store.users.records.get(uid), store.users.accounts.get(uid)]);
    if (record === null) return null;
    return userDataWithUserState(account === null ? {} : { username: account.name, email: account.email }, record);
  };
}

export function mattermostUserIdentityProvider(options: {
  readonly mattermostUrl: string;
  readonly store: PlatformUserStore;
  readonly fetch?: typeof fetch;
}): UserIdentityProvider {
  return {
    verifyBearer: mattermostBearerVerifier({
      mattermostUrl: options.mattermostUrl,
      users: { findByMattermostUserId: (mattermostUserId) => options.store.users.records.findByMattermostUserId(mattermostUserId) },
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    loadUser: platformStateUserLoader(options.store),
  };
}
