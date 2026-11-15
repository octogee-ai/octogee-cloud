export type ForwardReason = "matched-identity" | "system-event" | "non-event-frame" | "unparseable";
export type DropReason = "identity-mismatch" | "missing-identity" | "invalid-payload" | "unknown-event-class";
export type FrameDecision = {
    forward: true;
    reason: ForwardReason;
} | {
    forward: false;
    reason: DropReason;
};
export interface FilterContext {
    expectedAgentId: string;
    sessionKey?: string;
}
export declare const PER_USER_EVENTS: Set<string>;
export declare function sanitizeActivityFrame(raw: string): string;
export declare function shouldForwardFrame(rawFrame: string, ctx: FilterContext): FrameDecision;
export declare class ExpectedAgentIdError extends Error {
    readonly name = "ExpectedAgentIdError";
    constructor(message: string);
}
interface FirestoreLike {
    doc(path: string): {
        get(): Promise<{
            exists: boolean;
            data: () => Record<string, unknown> | undefined;
        }>;
    };
}
export declare function deriveExpectedAgentId(uid: string, userData: Record<string, unknown>): string;
export declare function resolveExpectedAgentId(db: FirestoreLike, uid: string): Promise<string>;
export {};
