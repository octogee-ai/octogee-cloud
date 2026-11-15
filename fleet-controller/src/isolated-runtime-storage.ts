import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import type { GatewayRuntime } from "@octogee/shared/types/glm";
import { userHomeOwner } from "./user-home-migration.js";

interface IsolatedRuntimeStorageInput {
  store: Pick<PlatformStateRepositories, "users">;
  runtime: GatewayRuntime;
  ownerUid: string | null;
}

export async function assertIsolatedRuntimeStorage(input: IsolatedRuntimeStorageInput): Promise<void> {
  if (input.runtime === "cluster") return;
  if (!input.ownerUid) throw new Error("Isolated runtime requires its storage owner");
  const owner = await input.store.users.records.get(input.ownerUid);
  if (!owner) throw new Error("User storage owner is missing");
  const home = userHomeOwner(owner);
  const storage = home.homeStorage;
  if (!storage) return;
  if (storage.runtime !== "gce-vm") throw new Error("User primary home is not a native home");
  if (!/^\d+$/u.test(storage.disk?.id ?? "")) throw new Error("User migrated home identity is malformed");
  if (home.homeDisk?.id !== storage.disk.id || home.homeDisk.source !== storage.disk.source) throw new Error("User migrated native home differs");
}
