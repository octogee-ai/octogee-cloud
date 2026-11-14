export type ConnectorCaptureMethod = 'oauth-web' | 'device' | 'pat' | 'fields' | 'local-pairing';
export type ConnectorConsumption = 'platform-read' | 'agent-runtime';
export type ConnectorFamily = 'code-hosting' | 'deploy-hosting' | 'registry' | 'ai' | 'cloud' | 'productivity';
export type ConnectorId = 'github' | 'vercel' | 'netlify' | 'cloudflare' | 'npm' | 'docker' | 'openai' | 'anthropic' | 'openrouter' | 'grok' | 'minimax' | 'openai-compatible' | 'gemini' | 'aws' | 'gcp' | 'azure' | 'google' | 'microsoft' | 'obsidian' | 'yahoo';
export interface ConnectorCaptureField {
    key: string;
    label: string;
    placeholder?: string;
    secret?: boolean;
    multiline?: boolean;
}
export interface ConnectorMeta {
    id: ConnectorId;
    displayName: string;
    tagline: string;
    family: ConnectorFamily;
    captureMethods: ConnectorCaptureMethod[];
    consumption: ConnectorConsumption;
    scopes: string[];
    agentRuntimeMaterializable?: boolean;
    captureFields?: ConnectorCaptureField[];
    implemented: boolean;
}
export type GoogleCapability = 'calendar' | 'gmail' | 'drive' | 'tasks' | 'contacts';
export declare const GOOGLE_CAPABILITY_ORDER: readonly GoogleCapability[];
export declare const GOOGLE_CAPABILITY_SCOPES: Record<GoogleCapability, string[]>;
export declare const GOOGLE_IDENTITY_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
export declare const GOOGLE_DRIVE_FULL_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export declare const GOOGLE_OAUTH_REVOCATION_URL = "https://oauth2.googleapis.com/revoke";
export declare const CONNECTOR_OAUTH_REVOCATION_TARGETS: readonly [{
    readonly connectorId: 'google';
    readonly revocationUrl: "https://oauth2.googleapis.com/revoke";
}];
export declare function googleAuthRequestScopes(capability: GoogleCapability): string[];
export declare function googleCapabilitiesFromScopes(granted: readonly string[] | null | undefined): GoogleCapability[];
export declare const GOOGLE_SCOPES: string[];
export declare function googleEscalationRequestScopes(escalation: string): string[] | null;
export declare function googleDriveFullReadGranted(granted: readonly string[] | null | undefined): boolean;
export interface GooglePickedFile {
    id: string;
    name: string;
    mimeType: string;
}
export declare function parseGooglePickedFiles(value: unknown): GooglePickedFile[];
export declare const MICROSOFT_SCOPES: string[];
export declare const CONNECTOR_CATALOG: readonly ConnectorMeta[];
export type IntegrationStatus = 'connected' | 'disconnected' | 'error' | 'pending';
export interface IntegrationStatusDoc {
    provider: string;
    status: IntegrationStatus;
    accountLabel?: string;
    scopes?: string[];
    captureMethod?: ConnectorCaptureMethod;
    pickedFiles?: GooglePickedFile[];
    error?: string;
    connectedAt: number | null;
    updatedAt: number;
    verifiedAt: number | null;
}
export interface IntegrationStatusResponse {
    integrations: Record<string, IntegrationStatusDoc>;
}
