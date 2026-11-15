export declare const GITEA_URL: string;
export declare function getToken(): string;
export declare function giteaApi(org: string, path: string, method?: string, body?: unknown): Promise<unknown>;
export declare function giteaApiAs(token: string, org: string, path: string, method?: string, body?: unknown): Promise<unknown>;
export declare function giteaApiAsAllowNotFound(token: string, org: string, path: string, method?: string, body?: unknown): Promise<unknown | null>;
export declare function giteaApiAsUser(sudoUser: string, org: string, path: string, method?: string, body?: unknown): Promise<unknown>;
export declare function giteaApiAsUserAllowNotFound(sudoUser: string, org: string, path: string, method?: string, body?: unknown): Promise<unknown | null>;
export declare function giteaDeleteRepo(org: string, repo: string): Promise<void>;
export declare function giteaGetRepo(org: string, repo: string): Promise<unknown | null>;
export declare function giteaDeleteVerifiedRepo(org: string, repo: string): Promise<void>;
export declare function createProjectGiteaRepo(org: string, repoName: string, description: string, privateRepo: boolean): Promise<boolean>;
export declare function giteaWriteFile(org: string, repoName: string, filePath: string, content: string, commitMessage: string): Promise<void>;
export declare function giteaWriteFiles(org: string, repoName: string, files: ReadonlyArray<{
    path: string;
    content: string;
}>, commitMessage: string): Promise<void>;
export declare function giteaWriteFilesIfAllAbsent(org: string, repoName: string, files: ReadonlyArray<{
    path: string;
    content: string;
}>, commitMessage: string): Promise<void>;
