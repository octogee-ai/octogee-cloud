import type { Stored, WatchAggregate, WatchRecords, WatchRequest } from "../store.js";
import type { Row, SqlParameters } from "./sql.js";
export type FilterKeys = Readonly<Record<string, readonly unknown[]>>;
export interface PostgresWatchSource<A extends WatchAggregate> {
    readonly aggregate: A;
    readonly operation: string;
    readonly recordKey?: string;
    selectAll(parameters: SqlParameters): string;
    selectKeys(keys: readonly string[], parameters: SqlParameters): string;
    keyOf(row: Row): string;
    decode(row: Row): Stored<WatchRecords[A]>;
    mayMatch(filterKeys: FilterKeys): boolean;
}
export declare function postgresWatchSource<A extends WatchAggregate>(request: WatchRequest<A>): PostgresWatchSource<A>;
