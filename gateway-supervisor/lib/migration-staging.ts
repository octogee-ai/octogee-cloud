import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface MigrationStagingIdentity {
  gatewayId: string;
  instanceId: string;
  migrationId: string;
  slug: string;
  configTransferMode: string;
}

export function migrationStagingDirectory(root: string, identity: MigrationStagingIdentity): string {
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return path.join(root, `octogee-migration-stage-${key}`);
}

export async function prepareMigrationStaging(root: string, identity: MigrationStagingIdentity): Promise<string> {
  const directory = migrationStagingDirectory(root, identity);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("migration staging is not a private directory");
  if (await fs.realpath(directory) !== path.join(await fs.realpath(root), path.basename(directory))) throw new Error("migration staging is not canonical");
  const stage = path.join(directory, "stage");
  await fs.mkdir(stage, { recursive: true, mode: 0o700 });
  const staged = await fs.lstat(stage);
  if (!staged.isDirectory() || staged.isSymbolicLink() || (staged.mode & 0o077) !== 0) throw new Error("migration stage is not a private directory");
  return stage;
}

export async function clearMigrationStaging(root: string, identity: MigrationStagingIdentity): Promise<void> {
  await fs.rm(migrationStagingDirectory(root, identity), { recursive: true, force: true });
}

export type LiveImportAdmission = "admitted" | "refused";

const LIVE_IMPORT_ADMISSIONS: readonly LiveImportAdmission[] = ["admitted", "refused"];

export function liveImportAdmissionPath(root: string, identity: MigrationStagingIdentity): string {
  return `${migrationStagingDirectory(root, identity)}.live-admission.json`;
}

export async function readLiveImportAdmission(
  root: string,
  identity: MigrationStagingIdentity,
): Promise<LiveImportAdmission | null> {
  let raw: string;
  try {
    raw = await fs.readFile(liveImportAdmissionPath(root, identity), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const record = JSON.parse(raw) as { migrationId?: unknown; slug?: unknown; decision?: unknown };
  if (record.migrationId !== identity.migrationId || record.slug !== identity.slug ||
    !(LIVE_IMPORT_ADMISSIONS as readonly unknown[]).includes(record.decision)) {
    throw new Error("live import admission record does not match its migration");
  }
  return record.decision as LiveImportAdmission;
}

export async function writeLiveImportAdmission(
  root: string,
  identity: MigrationStagingIdentity,
  decision: LiveImportAdmission,
): Promise<void> {
  const file = liveImportAdmissionPath(root, identity);
  const temporary = `${file}.${process.pid}.tmp`;
  const record = { migrationId: identity.migrationId, slug: identity.slug, decision, recordedAt: Date.now() };
  await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flush: true });
  await fs.rename(temporary, file);
}
