import type { FleetBrokerProjectAgent } from "@octogee/shared/types/fleet-broker";
import type { UserSnapshot } from "./user-lifecycle.js";
import type { MattermostTokenSecret } from "./platform-state/secrets.js";
import type { PlatformStateRepositories } from "./platform-state/store.js";
import type { ModelCredentialRecord, UserRepositories } from "./platform-state/users.js";
import type { AgentModelSelections } from "@octogee/shared/types/agent-models";
type ChannelBinding = UserSnapshot["channels"][number];
export declare function mapWorkspaceChannelDoc(data: Record<string, unknown>): ChannelBinding | null;
export declare function mapProjectChannelDoc(projectId: string, data: Record<string, unknown>): ChannelBinding | null;
export type ProjectAgentCredential = Pick<MattermostTokenSecret, "mattermostUserId" | "personalToken">;
export declare function mapProjectAgentState(projectId: string, projectData: Record<string, unknown>, credential: ProjectAgentCredential | null): FleetBrokerProjectAgent | null;
type ProjectAgentStates = Array<NonNullable<ReturnType<typeof mapProjectAgentState>>>;
export declare function collectStoredProjectAgentStates(state: Pick<PlatformStateRepositories, "workspaces" | "secrets">, uid: string, slug: string): Promise<ProjectAgentStates>;
export declare function deriveSlug(uid: string, data: Record<string, unknown>): string;
type SnapshotSystemConfig = NonNullable<UserSnapshot["systemConfig"]>;
export interface ByotSnapshotProjection {
    byotActive: boolean;
    systemConfig?: SnapshotSystemConfig;
}
export declare function readAgentModelSelections(users: Pick<UserRepositories, "agentModels">, uid: string): Promise<AgentModelSelections>;
export declare function byotSnapshotProjection(credential: ModelCredentialRecord | null, agentModels: AgentModelSelections): ByotSnapshotProjection;
export declare function readByotSnapshotProjection(users: Pick<UserRepositories, "agentModels" | "modelCredentials">, uid: string): Promise<ByotSnapshotProjection>;
export declare function mapUserDocToSnapshot(uid: string, data: Record<string, unknown>, channels: UserSnapshot["channels"]): UserSnapshot;
export {};
