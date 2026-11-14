import type { Firestore } from "firebase-admin/firestore";
import type { GatewaySizingProfile } from "./platform-state/config.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
import type { PlatformStateStore, Stored } from "./platform-state/store.js";
export type SizingKeyReader = (uid: string, now: number) => Promise<string | null>;
export declare function firestoreSizingKeyReader(db: Pick<Firestore, "doc">): SizingKeyReader;
export declare class SizingKeyChangedError extends Error {
    readonly uid: string;
    constructor(uid: string);
}
export interface CurrentSizingKey {
    readonly sizingKey: string | null;
    readonly profile: GatewaySizingProfile | null;
    readonly assertCurrent: (user: Stored<PlatformUserRecord> | null) => void;
}
export declare function withCurrentSizingKey<T>(input: {
    store: PlatformStateStore;
    readSizingKey: SizingKeyReader;
    uid: string;
    now: number;
}, run: (current: CurrentSizingKey) => Promise<T>): Promise<T>;
