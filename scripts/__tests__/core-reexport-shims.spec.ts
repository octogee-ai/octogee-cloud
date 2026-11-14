import { describe, expect, it } from "vitest";
import * as agentModelTokenMaterializerCore from "@octogee/core/agent-model-token-materializer";
import * as byosubOnboardingCore from "@octogee/core/byosub-onboarding";
import * as byosubRestoreCore from "@octogee/core/byosub-restore";
import * as byotSyncRuntimeCore from "@octogee/core/byot-sync-runtime";
import * as firebaseCore from "@octogee/core/firebase";
import * as secretManagerCore from "@octogee/core/secret-manager";
import * as tierTemplateFilesCore from "@octogee/core/tier-template-files";
import * as usageLogTailerCore from "@octogee/core/usage-log-tailer";
import * as agentModelTokenMaterializerShim from "../lib/agent-model-token-materializer.js";
import * as byosubOnboardingShim from "../lib/byosub-onboarding.js";
import * as byosubRestoreShim from "../lib/byosub-restore.js";
import * as byotSyncRuntimeShim from "../lib/byot-sync-runtime.js";
import * as firebaseShim from "../lib/firebase.js";
import * as secretManagerShim from "../lib/secret-manager.js";
import * as tierTemplateFilesShim from "../lib/tier-template-files.js";
import * as usageLogTailerShim from "../lib/usage-log-tailer.js";

const shims = [
  ["agent-model-token-materializer", agentModelTokenMaterializerShim, agentModelTokenMaterializerCore],
  ["byosub-onboarding", byosubOnboardingShim, byosubOnboardingCore],
  ["byosub-restore", byosubRestoreShim, byosubRestoreCore],
  ["byot-sync-runtime", byotSyncRuntimeShim, byotSyncRuntimeCore],
  ["firebase", firebaseShim, firebaseCore],
  ["secret-manager", secretManagerShim, secretManagerCore],
  ["tier-template-files", tierTemplateFilesShim, tierTemplateFilesCore],
  ["usage-log-tailer", usageLogTailerShim, usageLogTailerCore],
] as const;

describe("core re-export shims", () => {
  it.each(shims)("%s mirrors the core export surface", (_name, shim, core) => {
    expect(Object.keys(shim).sort()).toEqual(Object.keys(core).sort());
  });
});
