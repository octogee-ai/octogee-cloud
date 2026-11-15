import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearMigrationStaging, liveImportAdmissionPath, migrationStagingDirectory, prepareMigrationStaging, readLiveImportAdmission, writeLiveImportAdmission } from "../lib/migration-staging.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const identity = { gatewayId: "target", instanceId: "boot-1", migrationId: "migration-1", slug: "alice", configTransferMode: "activation-manifest" };
async function root() { const value = await fs.mkdtemp(path.join(os.tmpdir(), "migration-stage-test-")); roots.push(value); return value; }

describe("migration staging", () => {
  it("retains prepared files for the same migration and clears them on cancellation", async () => {
    const base = await root();
    const stage = await prepareMigrationStaging(base, identity);
    await fs.writeFile(path.join(stage, "workspace"), "prepared");
    expect(await prepareMigrationStaging(base, identity)).toBe(stage);
    expect(await fs.readFile(path.join(stage, "workspace"), "utf8")).toBe("prepared");
    await clearMigrationStaging(base, identity);
    await expect(fs.stat(stage)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["gatewayId", "instanceId", "migrationId", "slug", "configTransferMode"] as const)("never reuses another %s's staging", async (field) => {
    const base = await root();
    expect(migrationStagingDirectory(base, { ...identity, [field]: "different" })).not.toBe(migrationStagingDirectory(base, identity));
  });
  it("refuses a symlink at the staging boundary", async () => {
    const base = await root();
    await fs.symlink(base, migrationStagingDirectory(base, identity));
    await expect(prepareMigrationStaging(base, identity)).rejects.toThrow();
  });
  it("keeps a live import admission decision past staging cleanup", async () => {
    const base = await root();
    expect(await readLiveImportAdmission(base, identity)).toBeNull();
    await prepareMigrationStaging(base, identity);
    await writeLiveImportAdmission(base, identity, "refused");
    await clearMigrationStaging(base, identity);
    expect(await readLiveImportAdmission(base, identity)).toBe("refused");
    await writeLiveImportAdmission(base, identity, "admitted");
    expect(await readLiveImportAdmission(base, identity)).toBe("admitted");
  });
  it("rejects a live import admission recorded for another migration", async () => {
    const base = await root();
    await writeLiveImportAdmission(base, { ...identity, migrationId: "migration-2" }, "admitted");
    await fs.rename(liveImportAdmissionPath(base, { ...identity, migrationId: "migration-2" }), liveImportAdmissionPath(base, identity));
    await expect(readLiveImportAdmission(base, identity)).rejects.toThrow("does not match its migration");
  });
});
