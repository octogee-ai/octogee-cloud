type OperatorRole = {
    name: string;
    oid: string;
};
type StoreSchema = {
    name: string;
    oid: string;
};
export interface HeldDatabaseWriterScope {
    uid: string;
    sourceGatewayId: string;
    schemas: string[];
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
export {};
