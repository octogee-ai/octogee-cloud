import { platformStateUserAccountReader } from "../platform-state-user-accounts.js";
import type { UserAccountReader } from "../user-account.js";
import { accountSizingKeyReader, type SizingKeyReader } from "../sizing-key.js";
import { platformStateStore } from "./platform-state-store.js";

let installed: UserAccountReader | undefined;

export function installUserAccounts(reader: UserAccountReader): void {
  installed = reader;
}

export function userAccounts(): UserAccountReader {
  installed ??= platformStateUserAccountReader(platformStateStore);
  return installed;
}

export const readSizingKey: SizingKeyReader = accountSizingKeyReader({ get: (uid) => userAccounts().get(uid) });
