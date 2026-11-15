export declare function clearGithubConditionalCache(): void;
export declare function invalidateGithubConditionalCacheForUrl(url: string): void;
export declare function githubContentsUrl(owner: string, repo: string, path: string): string;
export declare function githubHeaders(token: string | undefined): Record<string, string>;
export declare function isOversizeFile(file: {
    encoding?: string;
}): boolean;
export declare function githubContentsApi(owner: string, repo: string, path: string, token: string | undefined, ref?: string): Promise<unknown>;
export declare function githubCommitsApi(owner: string, repo: string, path: string, token: string | undefined, ref?: string): Promise<unknown>;
export declare function githubRepoApi(owner: string, repo: string, token: string | undefined): Promise<unknown>;
export declare function githubBranchesApi(owner: string, repo: string, token: string | undefined): Promise<unknown>;
export declare function githubTreeApi(owner: string, repo: string, ref: string, token: string | undefined): Promise<unknown>;
export declare function githubRepoUrl(owner: string, repo: string, suffix: string): string;
export declare function githubJson(method: string, url: string, token: string | undefined, body?: unknown, signal?: AbortSignal): Promise<unknown>;
export declare const GITHUB_ISSUES_PER_PAGE = 100;
export declare function githubIssuesApi(owner: string, repo: string, token: string | undefined): Promise<unknown>;
export declare function githubLabelsApi(owner: string, repo: string, token: string | undefined): Promise<unknown>;
export interface GithubContentsPutBody {
    message: string;
    contentBase64: string;
    sha?: string;
    author?: {
        name: string;
        email: string;
    };
}
export declare function githubContentsPut(owner: string, repo: string, path: string, token: string | undefined, body: GithubContentsPutBody): Promise<unknown>;
export interface GithubRepoSummary {
    owner: string;
    repo: string;
    fullName: string;
    private: boolean;
    description: string | null;
    updatedAt: string;
    defaultBranch: string;
    sizeKiB: number;
}
interface GithubRepoRaw {
    name: string;
    full_name: string;
    private: boolean;
    description: string | null;
    updated_at: string;
    default_branch: string;
    size: number;
    owner: {
        login: string;
    };
}
export declare const GITHUB_REPOS_PAGE = 100;
export declare const GITHUB_REPOS_MAX_PAGES = 10;
export declare function githubReposUrl(page?: number): string;
export declare function toRepoSummary(r: GithubRepoRaw): GithubRepoSummary;
export declare function githubListRepos(token: string): Promise<{
    repos: GithubRepoSummary[];
    truncated: boolean;
}>;
export interface GithubRepoSource {
    provider: "github";
    owner: string;
    repo: string;
}
export declare function parseGithubRepoUrl(value: unknown): GithubRepoSource | null;
export declare function isValidGithubRepoSource(rs: unknown): rs is GithubRepoSource;
export {};
