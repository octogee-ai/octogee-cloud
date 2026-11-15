export interface MattermostModelPost {
    id: string;
    type: string;
    root_id: string;
    channel_id: string;
    user_id: string;
    create_at: number;
    message: string;
    update_at?: number;
    edit_at?: number;
    delete_at?: number;
    pending_post_id?: string;
    file_ids?: string[];
    props?: Record<string, unknown>;
}
export interface MattermostChannelHistoryPage {
    posts: MattermostModelPost[];
    nextBefore?: string;
    reachedEnd: boolean;
}
export interface NativeModelResult {
    outcome: "applied" | "rejected" | "unknown";
    currentModel?: string;
    providers?: string[];
    models?: string[];
}
export declare class ChannelSessionMattermostError extends Error {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined);
}
export declare function pickCorrelatedAgentReply(posts: readonly MattermostModelPost[], expected: {
    rootPostId: string;
    channelId: string;
    agentUserId: string;
    commandCreatedAt: number;
}): MattermostModelPost | null;
export declare function parseNativeModelResult(operation: string, message: string): NativeModelResult;
export declare function createChannelSessionMattermostClient(input: {
    baseUrl: string;
    token: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxResponseBytes?: number;
    signal?: AbortSignal;
}): {
    getJson: (segments: readonly string[]) => Promise<unknown>;
    postJson: (segments: readonly string[], body: unknown) => Promise<unknown>;
    uploadFiles: (channelId: string, files: readonly {
        fileName: string;
        mimeType: string;
        bytes: Buffer;
    }[]) => Promise<unknown>;
    getCurrentUserId(): Promise<string>;
    listChannelPosts(channelId: string, before?: string, perPage?: number): Promise<MattermostChannelHistoryPage>;
};
