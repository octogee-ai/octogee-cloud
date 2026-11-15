import { type UserIdentity, type ClaimedUserIdentity } from "@octogee/shared/types/builder-identity";
type Schedule = (callback: () => void, delayMs: number) => () => void;
export interface UserIdentityStore {
    current(): UserIdentity | null;
    start(): () => void;
}
export declare const USER_IDENTITY_POLL_MS = 1000;
export declare const USER_IDENTITY_RETRY_MS = 5000;
export declare function createUserIdentityStore(input: {
    read: () => Promise<UserIdentity>;
    log: (message: string) => void;
    schedule?: Schedule;
}): UserIdentityStore;
export declare function brokerUserIdentityReader(env?: NodeJS.ProcessEnv): () => Promise<UserIdentity>;
export declare function installUserIdentityStore(store: UserIdentityStore): void;
export declare function builderIdentity(): UserIdentity | null;
export declare function claimedUserIdentity(): ClaimedUserIdentity | null;
export {};
