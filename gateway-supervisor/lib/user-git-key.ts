import * as fs from "node:fs";
import * as path from "node:path";
import type { GivenUpUserGitKey } from "@octogee/core/user-lifecycle";
import { isValidUsername } from "@octogee/shared/types/identity";
import { CUSTOMER_KEYS_DIR } from "./config.js";

export type ServiceGitKeyRelease = "released" | "not-configured" | "unknown-user";

export interface UserGitKeyReleaser {
  releaseServiceKey: (slug: string, publicKey: string) => Promise<ServiceGitKeyRelease>;
  releaseHostKey: (slug: string, publicKey: string) => Promise<void>;
  log: (message: string, fields?: { status: "failed" }) => void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicKeyOnDisk(keyDir: string): string | null {
  try {
    return fs.readFileSync(path.join(keyDir, "id_ed25519.pub"), "utf-8").trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function releaseRegistrations(slug: string, publicKey: string, releaser: UserGitKeyReleaser): Promise<void> {
  const failures: unknown[] = [];
  try {
    const service = await releaser.releaseServiceKey(slug, publicKey);
    if (service === "unknown-user") {
      releaser.log(`[git] ${slug}: the platform has no user for ${slug}, so the provisioning service holds no row for this pod's key`);
    }
  } catch (error) {
    releaser.log(`[git] ${slug}: ✖ provisioning service release failed for this pod's key: ${describe(error)}`, { status: "failed" });
    failures.push(error);
  }
  try {
    await releaser.releaseHostKey(slug, publicKey);
  } catch (error) {
    releaser.log(`[git] ${slug}: ✖ git host release failed for this pod's key: ${describe(error)}`, { status: "failed" });
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `[git] ${slug}: ${failures.map(describe).join("; ")}`);
}

export async function giveUpUserGitKey(slug: string, releaser: UserGitKeyReleaser): Promise<GivenUpUserGitKey> {
  if (!isValidUsername(slug)) throw new Error("Invalid SSH key owner");
  const keyDir = path.join(CUSTOMER_KEYS_DIR, slug);
  if (!fs.existsSync(keyDir)) return "absent";
  const publicKey = publicKeyOnDisk(keyDir);
  if (publicKey === null) {
    const held = fs.existsSync(path.join(keyDir, "id_ed25519"));
    await fs.promises.rm(keyDir, { recursive: true, force: true });
    if (!held) return "absent";
    releaser.log(
      `[git] ${slug}: ✖ the public key cannot be read, so the key was deleted without releasing its registration; ` +
      "the key sweeps remove a registration under this pod's title once this pod is gone",
      { status: "failed" },
    );
    return "unreleasable";
  }
  await releaseRegistrations(slug, publicKey, releaser);
  await fs.promises.rm(keyDir, { recursive: true, force: true });
  return "released";
}
