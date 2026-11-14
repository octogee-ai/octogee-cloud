import { describe, expect, it } from "vitest";
import * as adminUserDirectoryRouterCore from "@octogee/core/admin-user-directory-router";
import * as adminShapeCore from "@octogee/core/admin-shape";
import * as agentModelTokenMaterializerCore from "@octogee/core/agent-model-token-materializer";
import * as artifactRegistryCore from "@octogee/core/artifact-registry";
import * as byosubOnboardingCore from "@octogee/core/byosub-onboarding";
import * as byosubRestoreCore from "@octogee/core/byosub-restore";
import * as byotSyncRuntimeCore from "@octogee/core/byot-sync-runtime";
import * as codexAuthHealthCore from "@octogee/core/codex-auth-health";
import * as firebaseCore from "@octogee/core/firebase";
import * as firebaseAuthHelpersCore from "@octogee/core/firebase-auth-helpers";
import * as fleetMigrationCore from "@octogee/core/fleet-migration";
import * as fleetMigrationClientCore from "@octogee/core/fleet-migration-client";
import * as fleetMigrationRunnerCore from "@octogee/core/fleet-migration-runner";
import * as gatewayDeviceIdentityCore from "@octogee/core/gateway-device-identity";
import * as hostingCore from "@octogee/core/hosting";
import * as imageTagCore from "@octogee/core/image-tag";
import * as mattermostAdminCredsCore from "@octogee/core/mattermost/admin-creds";
import * as mattermostAvatarsCore from "@octogee/core/mattermost/avatars";
import * as mattermostChannelMembersCore from "@octogee/core/mattermost/channel-members";
import * as mattermostChannelsCore from "@octogee/core/mattermost/channels";
import * as mattermostClientCore from "@octogee/core/mattermost/client";
import * as mattermostUserPatCore from "@octogee/core/mattermost/user-pat";
import * as mattermostDefaultAgentPatCore from "@octogee/core/mattermost/default-agent-pat";
import * as mattermostNukeCore from "@octogee/core/mattermost/nuke";
import * as mattermostProvisionCore from "@octogee/core/mattermost/provision";
import * as notificationsCore from "@octogee/core/notifications";
import * as secretManagerCore from "@octogee/core/secret-manager";
import * as tierTemplateFilesCore from "@octogee/core/tier-template-files";
import * as usageLogTailerCore from "@octogee/core/usage-log-tailer";
import * as workspaceSlugsCore from "@octogee/core/workspace-slugs";
import * as adminUserDirectoryRouterShim from "../lib/admin-user-directory-router.js";
import * as adminShapeShim from "../lib/admin-shape.js";
import * as agentModelTokenMaterializerShim from "../lib/agent-model-token-materializer.js";
import * as artifactRegistryShim from "../lib/artifact-registry.js";
import * as byosubOnboardingShim from "../lib/byosub-onboarding.js";
import * as byosubRestoreShim from "../lib/byosub-restore.js";
import * as byotSyncRuntimeShim from "../lib/byot-sync-runtime.js";
import * as codexAuthHealthShim from "../lib/codex-auth-health.js";
import * as firebaseShim from "../lib/firebase.js";
import * as firebaseAuthHelpersShim from "../lib/firebase-auth-helpers.js";
import * as fleetMigrationShim from "../lib/fleet-migration.js";
import * as fleetMigrationClientShim from "../lib/fleet-migration-client.js";
import * as fleetMigrationRunnerShim from "../lib/fleet-migration-runner.js";
import * as gatewayDeviceIdentityShim from "../lib/gateway-device-identity.js";
import * as hostingShim from "../lib/hosting.js";
import * as imageTagShim from "../lib/image-tag.js";
import * as mattermostAdminCredsShim from "../lib/mattermost/admin-creds.js";
import * as mattermostAvatarsShim from "../lib/mattermost/avatars.js";
import * as mattermostChannelMembersShim from "../lib/mattermost/channel-members.js";
import * as mattermostChannelsShim from "../lib/mattermost/channels.js";
import * as mattermostClientShim from "../lib/mattermost/client.js";
import * as mattermostUserPatShim from "../lib/mattermost/user-pat.js";
import * as mattermostDefaultAgentPatShim from "../lib/mattermost/default-agent-pat.js";
import * as mattermostNukeShim from "../lib/mattermost/nuke.js";
import * as mattermostProvisionShim from "../lib/mattermost/provision.js";
import * as notificationsShim from "../lib/notifications.js";
import * as secretManagerShim from "../lib/secret-manager.js";
import * as tierTemplateFilesShim from "../lib/tier-template-files.js";
import * as usageLogTailerShim from "../lib/usage-log-tailer.js";
import * as workspaceSlugsShim from "../lib/workspace-slugs.js";

const shims = [
  ["admin-user-directory-router", adminUserDirectoryRouterShim, adminUserDirectoryRouterCore],
  ["admin-shape", adminShapeShim, adminShapeCore],
  ["agent-model-token-materializer", agentModelTokenMaterializerShim, agentModelTokenMaterializerCore],
  ["artifact-registry", artifactRegistryShim, artifactRegistryCore],
  ["byosub-onboarding", byosubOnboardingShim, byosubOnboardingCore],
  ["byosub-restore", byosubRestoreShim, byosubRestoreCore],
  ["byot-sync-runtime", byotSyncRuntimeShim, byotSyncRuntimeCore],
  ["codex-auth-health", codexAuthHealthShim, codexAuthHealthCore],
  ["firebase", firebaseShim, firebaseCore],
  ["firebase-auth-helpers", firebaseAuthHelpersShim, firebaseAuthHelpersCore],
  ["fleet-migration", fleetMigrationShim, fleetMigrationCore],
  ["fleet-migration-client", fleetMigrationClientShim, fleetMigrationClientCore],
  ["fleet-migration-runner", fleetMigrationRunnerShim, fleetMigrationRunnerCore],
  ["gateway-device-identity", gatewayDeviceIdentityShim, gatewayDeviceIdentityCore],
  ["hosting", hostingShim, hostingCore],
  ["image-tag", imageTagShim, imageTagCore],
  ["mattermost/admin-creds", mattermostAdminCredsShim, mattermostAdminCredsCore],
  ["mattermost/avatars", mattermostAvatarsShim, mattermostAvatarsCore],
  ["mattermost/channel-members", mattermostChannelMembersShim, mattermostChannelMembersCore],
  ["mattermost/channels", mattermostChannelsShim, mattermostChannelsCore],
  ["mattermost/client", mattermostClientShim, mattermostClientCore],
  ["mattermost/user-pat", mattermostUserPatShim, mattermostUserPatCore],
  ["mattermost/default-agent-pat", mattermostDefaultAgentPatShim, mattermostDefaultAgentPatCore],
  ["mattermost/nuke", mattermostNukeShim, mattermostNukeCore],
  ["mattermost/provision", mattermostProvisionShim, mattermostProvisionCore],
  ["notifications", notificationsShim, notificationsCore],
  ["secret-manager", secretManagerShim, secretManagerCore],
  ["tier-template-files", tierTemplateFilesShim, tierTemplateFilesCore],
  ["usage-log-tailer", usageLogTailerShim, usageLogTailerCore],
  ["workspace-slugs", workspaceSlugsShim, workspaceSlugsCore],
] as const;

describe("core re-export shims", () => {
  it.each(shims)("%s mirrors the core export surface", (_name, shim, core) => {
    expect(Object.keys(shim).sort()).toEqual(Object.keys(core).sort());
  });
});
