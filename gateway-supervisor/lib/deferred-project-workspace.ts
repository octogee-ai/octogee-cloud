import * as fs from "fs";
import * as path from "path";

import { log, CUSTOMERS_DIR } from "./config.js";
import { isValidProjectId, isValidUsername } from "@octogee/shared/types/identity";

const OPENCLAW_WORKSPACE_MARKER_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
] as const;

export function deferredProjectPlaceholder(slug: string, projectSlug: string): string {
  return [
    `# ${projectSlug}`,
    "",
    `This project's source lives on GitHub and is checked out on ${slug}'s own`,
    "isolated runtime, not here. Files you expect may be absent until then.",
    "",
    "Replace this file once the checkout lands.",
    "",
  ].join("\n");
}

export function seedDeferredProjectWorkspace(slug: string, projectSlug: string): boolean {
  const dest = path.join(CUSTOMERS_DIR, slug, "projects", projectSlug);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  if (OPENCLAW_WORKSPACE_MARKER_FILES.some((name) => fs.lstatSync(path.join(dest, name), { throwIfNoEntry: false }))) {
    return false;
  }
  try {
    fs.writeFileSync(path.join(dest, "AGENTS.md"), deferredProjectPlaceholder(slug, projectSlug), {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  log(`[git] ${slug}/${projectSlug} checkout deferred — seeded a placeholder workspace`);
  return true;
}

export function deferredProjectPlaceholderPaths(stateDir: string, slug: string): string[] {
  if (!isValidUsername(slug)) throw new Error("invalid deferred project workspace owner");
  const projects = path.join(stateDir, "customers", slug, "projects");
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(projects, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap(entry => {
    if (!entry.isDirectory() || !isValidProjectId(entry.name)) return [];
    const filename = path.join(projects, entry.name, "AGENTS.md");
    const expected = Buffer.from(deferredProjectPlaceholder(slug, entry.name));
    if (!isDeferredPlaceholder(filename, expected)) return [];
    return [`customers/${slug}/projects/${entry.name}/AGENTS.md`];
  });
}

function isDeferredPlaceholder(filename: string, expected: Buffer): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return false;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== expected.length) return false;
    const actual = Buffer.alloc(expected.length + 1);
    let size = 0;
    while (size < actual.length) {
      const read = fs.readSync(fd, actual, size, actual.length - size, size);
      if (read === 0) break;
      size += read;
    }
    return size === expected.length && actual.subarray(0, size).equals(expected);
  } finally {
    fs.closeSync(fd);
  }
}
