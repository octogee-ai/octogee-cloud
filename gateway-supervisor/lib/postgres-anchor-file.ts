import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

export async function publishAnchor(file: string, anchor: { storeId: string; schema: string }): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const staged = `${file}.anchor-${randomUUID()}.tmp`;
  try {
    const db = new DatabaseSync(staged);
    try {
      db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine = 'postgres'), schema TEXT NOT NULL)");
      db.prepare("INSERT INTO openclaw_engine_anchor (store_id, engine, schema) VALUES (?, 'postgres', ?)").run(anchor.storeId, anchor.schema);
    } finally {
      db.close();
    }
    await fs.chmod(staged, 0o600);
    await fs.link(staged, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await fs.rm(staged, { force: true });
  }
}

export async function assertUserStorePath(stateDir: string, file: string): Promise<void> {
  const root = path.resolve(stateDir);
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.resolve(file) !== file) {
    throw new Error(`User store path is not canonical and contained by its state root: ${file}`);
  }
  let current = root;
  for (const part of ["", ...relative.split(path.sep)]) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`User store path contains a symlink: ${current}`);
      if (stat.isFile() && stat.nlink !== 1) throw new Error(`User store path contains a hard link: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
