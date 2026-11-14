import { platformStateUserAccountReader } from "@octogee/core/platform-state-user-accounts";
import type { UserAccountReader } from "@octogee/core/user-account";
import { accountSizingKeyReader, type SizingKeyReader } from "@octogee/core/sizing-key";
import { platformStateStore } from "./platform-state.js";

let installed: UserAccountReader | undefined;

export function installUserAccounts(reader: UserAccountReader): void {
  installed = reader;
}

export function userAccounts(): UserAccountReader {
  installed ??= platformStateUserAccountReader(platformStateStore);
  return installed;
}

export const readSizingKey: SizingKeyReader = accountSizingKeyReader({ get: (uid) => userAccounts().get(uid) });
