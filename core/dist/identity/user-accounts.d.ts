import type { UserAccountReader } from "../user-account.js";
import { type SizingKeyReader } from "../sizing-key.js";
export declare function installUserAccounts(reader: UserAccountReader): void;
export declare function userAccounts(): UserAccountReader;
export declare const readSizingKey: SizingKeyReader;
