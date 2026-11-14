#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type DeploymentTargetSettings,
  activeDeploymentTargetSettings,
  deploymentTargetSettings,
} from "./deployment-environment.js";

export type DeploymentTargetOutputFormat = "github" | "json";

export function isDeploymentTargetResolverEntrypoint(
  moduleUrl: string,
  entrypoint: string | undefined,
): boolean {
  if (!entrypoint) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entrypoint);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
    return moduleUrl === pathToFileURL(entrypoint).href;
  }
}

export function resolveDeploymentTargetArguments(
  argv: readonly string[],
): DeploymentTargetSettings {
  let environment: string | undefined;
  let targetId: string | undefined;

  for (const argument of argv) {
    if (argument.startsWith("--environment=")) {
      environment = argument.slice("--environment=".length);
    } else if (argument.startsWith("--target=")) {
      targetId = argument.slice("--target=".length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if ((environment === undefined) === (targetId === undefined)) {
    throw new Error("Exactly one of --environment or --target is required");
  }
  if (environment !== undefined) {
    return activeDeploymentTargetSettings(environment);
  }
  return deploymentTargetSettings(targetId as string);
}

function deploymentTargetOutput(
  settings: DeploymentTargetSettings,
): Record<string, string | undefined> {
  return {
    environment: settings.name,
    target_id: settings.targetId,
    lifecycle: settings.lifecycle,
    secret_name_suffix: settings.secretNameSuffix,
    cluster_project_id: settings.clusterProjectId,
    firebase_project_id: settings.firebaseProjectId,
    hosting_project_id: settings.hostingProjectId,
    customer_hosting_project_id: settings.customerHostingProjectId,
    region: settings.region,
    cluster_name: settings.clusterName,
    kube_context: settings.kubeContext,
    namespace: settings.namespace,
    artifact_registry_project_id: settings.artifactRegistryProjectId,
    artifact_registry_location: settings.artifactRegistryLocation,
    artifact_registry_name: settings.artifactRegistryName,
    artifact_registry_repository: settings.artifactRegistryRepository,
    cloud_sql_project_id: settings.cloudSqlProjectId,
    cloud_sql_region: settings.cloudSqlRegion,
    cloud_sql_instance_name: settings.cloudSqlInstanceName,
    cloud_sql_connection_name: settings.cloudSqlConnectionName,
    cloud_sql_mattermost_password_secret_name:
      settings.cloudSqlMattermostPasswordSecretName,
    cloud_sql_gitea_password_secret_name: settings.cloudSqlGiteaPasswordSecretName,
    cloud_sql_connection_name_secret_name: settings.cloudSqlConnectionNameSecretName,
    cloud_sql_point_in_time_recovery_enabled: settings.cloudSqlPointInTimeRecoveryEnabled?.toString(),
    cloud_sql_platform_state_instance_name: settings.cloudSqlPlatformStateInstanceName,
    cloud_sql_agent_store_database_name: settings.cloudSqlAgentStoreDatabaseName,
    kms_project_id: settings.kmsProjectId,
    kms_location: settings.kmsLocation,
    kms_key_name: settings.kmsKeyName,
    storage_project_id: settings.storageProjectId,
    storage_location: settings.storageLocation,
    site_origin: settings.siteOrigin,
    app_origin: settings.appOrigin,
    api_origin: settings.apiOrigin,
    git_origin: settings.gitOrigin,
    mattermost_origin: settings.mattermostOrigin,
    preview_origin: settings.previewOrigin,
    gateway_values_file: settings.gatewayValuesFile,
    pin_environment: settings.pinEnvironment,
    network_policy_enforce_default_deny: String(settings.networkBoundary !== undefined),
    network_policy_control_plane_cidr: settings.networkBoundary?.controlPlaneCidr ?? "",
    network_policy_private_services_cidr: settings.networkBoundary?.privateServicesCidr ?? "",
  };
}

export function formatDeploymentTargetOutput(
  settings: DeploymentTargetSettings,
  format: DeploymentTargetOutputFormat,
): string {
  const output = deploymentTargetOutput(settings);
  if (format === "json") {
    return JSON.stringify(output);
  }
  return Object.entries(output)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => {
      if (value.includes("\n") || value.includes("\r")) {
        throw new Error(`Deployment target output ${key} contains a newline`);
      }
      return `${key}=${value}\n`;
    })
    .join("");
}

export function runDeploymentTargetResolver(argv: readonly string[]): string {
  let format: DeploymentTargetOutputFormat = "github";
  let rejectCandidateTarget = false;
  const selectorArguments: string[] = [];
  for (const argument of argv) {
    if (argument.startsWith("--format=")) {
      const value = argument.slice("--format=".length);
      if (value !== "github" && value !== "json") {
        throw new Error(`Unknown output format: ${value}`);
      }
      format = value;
    } else if (argument === "--reject-candidate-target") {
      rejectCandidateTarget = true;
    } else {
      selectorArguments.push(argument);
    }
  }
  const settings = resolveDeploymentTargetArguments(selectorArguments);
  if (rejectCandidateTarget && settings.lifecycle === "candidate") {
    throw new Error(
      `Deployment target ${settings.targetId} is a candidate and cannot be used for release or build automation`,
    );
  }
  return formatDeploymentTargetOutput(
    settings,
    format,
  );
}

if (isDeploymentTargetResolverEntrypoint(import.meta.url, process.argv[1])) {
  try {
    process.stdout.write(runDeploymentTargetResolver(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
