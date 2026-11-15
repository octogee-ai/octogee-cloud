import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readToolchainStatus } from "./isolated-toolchain-hydrator.js";

export async function waitForPreparedIsolatedToolchain(input: {
  root: string;
  lockSha256: string;
  groupsSha256: string;
  timeoutMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (input.timeoutMs ?? 180_000);
  while (true) {
    const status = await readToolchainStatus(input.root);
    if (status?.status === "ready") {
      const installed = await fs.readFile(path.join(input.root, "active", ".toolchain-lock.json"), "utf8")
        .then(value => JSON.parse(value) as { lockSha256?: string; groupsSha256?: string })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (installed?.lockSha256 === input.lockSha256 && installed.groupsSha256 === input.groupsSha256) return;
    }
    if (now() >= deadline) throw new Error("User preparation timed out waiting for its pinned toolchain");
    await wait(1_000);
  }
}
