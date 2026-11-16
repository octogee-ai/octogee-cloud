import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { denyListHits, formatRefusal, type DenyHit } from "../lib/factory-deny-list.js";

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);

export interface TreeScan {
  files: number;
  hits: DenyHit[];
}

function readTree(root: string, directory: string, files: Map<string, string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) readTree(root, path, files);
    } else if (entry.isFile()) {
      const content = readFileSync(path);
      if (!content.includes(0)) files.set(relative(root, path).split("\\").join("/"), content.toString("utf8"));
    }
  }
}

export function scanTree(root: string): TreeScan {
  const files = new Map<string, string>();
  readTree(root, root, files);
  return { files: files.size, hits: denyListHits(files) };
}

function main(): void {
  const root = resolve(process.argv[2] ?? ".");
  const scan = scanTree(root);
  if (scan.hits.length) {
    console.error(formatRefusal(scan.hits));
    process.exit(1);
  }
  console.log(`deny list: clean across ${scan.files} files in ${root}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
