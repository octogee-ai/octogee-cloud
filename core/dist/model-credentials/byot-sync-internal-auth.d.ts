export declare const MODEL_CREDENTIAL_SYNC_TIMESTAMP_HEADER = "x-byot-sync-timestamp";
export declare const MODEL_CREDENTIAL_SYNC_SIGNATURE_HEADER = "x-byot-sync-signature";
export declare function validModelCredentialSyncPublicKey(key: string): boolean;
export declare function createModelCredentialSyncAuthHeaders(args: {
    body: unknown;
    gatewayId: string;
    secret: string;
    nowMs?: number;
}): Record<string, string>;
export declare function isValidModelCredentialSyncSignature(args: {
    body: unknown;
    gatewayId: string;
    publicKey: string;
    timestamp: string | undefined;
    signature: string | undefined;
    nowMs?: number;
}): boolean;
