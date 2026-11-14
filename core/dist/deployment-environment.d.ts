export declare const DEPLOYMENT_TARGETS_ENV = "OCTOGEE_DEPLOYMENT_TARGETS";
export type DeploymentEnvironment = "prod" | "test";
export type ResolvedDeploymentEnvironment = DeploymentEnvironment | "unknown";
export type DeploymentTargetLifecycle = "active" | "candidate" | "frozen";
interface ArtifactRegistryDocument {
    projectId: string;
    location: string;
    repository: string;
}
interface CloudSqlDocument {
    projectId: string;
    region: string;
    instance: string;
    mattermostPasswordSecret: string;
    giteaPasswordSecret: string;
    connectionNameSecret: string;
    pointInTimeRecoveryEnabled: boolean;
    platformStateInstance: string;
    agentStoreDatabase: string;
}
interface KmsDocument {
    projectId: string;
    location: string;
    keyRing: string;
    key: string;
}
interface StorageDocument {
    projectId: string;
    location: string;
}
interface IngressDocument {
    edgeStaticIpName: string;
    mattermostStaticIpName: string;
    giteaStaticIpName: string;
    previewStaticIpName: string;
}
interface NetworkBoundaryDocument {
    controlPlaneCidr: string;
    privateServicesCidr: string;
}
interface PlatformTargetDocument {
    environment: string;
    promotionSourceTargetId?: string;
    lifecycle: DeploymentTargetLifecycle;
    clusterName: string;
    kubeContext?: string;
    namespace: string;
    siteOrigin: string;
    appOrigin: string;
    apiOrigin: string;
    gitOrigin: string;
    mattermostOrigin: string;
    gatewayValuesFile: string;
    pinEnvironment?: string;
}
interface HostedTargetDocument extends PlatformTargetDocument {
    secretNameSuffix: string;
    clusterProjectId: string;
    firebaseProjectId: string;
    hostingProjectId: string;
    customerHostingProjectId: string;
    region: string;
    projectRunnerApiServerEgressCidrs: string[];
    artifactRegistry: ArtifactRegistryDocument;
    cloudSql: CloudSqlDocument;
    kms: KmsDocument;
    storage: StorageDocument;
    ingress: IngressDocument;
    networkBoundary?: NetworkBoundaryDocument;
    previewOrigin: string;
    pinEnvironment: string;
}
interface DeploymentTargetsDocument {
    schemaVersion: 1;
    activeTargets: Record<string, string>;
    targets: Record<string, PlatformTargetDocument | HostedTargetDocument>;
}
export interface DeploymentEnvironmentSettings {
    name: string;
    promotionSourceTargetId?: string;
    targetId: string;
    lifecycle: DeploymentTargetLifecycle;
    secretNameSuffix: string;
    clusterProjectId: string;
    firebaseProjectId: string;
    hostingProjectId: string;
    customerHostingProjectId: string;
    region: string;
    clusterName: string;
    kubeContext: string;
    namespace: string;
    projectRunnerApiServerEgressCidrs: string[];
    artifactRegistryProjectId: string;
    artifactRegistryLocation: string;
    artifactRegistryName: string;
    artifactRegistryRepository: string;
    cloudSqlProjectId: string;
    cloudSqlRegion: string;
    cloudSqlInstanceName: string;
    cloudSqlConnectionName: string;
    cloudSqlMattermostPasswordSecretName: string;
    cloudSqlGiteaPasswordSecretName: string;
    cloudSqlConnectionNameSecretName: string;
    cloudSqlPointInTimeRecoveryEnabled: boolean;
    cloudSqlPlatformStateInstanceName: string;
    cloudSqlAgentStoreDatabaseName: string;
    kmsProjectId: string;
    kmsLocation: string;
    kmsKeyRing: string;
    kmsKey: string;
    kmsKeyName: string;
    storageProjectId: string;
    storageLocation: string;
    edgeStaticIpName: string;
    mattermostStaticIpName: string;
    giteaStaticIpName: string;
    previewStaticIpName: string;
    networkBoundary?: NetworkBoundaryDocument;
    siteOrigin: string;
    appOrigin: string;
    apiOrigin: string;
    gitOrigin: string;
    mattermostOrigin: string;
    previewOrigin: string;
    gatewayValuesFile: string;
    pinEnvironment: string;
}
export type DeploymentTargetSettings = Pick<DeploymentEnvironmentSettings, "name" | "targetId" | "lifecycle" | "clusterName" | "namespace" | "siteOrigin" | "appOrigin" | "apiOrigin" | "gitOrigin" | "mattermostOrigin" | "gatewayValuesFile"> & Partial<DeploymentEnvironmentSettings>;
export declare function validateDeploymentTargetsDocument(document: unknown): asserts document is DeploymentTargetsDocument;
export declare function loadDeploymentTargetsDocument(path: string): DeploymentTargetsDocument;
export declare function installDeploymentTargets(document: unknown): void;
export declare function resetDeploymentTargetsForTests(): void;
export declare function activeDeploymentTargetSettings(environment: string): DeploymentTargetSettings;
export declare function requireHostedDeploymentSettings(settings: DeploymentTargetSettings): DeploymentEnvironmentSettings;
export declare function deploymentEnvironmentSettings(environment: DeploymentEnvironment): DeploymentEnvironmentSettings & {
    name: DeploymentEnvironment;
};
export declare function deploymentTargetSettings(targetId: string): DeploymentTargetSettings;
export declare function hostedDeploymentTargetSettings(targetId: string): DeploymentEnvironmentSettings;
export declare function deploymentSettingsForRuntime(input: {
    namespace: string;
    targetId?: string;
}): DeploymentTargetSettings;
export declare function deploymentTargetForFirebaseProject(projectId: string): DeploymentEnvironmentSettings;
export declare function deploymentTargetsForEnvironment(environment: DeploymentEnvironment): DeploymentEnvironmentSettings[];
export declare function deploymentEnvironmentForNamespace(namespace: string): string;
export declare function deploymentEnvironmentForProject(projectId: string): ResolvedDeploymentEnvironment;
export declare function publicAppOriginsForTarget(settings: DeploymentTargetSettings): string[];
export {};
