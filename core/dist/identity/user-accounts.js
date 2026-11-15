import { platformStateUserAccountReader } from "../platform-state-user-accounts.js";
import { accountSizingKeyReader } from "../sizing-key.js";
import { platformStateStore } from "./platform-state-store.js";
let installed;
export function installUserAccounts(reader) {
    installed = reader;
}
export function userAccounts() {
    installed ??= platformStateUserAccountReader(platformStateStore);
    return installed;
}
export const readSizingKey = accountSizingKeyReader({ get: (uid) => userAccounts().get(uid) });
