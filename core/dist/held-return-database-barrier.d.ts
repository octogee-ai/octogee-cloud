type OperatorRole = {
    name: string;
    oid: string;
};
type StoreSchema = {
    name: string;
    oid: string;
};
interface WriterScope {
    sourceGatewayId: string;
    schemas: string[];
    trustedOperators: OperatorRole[];
}
export interface HeldDatabaseWriterScope extends WriterScope {
    uid: string;
}
export interface HeldSharedDatabaseWriterScope {
    gatewayId: string;
    emptyPeer?: {
        gatewayId: string;
        assertPlacementExcluded: Current;
    };
    owners: {
        uid: string;
        schemas: string[];
    }[];
    trustedOperators: OperatorRole[];
}
export interface HeldDatabaseWriterBinding {
    databaseOid: string;
    ownerOid: string;
    roleOid: string;
    previousLimit: number;
    schemas: StoreSchema[];
}
type Current = () => Promise<void>;
type CheckBinding = (scope: HeldDatabaseWriterScope, binding: HeldDatabaseWriterBinding, current: Current) => Promise<void>;
export interface HeldReturnDatabaseBarrier {
    inspect(scope: HeldDatabaseWriterScope, current: Current): Promise<HeldDatabaseWriterBinding>;
    hold: CheckBinding;
    verify: CheckBinding;
    drainIdle: CheckBinding;
    restore: CheckBinding;
}
export declare function heldReturnDatabaseBarrier(adminDsn: string, roleFor: (kind: string, id: string) => string, credentialLock: string): HeldReturnDatabaseBarrier;
export type HeldSharedDatabaseBinding = {
    writers: HeldDatabaseWriterBinding[];
};
type RunWhileHeld = <T>(scope: HeldSharedDatabaseWriterScope, binding: HeldSharedDatabaseBinding, current: Current, work: (assertHeld: Current) => Promise<T>) => Promise<T>;
export interface HeldSharedDatabaseBarrier {
    inspect(scope: HeldSharedDatabaseWriterScope, current: Current): Promise<HeldSharedDatabaseBinding>;
    hold(scope: HeldSharedDatabaseWriterScope, binding: HeldSharedDatabaseBinding, current: Current): Promise<void>;
    drainIdle(scope: HeldSharedDatabaseWriterScope, binding: HeldSharedDatabaseBinding, current: Current): Promise<void>;
    restore(scope: HeldSharedDatabaseWriterScope, binding: HeldSharedDatabaseBinding, current: Current): Promise<void>;
    runWhileHeld: RunWhileHeld;
}
export declare function heldSharedDatabaseBarrier(adminDsn: string, roleFor: (kind: string, id: string) => string, credentialLock: string): HeldSharedDatabaseBarrier;
export {};
