import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { HeldNativeSourceBinding } from "@octogee/shared/types/fleet-controller";

type SourceBacking = Pick<HeldNativeSourceBinding, "vmId" | "bootId" | "bootDiskId" | "homeDiskId">;
type SourceHold = Omit<HeldNativeSourceBinding, "claimStartedAt">;

interface HeldNativeSourceDependencies {
  homeDirectory: string;
  readSourceBacking(): Promise<SourceBacking>;
  assertWorkerClaim(binding: HeldNativeSourceBinding): Promise<void>;
  assertOrdinaryWritersExcluded(hold: SourceHold): Promise<void>;
  assertOwnerStoreWritesHeld(hold: SourceHold): Promise<void>;
}

function backing({ vmId, bootId, bootDiskId, homeDiskId }: SourceHold): SourceBacking {
  return { vmId, bootId, bootDiskId, homeDiskId };
}

export async function acquireHeldNativeSourceKeeper(binding: HeldNativeSourceBinding, deps: HeldNativeSourceDependencies) {
  const pinned = structuredClone(binding);
  const { claimStartedAt: _, ...scope } = pinned;
  const mount = await open(deps.homeDirectory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  let closed = false;
  let inUse = false;
  let attempted = false;

  async function assertHeld() {
    if (closed) throw new Error("Held Native source keeper closed");
    await deps.assertWorkerClaim(pinned);
    const [localBacking, retained, current] = await Promise.all([
      deps.readSourceBacking(), mount.stat({ bigint: true }), stat(deps.homeDirectory, { bigint: true }),
    ]);
    if (!isDeepStrictEqual(localBacking, backing(scope)) || retained.dev !== current.dev || retained.ino !== current.ino) {
      throw new Error("Held Native source keeper lost the pinned boot or home backing");
    }
    await deps.assertOrdinaryWritersExcluded(scope);
    await deps.assertOwnerStoreWritesHeld(scope);
    await deps.assertWorkerClaim(pinned);
  }

  try {
    const lock = spawn("/usr/bin/flock", ["--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", mount.fd] });
    const [code] = await once(lock, "close");
    if (code !== 0) throw new Error("Held Native source home already has a writer or keeper");
    await assertHeld();
  } catch (error) {
    await mount.close();
    throw error;
  }

  return {
    assertHeld,
    async runExclusive<T>(candidate: HeldNativeSourceBinding, work: (assertHeld: () => Promise<void>) => Promise<T>): Promise<T> {
      if (!isDeepStrictEqual(candidate, pinned) || inUse || attempted) {
        throw new Error("Held Native source maintenance is stale, already running, or already attempted");
      }
      inUse = true;
      try {
        await assertHeld();
        attempted = true;
        const result = await work(assertHeld);
        await assertHeld();
        return result;
      } finally {
        inUse = false;
      }
    },
    async close() {
      if (inUse) throw new Error("Held Native source keeper cannot release its lock during maintenance");
      if (closed) return;
      closed = true;
      await mount.close();
    },
  };
}
