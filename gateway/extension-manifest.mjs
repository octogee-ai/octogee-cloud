import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const EXTENSION_DIRECTORY = /^octogee-.+-tools$/u;

export function extensionDirectories(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && EXTENSION_DIRECTORY.test(entry.name))
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => existsSync(path.join(dir, "openclaw.plugin.json")))
    .sort();
}

export function readExtensionPackage(dir) {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
}

export function runtimeDependencies(dir) {
  return Object.keys(readExtensionPackage(dir).dependencies ?? {}).sort();
}
