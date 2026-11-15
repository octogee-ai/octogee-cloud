import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";

export function readOpenClawFileSnapshot(file: string) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    const named = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || named.dev !== stat.dev || named.ino !== stat.ino || fs.realpathSync(file) !== path.resolve(file)) {
      throw new Error(`OpenClaw file is not canonical: ${file}`);
    }
    return { bytes: fs.readFileSync(fd), dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}

export function sameOpenClawFileSnapshot(expected: ReturnType<typeof readOpenClawFileSnapshot>, current: ReturnType<typeof readOpenClawFileSnapshot>): boolean {
  return current.dev === expected.dev && current.ino === expected.ino && current.bytes.equals(expected.bytes);
}

export function readPostgresAnchorSnapshot(bytes: Buffer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-anchor-"));
  try {
    const file = path.join(root, "anchor.sqlite");
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    return readPostgresAgentAnchor(file);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
