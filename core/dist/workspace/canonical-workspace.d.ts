export interface UserWorkspaceIdentityData {
    username?: unknown;
    workspaceId?: unknown;
    workspaceSlug?: unknown;
    defaultWorkspaceId?: unknown;
    provisioning?: {
        openclaw?: {
            slug?: unknown;
        } | null;
    } | null;
}
export declare function resolveCanonicalWorkspaceSlug(uid: string, data: UserWorkspaceIdentityData | null | undefined): Promise<string | null>;
