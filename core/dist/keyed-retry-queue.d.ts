export interface KeyedRetryQueueOptions {
    readonly concurrency: number;
    readonly process: (key: string) => Promise<void>;
    readonly onError: (key: string, error: unknown, attempts: number) => void;
    readonly retryDelayMs: (attempts: number) => number;
    readonly now?: () => number;
}
export interface KeyedRetryQueue {
    enqueue(key: string): void;
    exclusive<T>(key: string, body: () => Promise<T>): Promise<T>;
    open(): void;
    stop(): void;
    settled(keys: readonly string[]): Promise<void>;
    attempted(keys: readonly string[]): Promise<void>;
    pendingCount(): number;
}
export declare function createKeyedRetryQueue(options: KeyedRetryQueueOptions): KeyedRetryQueue;
