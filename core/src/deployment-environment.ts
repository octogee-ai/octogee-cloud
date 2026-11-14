import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEPLOYMENT_TARGETS_ENV = "OCTOGEE_DEPLOYMENT_TARGETS";

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

export type DeploymentTargetSettings = Pick<DeploymentEnvironmentSettings,
  "name" | "targetId" | "lifecycle" | "clusterName" | "namespace" | "siteOrigin" | "appOrigin" |
  "apiOrigin" | "gitOrigin" | "mattermostOrigin" | "gatewayValuesFile"
> & Partial<DeploymentEnvironmentSettings>;

const TARGET_LIFECYCLES: DeploymentTargetLifecycle[] = [
  "active",
  "candidate",
  "frozen",
];
const TARGET_STRING_FIELDS = [
  "clusterName",
  "namespace",
  "siteOrigin",
  "appOrigin",
  "apiOrigin",
  "gitOrigin",
  "mattermostOrigin",
  "gatewayValuesFile",
] as const;
const HOSTED_TARGET_STRING_FIELDS = [
  "secretNameSuffix",
  "clusterProjectId",
  "firebaseProjectId",
  "hostingProjectId",
  "customerHostingProjectId",
  "region",
  "previewOrigin",
  "pinEnvironment",
] as const;
const HOSTED_TARGET_FIELDS = [
  "clusterProjectId", "firebaseProjectId", "hostingProjectId", "customerHostingProjectId",
  "artifactRegistry", "cloudSql", "kms", "storage", "ingress",
] as const;
const INGRESS_STRING_FIELDS = [
  "edgeStaticIpName",
  "mattermostStaticIpName",
  "giteaStaticIpName",
  "previewStaticIpName",
] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string, label: string): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return fieldValue;
}

function stringFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  for (const field of fields) {
    stringField(value, field, label);
  }
}

function apiServerEgressCidrs(value: unknown, label: string): void {
  const invalid = () => new Error(`${label} must contain unique canonical IPv4 /32 CIDRs`);
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) {
    throw invalid();
  }
  for (const cidr of value) {
    if (typeof cidr !== "string") throw invalid();
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/32$/u.exec(cidr);
    if (!match) throw invalid();
    const octets = match.slice(1, 5).map(Number);
    if (octets.some((part) => part > 255) || octets.every((part) => part === 0)) {
      throw invalid();
    }
    if (`${octets.join(".")}/32` !== cidr) throw invalid();
  }
}

function validatePromotionSourceField(
  target: Record<string, unknown>,
  targetId: string,
  environment: string,
): void {
  if (environment === "prod") {
    stringField(target, "promotionSourceTargetId", `deployment target ${targetId}`);
  } else if (target.promotionSourceTargetId !== undefined) {
    throw new Error(
      `deployment target ${targetId}.promotionSourceTargetId is only valid for prod`,
    );
  }
}

function validatePromotionSources(targets: Record<string, unknown>): void {
  for (const [targetId, value] of Object.entries(targets)) {
    const target = value as Record<string, unknown>;
    if (target.environment !== "prod") continue;
    const sourceTargetId = target.promotionSourceTargetId as string;
    const source = targets[sourceTargetId] as Record<string, unknown> | undefined;
    if (!source) {
      throw new Error(
        `deployment target ${targetId}.promotionSourceTargetId does not exist: ${sourceTargetId}`,
      );
    }
    if (source.environment !== "test") {
      throw new Error(
        `deployment target ${targetId}.promotionSourceTargetId must belong to test`,
      );
    }
  }
}

function validateIngressIdentityUniqueness(targets: Record<string, unknown>): void {
  const identitiesByProject = new Map<
    string,
    Map<string, { targetId: string; field: string }>
  >();
  for (const [targetId, value] of Object.entries(targets)) {
    const target = value as Record<string, unknown>;
    const projectId = target.clusterProjectId as string;
    const ingress = target.ingress as Record<string, unknown>;
    const identities = identitiesByProject.get(projectId) ??
      new Map<string, { targetId: string; field: string }>();
    identitiesByProject.set(projectId, identities);
    for (const field of INGRESS_STRING_FIELDS) {
      const identity = ingress[field] as string;
      const owner = identities.get(identity);
      if (owner && owner.targetId !== targetId) {
        throw new Error(
          `deployment target ${targetId} ingress identity ${identity} is already used by ${owner.targetId}.${owner.field}`,
        );
      }
      if (!owner) identities.set(identity, { targetId, field });
    }
    const targetIdentities = INGRESS_STRING_FIELDS.map(
      (field) => ingress[field] as string,
    );
    const distinctTargetIdentities = new Set(targetIdentities);
    if (
      distinctTargetIdentities.size !== INGRESS_STRING_FIELDS.length &&
      !(
        distinctTargetIdentities.size === 1 &&
        targetIdentities.every(
          (identity) => identity === ingress.edgeStaticIpName,
        )
      )
    ) {
      throw new Error(
        `deployment target ${targetId} ingress must use either four distinct identities or one shared edge identity`,
      );
    }
  }
}

function validateCustomerHostingProjects(targets: Record<string, unknown>): void {
  const reserved = new Set<string>();
  for (const value of Object.values(targets)) {
    const target = value as Record<string, unknown>;
    for (const field of ["firebaseProjectId", "hostingProjectId", "clusterProjectId"] as const) {
      reserved.add(target[field] as string);
    }
  }
  const owners = new Map<string, string>();
  for (const [targetId, value] of Object.entries(targets)) {
    const target = value as Record<string, unknown>;
    const projectId = target.customerHostingProjectId as string;
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(projectId)) {
      throw new Error(`deployment target ${targetId}.customerHostingProjectId is invalid`);
    }
    if (reserved.has(projectId)) {
      throw new Error(`deployment target ${targetId}.customerHostingProjectId must be isolated`);
    }
    const owner = owners.get(projectId);
    if (owner) {
      throw new Error(`deployment target ${targetId}.customerHostingProjectId is already used by ${owner}`);
    }
    owners.set(projectId, targetId);
  }
}

function validateHostedTarget(target: Record<string, unknown>, targetId: string): void {
  const label = `deployment target ${targetId}`;
  stringFields(target, HOSTED_TARGET_STRING_FIELDS, label);
  apiServerEgressCidrs(
    target.projectRunnerApiServerEgressCidrs,
    `deployment target ${targetId}.projectRunnerApiServerEgressCidrs`,
  );
  stringFields(
    record(target.artifactRegistry, `deployment target ${targetId}.artifactRegistry`),
    ["projectId", "location", "repository"],
    `deployment target ${targetId}.artifactRegistry`,
  );
  const cloudSql = record(target.cloudSql, `deployment target ${targetId}.cloudSql`);
  stringFields(
    cloudSql,
    [
      "projectId",
      "region",
      "instance",
      "mattermostPasswordSecret",
      "giteaPasswordSecret",
      "connectionNameSecret",
      "platformStateInstance",
      "agentStoreDatabase",
    ],
    `deployment target ${targetId}.cloudSql`,
  );
  if (typeof cloudSql.pointInTimeRecoveryEnabled !== "boolean") {
    throw new Error(
      `deployment target ${targetId}.cloudSql.pointInTimeRecoveryEnabled must be a boolean`,
    );
  }
  stringFields(
    record(target.kms, `deployment target ${targetId}.kms`),
    ["projectId", "location", "keyRing", "key"],
    `deployment target ${targetId}.kms`,
  );
  stringFields(
    record(target.storage, `deployment target ${targetId}.storage`),
    ["projectId", "location"],
    `deployment target ${targetId}.storage`,
  );
  stringFields(
    record(target.ingress, `deployment target ${targetId}.ingress`),
    INGRESS_STRING_FIELDS,
    `deployment target ${targetId}.ingress`,
  );
  if (target.networkBoundary !== undefined) {
    stringFields(
      record(target.networkBoundary, `deployment target ${targetId}.networkBoundary`),
      ["controlPlaneCidr", "privateServicesCidr"],
      `deployment target ${targetId}.networkBoundary`,
    );
  }
}

function validateActiveEnvironmentIsolation(
  activeTargets: Record<string, unknown>,
  targets: Record<string, unknown>,
): void {
  const active = Object.entries(activeTargets)
    .filter(([, targetId]) => typeof targetId === "string" && Object.hasOwn(targets, targetId))
    .map(([environment, targetId]) => ({ environment, target: targets[targetId as string] as Record<string, unknown> }))
    .sort((a, b) => a.environment.localeCompare(b.environment));
  for (const [index, first] of active.entries()) {
    for (const second of active.slice(index + 1)) {
      const pair = `${first.environment} and ${second.environment}`;
      if (first.target.firebaseProjectId !== undefined && first.target.firebaseProjectId === second.target.firebaseProjectId) {
        throw new Error(`active deployment targets for ${pair} share Firebase project ${String(first.target.firebaseProjectId)}`);
      }
      if (
        first.target.clusterProjectId !== undefined &&
        first.target.clusterProjectId === second.target.clusterProjectId &&
        first.target.namespace === second.target.namespace
      ) {
        throw new Error(
          `active deployment targets for ${pair} share cluster namespace ${String(first.target.clusterProjectId)}/${String(first.target.namespace)}`,
        );
      }
    }
  }
}

export function validateDeploymentTargetsDocument(document: unknown): asserts document is DeploymentTargetsDocument {
  const manifest = record(document, "deployment targets manifest");
  if (manifest.schemaVersion !== 1) {
    throw new Error("deployment targets manifest.schemaVersion must be 1");
  }

  const activeTargets = record(manifest.activeTargets, "deployment targets manifest.activeTargets");
  const targets = record(manifest.targets, "deployment targets manifest.targets");
  const hostedTargets: Record<string, unknown> = Object.create(null);

  for (const [targetId, value] of Object.entries(targets)) {
    const label = `deployment target ${targetId}`;
    const target = record(value, label);
    const environment = stringField(target, "environment", label);
    const lifecycle = stringField(target, "lifecycle", label);
    if (!TARGET_LIFECYCLES.includes(lifecycle as DeploymentTargetLifecycle)) {
      throw new Error(`${label}.lifecycle is invalid: ${lifecycle}`);
    }
    stringFields(target, TARGET_STRING_FIELDS, label);
    if (target.kubeContext !== undefined) stringField(target, "kubeContext", label);
    if (target.pinEnvironment !== undefined) stringField(target, "pinEnvironment", label);
    if (HOSTED_TARGET_FIELDS.some((field) => Object.hasOwn(target, field))) {
      validateHostedTarget(target, targetId);
      validatePromotionSourceField(target, targetId, environment);
      hostedTargets[targetId] = target;
    } else if (target.promotionSourceTargetId !== undefined) {
      throw new Error(`${label}.promotionSourceTargetId requires hosted release settings`);
    }
  }

  validateActiveEnvironmentIsolation(activeTargets, targets);
  validatePromotionSources(hostedTargets);
  validateIngressIdentityUniqueness(hostedTargets);
  validateCustomerHostingProjects(hostedTargets);

  for (const environment of Object.keys(activeTargets)) {
    const targetId = stringField(activeTargets, environment, "deployment targets manifest.activeTargets");
    if (!Object.hasOwn(targets, targetId)) throw new Error(`Active deployment target does not exist: ${targetId}`);
    const target = targets[targetId] as Record<string, unknown>;
    if (target.environment !== environment) {
      throw new Error(`Active deployment target ${targetId} belongs to ${String(target.environment)}`);
    }
    if (target.lifecycle !== "active") {
      throw new Error(`Active deployment target ${targetId} must be active`);
    }
  }
}

const INSTALLED_TARGETS_SLOT = Symbol.for("octogee.deploymentTargets");
type InstalledTargetsHost = typeof globalThis & { [INSTALLED_TARGETS_SLOT]?: DeploymentTargetsDocument };

function configuredDeploymentTargets(env: NodeJS.ProcessEnv): DeploymentTargetsDocument {
  const configured = env[DEPLOYMENT_TARGETS_ENV]?.trim();
  if (configured) return loadDeploymentTargetsDocument(configured);
  return (globalThis as InstalledTargetsHost)[INSTALLED_TARGETS_SLOT]
    ?? loadDeploymentTargetsDocument(fileURLToPath(new URL("./deployment-targets.json", import.meta.url)));
}

export function loadDeploymentTargetsDocument(path: string): DeploymentTargetsDocument {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `deployment targets manifest is not readable at ${path} (set ${DEPLOYMENT_TARGETS_ENV} to its location): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `deployment targets manifest at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateDeploymentTargetsDocument(document);
  return document;
}

function settings(
  targetId: string,
  target: PlatformTargetDocument | HostedTargetDocument,
): DeploymentTargetSettings {
  const platform: DeploymentTargetSettings = {
    name: target.environment,
    targetId,
    lifecycle: target.lifecycle,
    clusterName: target.clusterName,
    namespace: target.namespace,
    siteOrigin: target.siteOrigin,
    appOrigin: target.appOrigin,
    apiOrigin: target.apiOrigin,
    gitOrigin: target.gitOrigin,
    mattermostOrigin: target.mattermostOrigin,
    gatewayValuesFile: target.gatewayValuesFile,
    ...(target.kubeContext === undefined ? {} : { kubeContext: target.kubeContext }),
    ...(target.pinEnvironment === undefined ? {} : { pinEnvironment: target.pinEnvironment }),
  };
  if (!("clusterProjectId" in target)) return platform;
  return {
    ...platform,
    promotionSourceTargetId: target.promotionSourceTargetId,
    secretNameSuffix: target.secretNameSuffix,
    clusterProjectId: target.clusterProjectId,
    firebaseProjectId: target.firebaseProjectId,
    hostingProjectId: target.hostingProjectId,
    customerHostingProjectId: target.customerHostingProjectId,
    region: target.region,
    kubeContext: `gke_${target.clusterProjectId}_${target.region}_${target.clusterName}`,
    projectRunnerApiServerEgressCidrs: [...target.projectRunnerApiServerEgressCidrs],
    artifactRegistryProjectId: target.artifactRegistry.projectId,
    artifactRegistryLocation: target.artifactRegistry.location,
    artifactRegistryName: target.artifactRegistry.repository,
    artifactRegistryRepository: `${target.artifactRegistry.location}-docker.pkg.dev/${target.artifactRegistry.projectId}/${target.artifactRegistry.repository}`,
    cloudSqlProjectId: target.cloudSql.projectId,
    cloudSqlRegion: target.cloudSql.region,
    cloudSqlInstanceName: target.cloudSql.instance,
    cloudSqlConnectionName: `${target.cloudSql.projectId}:${target.cloudSql.region}:${target.cloudSql.instance}`,
    cloudSqlMattermostPasswordSecretName: target.cloudSql.mattermostPasswordSecret,
    cloudSqlGiteaPasswordSecretName: target.cloudSql.giteaPasswordSecret,
    cloudSqlConnectionNameSecretName: target.cloudSql.connectionNameSecret,
    cloudSqlPointInTimeRecoveryEnabled: target.cloudSql.pointInTimeRecoveryEnabled,
    cloudSqlPlatformStateInstanceName: target.cloudSql.platformStateInstance,
    cloudSqlAgentStoreDatabaseName: target.cloudSql.agentStoreDatabase,
    kmsProjectId: target.kms.projectId,
    kmsLocation: target.kms.location,
    kmsKeyRing: target.kms.keyRing,
    kmsKey: target.kms.key,
    kmsKeyName: `projects/${target.kms.projectId}/locations/${target.kms.location}/keyRings/${target.kms.keyRing}/cryptoKeys/${target.kms.key}`,
    storageProjectId: target.storage.projectId,
    storageLocation: target.storage.location,
    edgeStaticIpName: target.ingress.edgeStaticIpName,
    mattermostStaticIpName: target.ingress.mattermostStaticIpName,
    giteaStaticIpName: target.ingress.giteaStaticIpName,
    previewStaticIpName: target.ingress.previewStaticIpName,
    networkBoundary: target.networkBoundary,
    previewOrigin: target.previewOrigin,
  };
}

interface DeploymentTargetRegistry {
  targets: Record<string, DeploymentTargetSettings>;
  environments: Record<string, DeploymentTargetSettings>;
}

function buildRegistry(manifest: DeploymentTargetsDocument): DeploymentTargetRegistry {
  const targets = Object.fromEntries(
    Object.entries(manifest.targets).map(([targetId, target]) => [
      targetId,
      settings(targetId, target),
    ]),
  );
  const environments = Object.fromEntries(
    Object.entries(manifest.activeTargets).map(([environment, targetId]) => [environment, targets[targetId]]),
  );
  return { targets, environments };
}

let registry: DeploymentTargetRegistry | undefined;

function loadRegistry(): DeploymentTargetRegistry {
  registry ??= buildRegistry(configuredDeploymentTargets(process.env));
  return registry;
}

export function installDeploymentTargets(document: unknown): void {
  if (registry) throw new Error("Deployment targets must be installed before the registry is read");
  validateDeploymentTargetsDocument(document);
  (globalThis as InstalledTargetsHost)[INSTALLED_TARGETS_SLOT] = document;
}

export function resetDeploymentTargetsForTests(): void {
  registry = undefined;
  delete (globalThis as InstalledTargetsHost)[INSTALLED_TARGETS_SLOT];
}

export function activeDeploymentTargetSettings(environment: string): DeploymentTargetSettings {
  const { environments } = loadRegistry();
  if (!Object.hasOwn(environments, environment)) {
    throw new Error(`Unknown deployment environment: ${environment}`);
  }
  return environments[environment];
}

export function requireHostedDeploymentSettings(settings: DeploymentTargetSettings): DeploymentEnvironmentSettings {
  if (!settings.clusterProjectId) {
    throw new Error(`Deployment target ${settings.targetId} has no hosted deployment settings`);
  }
  return settings as DeploymentEnvironmentSettings;
}

export function deploymentEnvironmentSettings(
  environment: DeploymentEnvironment,
): DeploymentEnvironmentSettings & { name: DeploymentEnvironment } {
  const settings = requireHostedDeploymentSettings(activeDeploymentTargetSettings(environment));
  return { ...settings, name: environment };
}

export function deploymentTargetSettings(targetId: string): DeploymentTargetSettings {
  const { targets } = loadRegistry();
  if (!Object.hasOwn(targets, targetId)) {
    throw new Error(`Unknown deployment target: ${targetId}`);
  }
  return targets[targetId];
}

export function hostedDeploymentTargetSettings(targetId: string): DeploymentEnvironmentSettings {
  return requireHostedDeploymentSettings(deploymentTargetSettings(targetId));
}

export function deploymentSettingsForRuntime(input: {
  namespace: string;
  targetId?: string;
}): DeploymentTargetSettings {
  if (input.targetId !== undefined) {
    const target = deploymentTargetSettings(input.targetId);
    if (target.namespace !== input.namespace) {
      throw new Error(
        `Deployment target ${input.targetId} belongs to namespace ${target.namespace}, not ${input.namespace}`,
      );
    }
    return target;
  }

  const target = Object.values(loadRegistry().targets).find((settings) => settings.namespace === input.namespace);
  if (!target) {
    throw new Error(`Unknown deployment environment for namespace: ${input.namespace}`);
  }
  return activeDeploymentTargetSettings(target.name);
}

export function deploymentTargetForFirebaseProject(
  projectId: string,
): DeploymentEnvironmentSettings {
  const target = Object.values(loadRegistry().targets).find(
    (candidate) => candidate.firebaseProjectId === projectId,
  );
  if (!target) {
    throw new Error(`Unknown Firebase deployment project: ${projectId}`);
  }
  return requireHostedDeploymentSettings(target);
}

export function deploymentTargetsForEnvironment(
  environment: DeploymentEnvironment,
): DeploymentEnvironmentSettings[] {
  return Object.values(loadRegistry().targets)
    .filter((target) => target.name === environment)
    .map(requireHostedDeploymentSettings);
}

export function deploymentEnvironmentForNamespace(
  namespace: string,
): string {
  const entry = Object.values(loadRegistry().targets).find((value) => value.namespace === namespace);
  return entry?.name ?? "unknown";
}

export function deploymentEnvironmentForProject(
  projectId: string,
): ResolvedDeploymentEnvironment {
  const entry = Object.values(loadRegistry().targets).find(
    (value) => value.firebaseProjectId === projectId,
  );
  return entry?.name === "test" || entry?.name === "prod" ? entry.name : "unknown";
}

export function publicAppOriginsForTarget(settings: DeploymentTargetSettings): string[] {
  if (!settings.firebaseProjectId || !settings.hostingProjectId) {
    return [settings.siteOrigin, settings.appOrigin];
  }
  const project = settings.firebaseProjectId;
  if (settings.name === "prod") {
    return [
      settings.siteOrigin,
      settings.appOrigin,
      "https://www.octogee.com",
      "https://octogee.web.app",
      "https://app-octogee.web.app",
      "https://octogee.firebaseapp.com",
      "https://app-octogee.firebaseapp.com",
    ];
  }
  return [
    settings.siteOrigin,
    settings.appOrigin,
    `https://app-${settings.hostingProjectId}.web.app`,
    `https://${project}.firebaseapp.com`,
    `https://app-${project}.firebaseapp.com`,
  ];
}
