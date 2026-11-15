import type { PlatformUserRecord, PlatformStateStore } from "../platform-state/index.js";
type UserDocument = Record<string, unknown>;
export declare function storedForm(value: unknown): unknown;
export declare function userDataWithUserState(userData: UserDocument, user: PlatformUserRecord | null): UserDocument;
export declare function accountActiveInStore(uid: string, store?: Pick<PlatformStateStore, "users">): Promise<boolean>;
export {};
