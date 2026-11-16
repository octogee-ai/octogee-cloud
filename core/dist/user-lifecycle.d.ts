import type { AgentModelSelections } from "@octogee/shared/types/agent-models";
import type { SchedulerMigrationRequest, SchedulerMigrationResult, CustomerSnapshot } from "@octogee/shared/types/fleet-controller";
import type { FleetBrokerProjectCheckoutScope, FleetBrokerProjectAgent, FleetBrokerProjectRestore, FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { ProjectRepoSource } from "@octogee/shared/types/project";
import type { MigrationActivationManifest, MigrationSourceIdentityCustody } from "./migration-activation-manifest.js";
import type { ManagedGitHost } from "./git-host/types.js";
export interface UserSnapshot {
    uid: string;
    slug: string;
    contextTemplateKey: string;
    planInputs: Record<string, unknown>;
    gatewayId: string;
    status: "" | "provisioning" | "complete";
    agentIds: string[];
    restoreAuthority?: FleetBrokerUserSnapshot["restoreAuthority"];
    repoUrl: string;
    mattermostUserId: string | null;
    channels: CustomerSnapshot["channels"];
    ownerName: string;
    persona: Record<string, unknown> | null;
    timeZone?: string | null;
    projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
    projects?: FleetBrokerProjectRestore[];
    projectAgents?: FleetBrokerProjectAgent[];
    byotActive?: boolean;
    freeTierModelRef?: string;
    builderAgentDefault?: {
        primary: string;
        fallbacks: string[];
    };
    provisionedBy?: "service";
    systemConfig?: {
        byot?: {
            provider?: string;
            baseUrl?: string;
            model?: string;
        };
        agentModels?: AgentModelSelections;
    };
}
export interface ReassertUserData {
    username: string;
    timeZone: string | null;
    byotActive?: boolean;
    systemConfig?: UserSnapshot["systemConfig"];
    planInputs: Record<string, unknown>;
    freeTierModelRef?: string;
    builderAgentDefault?: UserSnapshot["builderAgentDefault"];
    provisioning: {
        openclaw: {
            status: "complete";
        };
    };
}
export interface ProjectCloneTarget {
    projectSlug: string;
    giteaRepoName: string | null;
    repoSource?: ProjectRepoSource | null;
}
export interface ProjectCloneOptions {
    repoSource?: ProjectRepoSource | null;
    refreshRemote?: boolean;
    refreshLeaseDeadlineMs?: number;
    signal?: AbortSignal;
}
export interface UserContext {
    uid: string;
    slug: string;
    contextTemplateKey: string;
    ownerName: string;
    customerDir: string;
    today: string;
    username: string;
    templateVars: Record<string, string>;
    userData: Record<string, unknown>;
}
export type MmUpdate = Record<string, unknown>;
export type ProvisioningPath = "gateway" | "service";
export type ServiceProvisioningAnswer = {
    readonly ready: true;
} | {
    readonly ready: false;
    readonly reason: string;
    readonly retryAfterMs: number;
} | {
    readonly ready: false;
    readonly refused: true;
    readonly reason: string;
};
export interface ServiceProvisioningAdapter {
    readiness: (uid: string) => Promise<ServiceProvisioningAnswer>;
    serviceGitKey: (slug: string) => string;
    holdsServiceGitKey: (slug: string) => boolean;
    registerGitKey: (uid: string, publicKey: string) => Promise<ServiceProvisioningAnswer>;
    releaseGitKey: (uid: string, publicKey: string) => Promise<void>;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    now?: () => number;
}
export declare const SERVICE_PROVISIONING_WAIT_MS = 90000;
export declare const SERVICE_GIT_KEY_WAIT_MS = 60000;
export interface UserLifecycleAdapter {
    log: (msg: string, fields?: {
        status: "failed";
    }) => void;
    provisioningService?: ServiceProvisioningAdapter;
    isIsolatedGateway?: () => boolean;
    /** True when this gateway is the configured disposable isolated for this exact slug. */
    isConfiguredUser?: (slug: string) => boolean;
    /**
     * True when this pod owns a readable user system-config overlay for the
     * requested user. A complete user overlay is never repaired through
     * the Shared user config projection.
     */
    configuredUserOverlayPresent?: (slug: string) => boolean;
    /**
     * Re-run the platform broker-profile materialization for this user's
     * agents. Only openclaw creates an agent's auth-profile store, so the mount's
     * first attempt runs too early and defers; this is called once the agent is
     * confirmed running+connected, when the store is guaranteed to exist.
     */
    materializeBrokerProfiles?: (slug: string) => void | Promise<void>;
    /**
     * Read-only probe of the on-disk openclaw.json: is this user's
     * agent fully wired (agent registered + MM account configured + at
     * least one binding linking the agent to the MM account)?
     * `applyAddUserConfigPatch` writes all three together — so a
     * state where only the agent is present means a prior config.patch
     * crashed mid-flight OR openclaw.json was hand-edited. The operator
     * short-circuit MUST NOT skip the full flow in either case, because
     * the agent will sit inert (no MM auth, no inbound routing).
     */
    userDefaultAgentWiredInOpenclawConfig?: (slug: string) => boolean;
    hasUserAgentRuntime?: (slug: string) => boolean;
    projectCheckoutScope?: (slug: string) => FleetBrokerProjectCheckoutScope;
    /** Locally-present, default-agent-wired user slugs — the pod's honest mounted set
     *  read WITHOUT Firestore, served via /health for the fleet controller's pull-model poller.
     *  Also the reconcile's heartbeat report + mount-observed basis. */
    listLocalUserSlugs?: () => string[];
    /** Raw on-disk user dirs (no default-agent-wired filter) — the reconcile's evict-observed set,
     *  so a partial/junk dir from a mount that died before its config patch is still drained
     *  once unassigned. */
    listLocalUserDirs?: () => string[];
    /** True iff the slug's mount-completion marker is present — the LAST step a successful
     *  ensure writes, AFTER the user is fully provisioned (not merely default-agent-wired). The
     *  reconcile's mount direction keys off this, so a default-agent-wired-but-incomplete mount
     *  (config patch landed, then mark-complete failed) is re-ensured rather than
     *  silently treated as done. */
    userMountMarked?: (slug: string) => boolean;
    /** Stamp the mount-completion marker for the slug — the final step of a successful mount. */
    writeMountMarker?: (slug: string) => void;
    /** True iff the slug has a fresh migrating-in pin — a migration imported + default-agent-wired it
     *  here, but cutover hasn't yet made it desired-here. The reconcile's evict direction skips
     *  such slugs so it doesn't drain a freshly-imported user mid-migration. */
    userMigratingIn?: (slug: string) => boolean;
    /** Stamp the migrating-in pin (import handler, before activation). */
    markUserMigratingIn?: (slug: string) => void;
    /** Clear the migration pin after a target-side import is aborted. */
    clearUserMigratingIn?: (slug: string) => void;
    listMigratingInSlugs?: () => string[];
    loadUserSnapshot: (uid: string, options?: {
        refresh?: boolean;
    }) => Promise<UserSnapshot | null>;
    seedUserSnapshotForMigration?: (snapshot: FleetBrokerUserSnapshot) => void;
    setProvisioningStatus: (uid: string, status: "provisioning" | "complete") => Promise<void>;
    provisionDefaultAgentAutomation: (user: {
        slug: string;
        coachChannelId: string;
    }) => Promise<void>;
    setRepoUrl: (uid: string, repoUrl: string) => Promise<void>;
    setMattermostFields: (uid: string, fields: MmUpdate) => Promise<void>;
    ensureAgentIds: (uid: string, agentIds: string[]) => Promise<void>;
    hasUserDir: (slug: string) => boolean;
    hasWorkspaceGitDir: (slug: string) => boolean;
    hasGitRemote: (slug: string) => boolean;
    ensureUserDirectories: (slug: string) => void;
    writeUserTemplateFiles: (ctx: UserContext) => Promise<void>;
    removePartialWorkspace: (slug: string) => Promise<void>;
    deleteDepartedUserState: (slug: string) => Promise<void>;
    cloneWorkspaceRepo: (slug: string, repoUrl: string) => Promise<boolean>;
    initWorkspaceRepoFromExistingDir: (ctx: UserContext, path?: ProvisioningPath) => Promise<string | null>;
    hasUserSshKey: (slug: string) => boolean;
    generateUserSshKey: (slug: string) => string;
    gitHost: Pick<ManagedGitHost, "registerKey" | "listKeys" | "releaseKey" | "ensureOwner" | "ensureRepo">;
    readLocalUserPubKey: (slug: string) => string | null;
    deleteUserSshKey: (slug: string) => Promise<void>;
    blobSyncForSlug: (slug: string) => Promise<void>;
    restoreByosubForAgent: (slug: string) => Promise<{
        restored: boolean;
        present: boolean;
    }>;
    reassertByotForUser: (userData: ReassertUserData) => Promise<void>;
    reassertConvergedContextFilesForUser: (userData: ReassertUserData) => Promise<void>;
    listProjectsNeedingClone: (slug: string) => Promise<ProjectCloneTarget[]>;
    cloneProjectRepo: (userSlug: string, projectSlug: string, giteaRepoName: string | null, opts?: ProjectCloneOptions) => Promise<boolean>;
    seedDeferredProjectWorkspace?: (userSlug: string, projectSlug: string) => Promise<void>;
    provisionMattermostUser: (ctx: UserContext) => Promise<MmUpdate>;
    applyAddUserConfigPatch: (snapshot: UserSnapshot, mmUpdate: MmUpdate | null, opts?: {
        signal?: AbortSignal;
        byosActive?: boolean;
        evictionBatch?: readonly string[];
        currentEvictionBatch?: () => Promise<readonly string[]>;
        /** Projects whose pod checkout is absent. Their agents point at a workspace dir
         *  that does not exist, so they stay out of the config until the checkout lands. */
        withoutProjectIds?: readonly string[];
        /** Broker profile materialization started at mount start; settles (never rejects)
         *  before the runtime secrets reload that follows the config patch. */
        brokerProfilesReady?: Promise<void>;
        runtimePublication?: AddUserOptions["runtimePublication"];
        beforeRuntimePublish?: () => Promise<void>;
        migrationId?: string;
    }) => Promise<{
        elapsedMs: number;
        appliedFingerprint?: string;
    }>;
    reconcileConfiguredUserProjectAgents?: (snapshot: UserSnapshot, opts?: {
        signal?: AbortSignal;
        withoutProjectIds?: readonly string[];
        runtimePublication?: AddUserOptions["runtimePublication"];
    }) => Promise<{
        elapsedMs: number;
        appliedFingerprint?: string;
    }>;
    applyRemoveUserConfigPatch: (slug: string, agentId: string, evictionBatch?: readonly string[], currentEvictionBatch?: () => Promise<readonly string[]>) => Promise<readonly string[] | void>;
    cancelPendingEviction?: (slug: string) => boolean | void;
    clearMountMarker?: (slug: string) => void;
    waitForAccountHealthy: (params: {
        slug: string;
        timeoutMs: number;
    }) => Promise<boolean>;
    projectAgentsHealthy: (snapshot: UserSnapshot) => Promise<boolean>;
    reportProvisioned: (ctx: UserContext, report: {
        first: boolean;
    }) => Promise<void>;
    onMounted?: (slug: string) => void;
    onUnmounted?: (slug: string) => void;
    uidForSlug: (slug: string) => Promise<string | null>;
    userContextRestoreHeld?: (slug: string) => Promise<boolean>;
    schedulerMigration: (slug: string, request: SchedulerMigrationRequest) => Promise<SchedulerMigrationResult>;
    schedulerReady: () => Promise<void>;
    resumeUser: (slug: string, opts?: {
        migrationId: string;
        role?: "target";
    }) => Promise<void>;
    sourceMigrationIdentityCustody?: (slug: string, migrationId: string) => Promise<MigrationSourceIdentityCustody>;
    sourceMigrationAgentAnchors?: (slug: string, migrationId: string) => Promise<import("@octogee/shared/types/fleet-broker").FleetBrokerAgentAnchor[]>;
    quiesceUser: (slug: string, timeoutMs: number, opts?: {
        stopMattermost: boolean;
        schedulerMigrationId?: string;
        retainNonportable?: boolean;
    }) => Promise<{
        drained: boolean;
        runningCount: number;
    }>;
    listExportPaths: (slug: string) => Promise<Array<{
        cwd: string;
        path: string;
    }>>;
    prepareImportDir: (slug: string, mode: UserStateImportMode) => Promise<string>;
    prepareKeyImportDir: (slug: string) => Promise<string>;
    targetMigrationIdentityCustody?: (slug: string, migrationId: string) => Promise<{
        custody: import("./migration-activation-manifest.js").MigrationTargetIdentityCustody;
        migration: import("@octogee/shared/types/fleet-broker").FleetBrokerAgentAnchorMigration;
        anchors: import("@octogee/shared/types/fleet-broker").FleetBrokerAgentAnchor[];
    }>;
    activateImportedUser: (slug: string, opts?: {
        signal?: AbortSignal;
        migrationId?: string;
        beforeRuntimePublish?: () => Promise<void>;
        deferRuntimeVerification?: true;
    }) => Promise<{
        appliedFingerprint: string;
        verificationPending?: string;
    }>;
    recordAppliedFingerprint?: (slug: string, fingerprint: string) => void;
    exportOpenClawActivationManifest?: (slug: string, opts?: {
        signal?: AbortSignal;
        timeoutMs?: number;
        convergeSource?: boolean;
    }) => Promise<MigrationActivationManifest>;
    removeImportedUserBySlug?: (slug: string, evictionBatch?: readonly string[], currentEvictionBatch?: () => Promise<readonly string[]>, targetCleanup?: {
        migrationId: string;
        targetPodUid: string;
        assertCurrent: () => Promise<void>;
    }, erasureAgentIds?: readonly string[]) => Promise<RemoveUserResult>;
    releaseAgent?: (agentId: string) => Promise<void>;
}
export type UserStateImportMode = "pre" | "final" | "default";
export type AddUserStep = "claim-slot" | "ensure-dir" | "write-templates" | "clone-workspace-repo" | "init-workspace-repo" | "ssh-key" | "ssh-key-resync" | "blob-sync" | "byosub-restore" | "byot-reassert" | "context-files-reassert" | "project-clone" | "mattermost-provision" | "config-patch" | "verify-channel-ready" | "mark-complete" | "report-provisioned";
export interface AddUserResult {
    newUser: boolean;
    steps: AddUserStep[];
    appliedFingerprint?: string;
    pendingProjectClones: string[];
}
export interface RestoreUserRuntimeResult {
    restored: boolean;
    steps: AddUserStep[];
    appliedFingerprint?: string;
    pendingProjectClones: string[];
    convergedState: boolean;
}
export type RemoveUserStep = "config-patch-remove" | "delete-dir" | "release-gitea-key";
export interface RemoveUserResult {
    wasMounted: boolean;
    steps: RemoveUserStep[];
    retained?: boolean;
    releasedAgentIds?: string[];
}
export declare class ConcurrentMountError extends Error {
    readonly name = "ConcurrentMountError";
    constructor(uid: string);
}
export declare function _resetInFlightUidsForTests(): void;
export declare function _inFlightUidsHasForTests(uid: string): boolean;
export type MountStep = "load-snapshot" | "await-provisioning" | "ssh-key" | "claim-slot" | "workspace-repo" | "byos-restore" | "mattermost" | "config-patch" | "reassert-converged" | "verify-channel-ready" | "blob-sync" | "project-clones" | "finalize" | "report-provisioned";
export type MarkStep = (step: MountStep) => void;
export interface AddUserOptions {
    verifyTimeoutMs?: number;
    usersDir?: string;
    mountDeadlineMs?: number;
    convergeContent?: boolean;
    deferRuntimeVerification?: boolean;
    reclaimExistingSshKey?: boolean;
    evictionBatch?: readonly string[];
    currentEvictionBatch?: () => Promise<readonly string[]>;
    runtimePublication?: {
        settled: Promise<void>;
        invalidateFingerprint: () => void;
    };
    beforeRuntimePublish?: () => Promise<void>;
    migrationId?: string;
    signal?: AbortSignal;
    onSignalCreated?: (signal: AbortSignal) => void;
    onWorkSettled?: (settled: Promise<void>) => void;
}
export declare function addUserToGateway(adapter: UserLifecycleAdapter, uid: string, opts?: AddUserOptions): Promise<AddUserResult>;
export declare function prepareUserRuntimePublication(options?: {
    signal?: AbortSignal;
    beforeRuntimePublish?: () => Promise<void>;
}): Promise<void>;
export declare function restoreUserRuntimeFromSnapshot(adapter: UserLifecycleAdapter, snapshot: UserSnapshot, opts?: AddUserOptions): Promise<RestoreUserRuntimeResult>;
export declare function cloneProjectsFromSnapshot(adapter: UserLifecycleAdapter, snapshot: UserSnapshot, options?: {
    signal?: AbortSignal;
}): Promise<{
    steps: AddUserStep[];
    pending: string[];
}>;
type ProjectCheckoutAdapter = Pick<UserLifecycleAdapter, "listProjectsNeedingClone" | "cloneProjectRepo" | "seedDeferredProjectWorkspace" | "isIsolatedGateway" | "isConfiguredUser" | "log">;
export interface CloneMissingProjectsOptions {
    githubCheckouts?: "hydrate-here" | "defer";
    signal?: AbortSignal;
}
export declare function cloneMissingProjects(adapter: ProjectCheckoutAdapter, slug: string, options?: CloneMissingProjectsOptions): Promise<{
    steps: AddUserStep[];
    pending: string[];
    deferred: string[];
}>;
export declare function removeUserFromGateway(adapter: UserLifecycleAdapter, uid: string, opts?: {
    evictionBatch?: readonly string[];
    currentEvictionBatch?: () => Promise<readonly string[]>;
}): Promise<RemoveUserResult>;
export declare function pubKeysMatch(a: string, b: string): boolean;
export {};
