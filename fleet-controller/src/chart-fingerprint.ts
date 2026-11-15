import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";

export function computeChartFingerprint(chartPath: string): string {
  const hash = createHash("sha256");
  for (const rel of walkSorted(chartPath)) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(chartPath, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function walkSorted(root: string): string[] {
  const out: string[] = [];
  const walk = (relDir: string): void => {
    const abs = relDir === "" ? root : join(root, relDir);
    const entries = readdirSync(abs).sort();
    for (const entry of entries) {
      const relPath = relDir === "" ? entry : `${relDir}/${entry}`;
      const absPath = join(root, relPath);
      const st = lstatSync(absPath);
      if (st.isDirectory()) {
        walk(relPath);
      } else if (st.isFile()) {
        out.push(relPath);
      }
    }
  };
  walk("");
  return out;
}
