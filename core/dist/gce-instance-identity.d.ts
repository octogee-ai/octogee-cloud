export declare const GOOGLE_TOKEN_ISSUERS: Set<string>;
export type VerifyGoogleIdToken = (idToken: string, audience: string) => Promise<Record<string, unknown> | null>;
export declare function createGoogleIdTokenVerifier(): VerifyGoogleIdToken;
export declare function computeInstanceFromPayload(payload: Record<string, unknown>, expected: {
    projectId: string;
    serviceAccountEmail: string;
}): {
    projectId: string;
    zone: string;
    instanceId: string;
    instanceName: string;
} | null;
