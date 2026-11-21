import type { AgentLook } from "./agent-look.js";
import type { AgentModelSelections } from "./agent-models.js";
import type { ProjectAgentIdentity, ProjectAgentStatus } from "./project.js";
import type { AssignmentState } from "./gateway-releases.js";
import type { GatewayVmEgressState } from "./glm.js";
import type { ProjectRepoSource } from "./project.js";
export type FleetBrokerProvisioningStatus = "" | "provisioning" | "complete";
export type FleetBrokerMattermostUpdate = Record<string, unknown>;
export interface FleetBrokerChannelBinding {
    scope: "workspace" | "project";
    kind: string;
    channelId: string;
    projectId?: string;
}
export interface FleetBrokerProjectRestore {
    projectSlug: string;
    giteaRepoName: string | null;
    repoSource?: ProjectRepoSource | null;
    provisioningState?: string;
    checkoutEnabled?: boolean;
    recipe?: string;
}
export type FleetBrokerProjectCheckoutScope = "workspace-only" | "workspace-and-projects";
export interface FleetBrokerAssignmentRosterEntry {
    uid: string;
    state: AssignmentState;
    epoch: number;
}
export interface FleetBrokerConfiguredUserProjectCredential {
    projectId: string;
    agentId: string;
    accountId: string;
    token: string;
}
export interface FleetBrokerConfiguredUserDesk {
    builderName: string;
    agentName: string;
    look: AgentLook;
    timeZone: string | null;
}
export interface FleetBrokerConfiguredUserBootstrap {
    uid: string;
    slug: string;
    agentId: string;
    accountId: string;
    coachToken: string;
    projectCredentials: FleetBrokerConfiguredUserProjectCredential[];
    desk: FleetBrokerConfiguredUserDesk;
}
export interface FleetBrokerProjectAgentReadiness {
    projectId: string;
    activationId: string;
    tokenHash: string;
    channelIds: string[];
}
export interface FleetBrokerProjectAgent {
    githubBacked?: true;
    identity?: ProjectAgentIdentity;
    deliveryPending?: boolean;
    projectId: string;
    activationId?: string | null;
    status?: ProjectAgentStatus | null;
    enabled: boolean;
    mmUserId: string | null;
    token: string | null;
}
export interface FleetBrokerDefaultAgentIdentity {
    name: string;
    emoji: string;
}
export interface FleetBrokerProjectCreateInput {
    agentName?: string;
    name?: string;
    slug?: string;
    tagline?: string;
    category?: string;
    projectType?: string;
    status?: string;
    visibility?: string;
    repoSource?: unknown;
    recipe?: unknown;
}
export interface FleetBrokerProjectCreateSuccess {
    success: true;
    workspaceId: string;
    slug: string;
    channelId: string;
}
export interface FleetBrokerUsageData {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    costUsd: number;
    model: string;
    costBreakdown: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
}
export interface FleetBrokerUsageEvent {
    agentId: string;
    usage: FleetBrokerUsageData;
}
export interface FleetBrokerBlobSignedUrl {
    storage?: "s3";
    url: string;
    method: "GET" | "PUT";
    gcsPath: string;
    expiresAt: string;
    requiredHeaders?: Record<string, string>;
}
export declare function isBlobObjectVersion(version: unknown, storage?: "s3"): version is string;
export interface FleetBrokerNpmRegistryCredentials {
    registryUrl: string;
    token: string;
    expiresAt: string;
}
export interface FleetBrokerUserRuntimeReset {
    status: "pending";
    uid: string;
    slug: string;
    operationId: string;
    sourceGatewayId: string;
    targetGatewayId: string;
    generation: number;
    disposableLeaseId: string;
    disposableLeaseGeneration: number;
    requestedAt: number;
}
export declare const RETIRED_VM_BINDING_DENIAL_REASON = "retired computer bindings may only reach final-checkpoint routes";
export declare const GATEWAY_BINDING_MISMATCH_REASON = "request names a gatewayId other than the bound gateway";
export declare const BUILDER_RUNTIME_STATE_RECOVERY_TIERS: readonly ["minute", "hour", "day"];
export type BuilderRuntimeStateRecoveryTier = (typeof BUILDER_RUNTIME_STATE_RECOVERY_TIERS)[number];
export interface FleetBrokerIsolatedRuntimeStateSnapshotUrls {
    live: FleetBrokerBlobSignedUrl;
    recovery: FleetBrokerBlobSignedUrl[];
}
export interface FleetBrokerIsolatedRuntimeStatePruneResult {
    deleted: number;
}
export interface FleetBrokerAgentAnchor {
    agentId: string;
    storeId: string;
    schema: string;
}
export interface FleetBrokerGatewayStateAnchor {
    storeId: string;
    schema: string;
}
export type UserAuxiliaryFamily = "workboard" | "logbook" | "team-reports";
export interface FleetBrokerAuxiliaryAnchor extends FleetBrokerGatewayStateAnchor {
    family: UserAuxiliaryFamily;
}
export interface FleetBrokerAgentAnchorMigration {
    migrationId: string;
    claimStartedAt: number;
    sourceGatewayId: string;
    sourceEpoch: number;
}
export interface FleetBrokerAgentAnchors {
    sharedToShared?: true;
    migration?: FleetBrokerAgentAnchorMigration;
    anchors: FleetBrokerAgentAnchor[];
    state?: FleetBrokerGatewayStateAnchor;
    auxiliary?: FleetBrokerAuxiliaryAnchor[];
    assignment?: FleetBrokerAssignmentRosterEntry;
}
export interface FleetBrokerVmHomeCheckpointUrl {
    name: string;
    upload: FleetBrokerBlobSignedUrl;
}
export interface FleetBrokerVmHomeCheckpointCommit {
    name: string;
    size: number;
    sha256: string;
    completedAt: number;
}
export interface FleetBrokerVmHomeDownload extends FleetBrokerVmHomeCheckpointCommit {
    coverage?: "builder-home-v2";
    writerProtocol?: 2 | 3;
    instanceId?: string | null;
    generation?: string;
    download: FleetBrokerBlobSignedUrl;
}
export interface FleetBrokerVmHomePruneResult {
    deleted: number;
}
export interface FleetBrokerVmEgress {
    egress: GatewayVmEgressState | null;
}
export type FleetBrokerOpenClawBootAction = "start" | "doctor" | "wait";
export interface FleetBrokerOpenClawBootClaim {
    action: FleetBrokerOpenClawBootAction;
    sourceDoctor?: {
        requestId: string;
        agentIds: string[];
        schedulerStateRecovery?: true;
        postgresAgentStores?: Array<{
            agentId: string;
            storeId: string;
            schema: string;
        }>;
    };
}
export interface FleetBrokerPreStopFlushStep {
    name: string;
    status: "done" | "failed" | "skipped";
    error?: string;
    durationMs: number;
}
export interface FleetBrokerPreStopFlushResult {
    ok: boolean;
    durationMs: number;
    steps: FleetBrokerPreStopFlushStep[];
}
export interface FleetBrokerPreStopFlushEvent {
    gatewayClass: string;
    phase: "started" | "completed";
    reason: "prestop";
    result?: FleetBrokerPreStopFlushResult;
}
export interface FleetBrokerUserRestoreAuthority {
    uid: string;
    slug: string;
    gatewayId: string;
    fromGatewayId: string;
    assignmentEpoch: number;
    operationId: string;
    claimStartedAt: number;
    attemptId: string;
    phase: "dispatched";
    dispatchedAt: number;
    dispatchClaimStartedAt: number;
    migrationId: string;
}
export interface FleetBrokerUserSnapshot {
    uid: string;
    slug: string;
    contextTemplateKey: string;
    planInputs: Record<string, unknown>;
    gatewayId: string;
    status: FleetBrokerProvisioningStatus;
    agentIds: string[];
    runtimeReset?: FleetBrokerUserRuntimeReset;
    restoreAuthority?: FleetBrokerUserRestoreAuthority;
    runtimeMutationFenced?: boolean;
    repoUrl: string;
    mattermostUserId: string | null;
    customerMmUserId: string | null;
    channels: FleetBrokerChannelBinding[];
    projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
    projects: FleetBrokerProjectRestore[];
    projectAgents?: FleetBrokerProjectAgent[];
    freeTierModelRef?: string;
    builderAgentDefault?: {
        primary: string;
        fallbacks: string[];
    };
    ownerName: string;
    email: string;
    displayName: string;
    lastName: string;
    timeZone?: string | null;
    photoURL: string;
    persona: Record<string, unknown> | null;
    coachToken: string | null;
    coachMmUserId: string | null;
    coachIdentity?: FleetBrokerDefaultAgentIdentity;
    provisionedBy?: "service";
    gitKeyHolder?: string;
    byotActive?: boolean;
    systemConfig?: {
        byot?: {
            provider?: string;
            baseUrl?: string;
            model?: string;
        };
        agentModels?: AgentModelSelections;
    };
}
