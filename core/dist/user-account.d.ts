import type { Firestore } from "firebase-admin/firestore";
export interface UserAccount {
    readonly uid: string;
    readonly username: string | null;
    readonly email: string | null;
    readonly displayName: string | null;
    readonly lastActive: number | null;
    readonly planInputs: Readonly<Record<string, unknown>>;
    readonly usage: Readonly<Record<string, unknown>>;
    readonly mattermostUsername: string | null;
}
export interface UserAccountReader {
    get(uid: string): Promise<UserAccount | null>;
    getMany(uids: readonly string[]): Promise<ReadonlyMap<string, UserAccount>>;
    list(): Promise<ReadonlyMap<string, UserAccount>>;
}
type Data = Record<string, unknown>;
export declare function userAccountFromData(uid: string, data: Data): UserAccount;
export declare function firestoreUserAccountReader(db: Pick<Firestore, "collection" | "getAll">): UserAccountReader;
export declare const noUserAccounts: UserAccountReader;
export {};
