export declare const DISKLESS_ACTIVATION_WRITER_EXCLUDED = "diskless activation destination writer was permanently excluded";
export declare function builderActivateOperationId(gatewayId: string, generation: number): string;
export declare function builderReturnOperationId(gatewayId: string, generation: number): string;
export declare function isolatedRecoverOperationId(gatewayId: string, generation: number): string;
export declare function placementRetireOperationId(uid: string, gatewayId: string, generation: number): string;
export declare function isUserActivateOperationIdFor(operationId: unknown, gatewayId: unknown): boolean;
export declare function isUserReturnOperationIdFor(operationId: unknown, gatewayId: unknown): boolean;
