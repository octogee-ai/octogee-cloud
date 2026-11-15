import fs from "node:fs/promises";
import path from "node:path";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { upgradeImportedAgentStores } from "./openclaw-import-upgrade.js";
import { assertNotHeld, matchFiles, PROC_ROOT, sqliteFamily } from "./held-files.js";

export async function prepareUserSystemStore(input: {
  root: string;
  assertCurrent: () => Promise<void>;
  readAuthority?: () => Promise<string | undefined>;
  log: (message: string) => void;
  procRoot?: string;
  upgrade?: typeof upgradeImportedAgentStores;
}): Promise<void> {
  await input.assertCurrent();
  const authority = await input.readAuthority?.();
  const assertCurrent = input.readAuthority ? async () => {
    await input.assertCurrent();
    if (await input.readAuthority!() !== authority) throw new Error("User system-store allocation changed");
  } : input.assertCurrent;
  await assertCurrent();
  const agentId = "octogee-unmatched-route";
  const anchorPath = path.join(input.root, "agents", agentId, "agent", "openclaw-agent.sqlite");
  const stat = await fs.lstat(anchorPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isFile() || stat.nlink !== 1 || await fs.realpath(anchorPath) !== path.resolve(anchorPath)) {
    throw new Error("User system agent anchor is not canonical");
  }
  await assertNotHeld(matchFiles(sqliteFamily(anchorPath)), input.procRoot ?? PROC_ROOT, { ignoreReadOnlyConnections: true });
  const anchor = readPostgresAgentAnchor(anchorPath);
  if (!anchor) throw new Error("User system agent requires a PostgreSQL anchor");
  await (input.upgrade ?? upgradeImportedAgentStores)({ stores: [{ agentId, anchorPath, ...anchor }],
    assertCurrent, log: input.log });
  await assertCurrent();
}
