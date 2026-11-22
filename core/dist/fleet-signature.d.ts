export declare function canonicalPayload(jobId: string, rawBody: string): string;
export declare function gatewayScopedJobId(jobId: string, gatewayId: string): string;
export declare function sourceActivationReadinessJobId(migrationId: string, gatewayId: string): string;
export declare function signFleetRequest(privateKeyPem: string, jobId: string, rawBody: string): string;
export declare function verifyFleetRequest(publicKeyPem: string, jobId: string, rawBody: string, headerValue: string | undefined): boolean;
export declare function heldNativeSourceReconcileJobId(migrationId: string, gatewayId: string): string;
export declare function heldNativeSourceHoldJobId(action: "acquire" | "read", operationId: string, gatewayId: string): string;
export declare function heldNativeSourceHoldAudience(action: "acquire" | "read", rawRequest: string, hold: unknown): string;
