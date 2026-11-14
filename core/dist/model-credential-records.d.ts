import type { ModelCredentialRecord, SubscriptionLinkRecord, UserRepositories } from "./platform-state/users.js";
type Document = Record<string, unknown>;
export declare function modelCredentialConfig(record: ModelCredentialRecord | null): Document | undefined;
export declare function readModelCredentialConfig(users: Pick<UserRepositories, "modelCredentials">, uid: string): Promise<Document | undefined>;
export declare function modelCredentialActive(record: ModelCredentialRecord | null): boolean;
export declare function subscriptionIntegration(links: readonly SubscriptionLinkRecord[]): Document | undefined;
export declare function readSubscriptionIntegration(users: Pick<UserRepositories, "subscriptionLinks">, uid: string): Promise<Document | undefined>;
export {};
