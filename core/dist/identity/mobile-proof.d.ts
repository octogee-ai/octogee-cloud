export declare const MOBILE_ENROLLMENT_ID: RegExp;
export declare const mobileDigest: (value: string | Buffer) => string;
export declare function mobileRecord(value: unknown): Record<string, unknown> | null;
export interface MobileConnectProof {
    deviceId: string;
    publicKey: string;
    role: 'node' | 'operator';
    scopes: string[];
    bootstrapToken?: string;
    token?: string;
}
export declare function verifyMobileConnect(frame: unknown, nonce: string, now?: number): MobileConnectProof;
export declare function mobileRoute(url: string, gatewayId: string): {
    enrollmentId: string;
    upstreamPath: string;
} | null;
export declare function isMobileMediaResource(url: URL): boolean;
export declare function projectMobileHello(frame: Record<string, unknown>, origin: string, basePath: string): Record<string, unknown>;
export declare function projectMobileDocument(html: string, basePath: string, upstreamBasePath?: string): string;
export declare function mobileDefaultAgent(sessionKey: string, deviceId: string, workspaceSlug: string): string | null;
export declare function projectMobileSessionFrame(frame: Record<string, unknown>, aliases: ReadonlyMap<string, string>): Record<string, unknown>;
