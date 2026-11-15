import type { MattermostTokenSecret, PlatformStateRepositories } from "../platform-state/index.js";
export declare function readMattermostSecret(store: Pick<PlatformStateRepositories, "secrets">, uid: string, secretId: string): Promise<MattermostTokenSecret | null>;
