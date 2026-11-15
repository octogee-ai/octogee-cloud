import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SYSTEM_CONFIG_OPENCLAW_FILENAME = "openclaw.json";
export const SYSTEM_CONFIG_METADATA_FILENAME = ".octogee.json";
export const SYSTEM_CONFIG_GITIGNORE_FILENAME = ".gitignore";
export const SYSTEM_CONFIG_GITIGNORE = "*.bak\n*.tmp\n";
export const CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION = 5;
export const SYSTEM_CONFIG_SCHEMA_VERSION_MAC_LANE_REMOVED = 1;
export const SYSTEM_CONFIG_SCHEMA_VERSION_HOST_CODE_LOCKDOWN_LIFTED = 2;
export const SYSTEM_CONFIG_SCHEMA_VERSION_USER_AGENT_SHARED_FENCE_LIFTED = 5;
export const SYSTEM_CONFIG_LEGACY_MAC_STATE_CLEANUP = "legacy-mac";
export const SYSTEM_CONFIG_DURABLE_FILENAMES = [
  SYSTEM_CONFIG_OPENCLAW_FILENAME,
  SYSTEM_CONFIG_METADATA_FILENAME,
  SYSTEM_CONFIG_GITIGNORE_FILENAME,
] as const;

export type SystemConfigDurableFilename = typeof SYSTEM_CONFIG_DURABLE_FILENAMES[number];
export type ReadSystemConfigCommitBlob = (
  repoDir: string,
  commit: string,
  filename: SystemConfigDurableFilename,
) => Buffer | null;

const GIT_SHA_RE = /^[0-9a-f]{40,64}$/;

export const readSystemConfigCommitBlob: ReadSystemConfigCommitBlob = (
  repoDir,
  commit,
  filename,
) => {
  if (commit !== "HEAD" && !GIT_SHA_RE.test(commit)) return null;
  try {
    return execFileSync("/usr/bin/git", ["show", `${commit}:${filename}`], {
      cwd: repoDir,
      encoding: null,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
};

export function assertSystemConfigMetadata(contents: string): void {
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("system_config metadata must contain an object");
  }
  const metadata = parsed as Record<string, unknown>;
  if (
    !Number.isInteger(metadata.schemaVersion) ||
    (metadata.schemaVersion as number) < 0 ||
    (metadata.schemaVersion as number) > CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION
  ) {
    throw new Error("system_config metadata schemaVersion is invalid");
  }
  if (metadata.lastMigration !== undefined && typeof metadata.lastMigration !== "string") {
    throw new Error("system_config metadata lastMigration is invalid");
  }
  if (metadata.pendingStateCleanup !== undefined &&
      metadata.pendingStateCleanup !== SYSTEM_CONFIG_LEGACY_MAC_STATE_CLEANUP) {
    throw new Error("system_config metadata pendingStateCleanup is invalid");
  }
}

export function assertSystemConfigGitignore(contents: string): void {
  if (contents !== SYSTEM_CONFIG_GITIGNORE) {
    throw new Error("system_config .gitignore is invalid");
  }
}

export function assertSystemConfigSupportFiles(repoDir: string): void {
  assertSystemConfigMetadata(
    fs.readFileSync(path.join(repoDir, SYSTEM_CONFIG_METADATA_FILENAME), "utf8"),
  );
  assertSystemConfigGitignore(
    fs.readFileSync(path.join(repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME), "utf8"),
  );
}
