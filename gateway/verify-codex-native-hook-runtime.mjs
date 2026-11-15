import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageJson = process.argv[2];
if (!packageJson) throw new Error("Codex package.json path is required");
const dist = path.join(path.dirname(path.resolve(packageJson)), "dist");
const consumers = [];
for (const file of await readdir(dist, { recursive: true })) {
  if (!/\.(?:m?js)$/.test(file)) continue;
  const absolute = path.join(dist, file);
  const source = await readFile(absolute, "utf8");
  if (source.includes("openclaw/plugin-sdk/native-hook-relay-runtime")) consumers.push(absolute);
}
if (consumers.length === 0) throw new Error("Codex native-hook relay consumer is absent");
for (const file of consumers) await import(pathToFileURL(file).href);
console.log(`Codex native-hook runtime gate: PASS (${consumers.length} modules)`);
