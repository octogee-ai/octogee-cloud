import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildkitImagePaths, imagePaths, productFindings } from "./cloud-build.mjs";

const [digestFile, registry, output] = process.argv.slice(2);
if (!digestFile || !registry || !output) throw new Error("Usage: benchmark-image-paths.mjs <digests.json> <registry> <output-directory>");
const { platform, images } = JSON.parse(readFileSync(digestFile, "utf8"));
const runtimeFiles = new Set([".dockerenv", "dev/console", "etc/hostname", "etc/hosts", "etc/mtab", "etc/resolv.conf"]);
const comparable = paths => [...new Set(paths.map(path => path.replace(/^\.?\//, ""))
  .filter(path => !path.endsWith("/") && !runtimeFiles.has(path)))].sort();
const rows = [];
mkdirSync(output, { recursive: true });
for (const [name, digest] of Object.entries(images)) {
  const image = `${registry}/${name}@${digest}`;
  const beforeStart = performance.now();
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- docker is the build runner's own tool.
  execFileSync("docker", ["pull", "--quiet", image], { stdio: "inherit" });
  const before = await imagePaths(image);
  const beforeSeconds = (performance.now() - beforeStart) / 1000;
  const afterStart = performance.now();
  const after = await buildkitImagePaths(image, platform);
  const afterSeconds = (performance.now() - afterStart) / 1000;
  writeFileSync(join(output, `${name}.before.json`), JSON.stringify(before));
  writeFileSync(join(output, `${name}.after.json`), JSON.stringify(after));
  assert.deepEqual(comparable(after), comparable(before), `Filesystem inventory changed for ${image}`);
  const sourceExists = path => existsSync(join(process.cwd(), path));
  assert.deepEqual(productFindings(before, sourceExists), [], `Original tripwire rejected ${image}`);
  assert.deepEqual(productFindings(after, sourceExists), [], `BuildKit tripwire rejected ${image}`);
  rows.push({ image, beforeSeconds, afterSeconds, paths: comparable(after).length });
  const result = { platform, sourceSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, rows };
  writeFileSync(join(output, "timings.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(rows.at(-1)));
}
