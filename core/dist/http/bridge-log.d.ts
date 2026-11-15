export type BridgeLogSeverity = "info" | "warn";
export type BridgeLog = (message: string, severity?: BridgeLogSeverity) => void;
export interface BridgeLogDependencies {
    now?: () => Date;
    info?: (message: string) => void;
    warn?: (message: string) => void;
}
export declare function createBridgeLog(deps?: BridgeLogDependencies): BridgeLog;
