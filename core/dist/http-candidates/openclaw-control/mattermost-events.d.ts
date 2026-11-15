import { WebSocket, type ClientOptions } from "ws";
export declare function watchMattermostChannelEvents(input: {
    baseUrl: string;
    token: string;
    channelId: string;
    signal: AbortSignal;
    onChange: () => void;
    createSocket?: (url: string, options: ClientOptions) => WebSocket;
}): Promise<void>;
