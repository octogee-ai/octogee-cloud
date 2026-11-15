import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(0, "utf8"));
assert.equal(manifest.schemaVersion, 1, "unsupported isolated tool groups schema");
assert(Array.isArray(manifest.groups), "Isolated tool groups must be an array");
const isStringList = (value) => Array.isArray(value)
  && value.every((entry) => typeof entry === "string" && entry.length > 0);
for (const group of manifest.groups) {
  assert.equal(typeof group.enabled, "boolean", "Isolated tool group enabled must be boolean");
  assert(["base", "npm"].includes(group.delivery), "unsupported isolated tool group delivery");
  if (group.enabled && group.delivery === "base") {
    for (const key of ["debianPackages", "baseImagePackages", "commands"]) {
      assert(group[key] === undefined || isStringList(group[key]), `invalid isolated tool group ${key}`);
    }
  }
}
assert(isStringList(manifest.pythonPackages) && manifest.pythonPackages.length > 0,
  "Isolated toolchain Python packages must be a nonempty string array");
for (const name of ["gcloud", "gh", "helm", "terraform", "yq"]) {
  const version = manifest.standaloneTools?.[name]?.version;
  assert(typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version),
    `invalid isolated toolchain standalone ${name} version`);
}
assert(/^[a-f0-9]{64}$/.test(manifest.standaloneTools.gcloud.sha256 ?? ""),
  "invalid isolated toolchain gcloud checksum");
process.stdout.write(`${JSON.stringify({
  schemaVersion: manifest.schemaVersion,
  groups: manifest.groups.filter((group) => group.enabled && group.delivery === "base"),
  pythonPackages: manifest.pythonPackages,
  standaloneTools: manifest.standaloneTools,
})}\n`);
