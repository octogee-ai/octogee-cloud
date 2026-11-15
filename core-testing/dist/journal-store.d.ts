import { type GatewaySizingProfile } from "@octogee/shared/types/sizing-profile";
import { type PlatformStateStore } from "@octogee/core/platform-state";
export interface JournalRows {
    get(id: string): Record<string, unknown> | undefined;
    set(id: string, row: Record<string, unknown>): void;
}
export declare function journalRowsIn(records: Record<string, Record<string, unknown>>): JournalRows;
export declare function journalRowsAtPaths(records: Map<string, Record<string, unknown>> | Record<string, Record<string, unknown> | undefined>): JournalRows;
export interface FixtureDocuments {
    get(path: string): Record<string, unknown> | undefined;
    set(path: string, row: Record<string, unknown>): void;
    delete(path: string): void;
    children(collectionPath: string): ReadonlyArray<readonly [string, Record<string, unknown>]>;
    group(collectionId: string): ReadonlyArray<readonly [string, Record<string, unknown>]>;
    descendants?(documentPath: string): readonly string[];
}
export type FixtureDocumentRecords = Map<string, Record<string, unknown>> | Record<string, Record<string, unknown> | undefined>;
export declare function fixtureDocumentsAt(records: FixtureDocumentRecords): FixtureDocuments;
export declare const FIXTURE_SIZING_PROFILES: Record<string, GatewaySizingProfile>;
export declare function seedFixtureSizingProfiles(db: {
    doc(path: string): {
        set(data: Record<string, unknown>, options: {
            merge: boolean;
        }): Promise<unknown>;
    };
}): Promise<void>;
export interface JournalFixtureOptions {
    readonly transactionFailure?: Error;
    readonly documents?: FixtureDocuments;
    readonly beforeTransaction?: (label: string) => void;
    readonly serializeTransactions?: boolean;
}
export declare function createDocumentFixtureStore(records: FixtureDocumentRecords, options?: Omit<JournalFixtureOptions, "documents">): PlatformStateStore;
export declare function createJournalFixtureStore(rows: JournalRows, options?: JournalFixtureOptions): PlatformStateStore;
