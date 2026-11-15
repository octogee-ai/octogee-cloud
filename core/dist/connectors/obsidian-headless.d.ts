export interface ObsidianRemoteVault {
    id: string;
    name: string;
    region: string;
    shared: boolean;
}
export interface ObsidianConnectionConfig {
    schemaVersion: 1;
    vaultId: string;
    vaultName: string;
    headlessConfig: Record<string, unknown>;
}
export interface ObsidianCommandOptions {
    env: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
}
export interface ObsidianCommandResult {
    stdout: string;
    stderr: string;
}
export type ObsidianCommandRunner = (args: readonly string[], options: ObsidianCommandOptions) => Promise<ObsidianCommandResult>;
export declare class ObsidianHeadlessError extends Error {
    readonly code: "invalid-input" | "provider-rejected" | "runtime-failed";
    constructor(message: string, code: "invalid-input" | "provider-rejected" | "runtime-failed");
}
export declare function obsidianHeadlessEnvironment(overrides: Record<string, string>, inherited?: NodeJS.ProcessEnv): Record<string, string>;
export declare const runObsidianHeadless: ObsidianCommandRunner;
export declare function listObsidianRemoteVaults(authTokenValue: unknown, runner?: ObsidianCommandRunner): Promise<ObsidianRemoteVault[]>;
export declare function parseObsidianConnectionConfig(value: unknown): ObsidianConnectionConfig;
export declare function verifyObsidianConnection(fields: Record<string, string>, runner?: ObsidianCommandRunner): Promise<{
    accountLabel: string;
    connection: ObsidianConnectionConfig;
}>;
