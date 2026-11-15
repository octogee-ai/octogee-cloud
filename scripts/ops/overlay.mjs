#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const COMPOSITION_ROOTS = ["src/main.ts"];
const BUILD_OUTPUTS = new Set(["node_modules", "dist"]);
const UNLINKED = new Set([".git", ...BUILD_OUTPUTS]);
const STANDALONE_MANIFEST = "package.json";

function sourceEntries(root) {
  const entries = new Map();
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (BUILD_OUTPUTS.has(entry.name)) continue;
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isSymbolicLink()) entries.set(file, { link: fs.readlinkSync(path.join(root, file)) });
      else entries.set(file, { from: path.join(root, file) });
    }
  };
  walk("");
  return entries;
}

function readRegularFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Overlay file is not regular: ${file}`);
    return { bytes: fs.readFileSync(fd), mode: stat.mode };
  } finally {
    fs.closeSync(fd);
  }
}

function writeEntry(target, entry) {
  const current = fs.lstatSync(target, { throwIfNoEntry: false });
  if (entry.link !== undefined) {
    if (current?.isSymbolicLink() && fs.readlinkSync(target) === entry.link) return;
    if (current) fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(entry.link, target);
    return;
  }
  const { bytes, mode } = readRegularFile(entry.from);
  if (current?.isFile()) {
    try {
      if (readRegularFile(target).bytes.equals(bytes)) return;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ELOOP") throw error;
    }
  }
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, ".overlay-copy-"));
  try {
    const pending = path.join(staging, "file");
    fs.writeFileSync(pending, bytes, { mode, flag: "wx" });
    if (current?.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(pending, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function removeStale(root, desired, relative = "") {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const file = path.posix.join(relative, entry.name);
    if (BUILD_OUTPUTS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      removeStale(root, desired, file);
      if (fs.readdirSync(path.join(root, file)).length === 0) fs.rmdirSync(path.join(root, file));
    } else if (!desired.has(file)) {
      fs.rmSync(path.join(root, file), { recursive: true, force: true });
    }
  }
}

function mergePackage(platformPackage, productPackage, outPackage) {
  const merged = sourceEntries(platformPackage);
  const platformFiles = merged.size;
  const overlay = sourceEntries(productPackage);
  const shadowed = [...overlay.keys()].filter((file) => merged.has(file) && !COMPOSITION_ROOTS.includes(file));
  if (shadowed.length) {
    throw new Error(`${productPackage} shadows platform files: ${shadowed.join(", ")}; only ${COMPOSITION_ROOTS.join(" and ")} may be replaced`);
  }
  for (const [file, entry] of overlay) merged.set(file, entry);
  const current = fs.lstatSync(outPackage, { throwIfNoEntry: false });
  if (current && !current.isDirectory()) fs.rmSync(outPackage, { force: true });
  fs.mkdirSync(outPackage, { recursive: true });
  for (const [file, entry] of merged) writeEntry(path.join(outPackage, file), entry);
  removeStale(outPackage, new Set(merged.keys()));
  return { platformFiles, productFiles: overlay.size, replaced: COMPOSITION_ROOTS.filter((file) => overlay.has(file)) };
}

export function overlayTree({ platform, product, out }) {
  const overlays = fs.readdirSync(product, { withFileTypes: true }).filter((entry) => {
    if (!entry.isDirectory()) throw new Error(`${path.join(product, entry.name)} is not a package directory`);
    return !fs.existsSync(path.join(product, entry.name, STANDALONE_MANIFEST));
  });
  for (const entry of overlays) {
    if (!fs.statSync(path.join(platform, entry.name), { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`${path.join(product, entry.name)} has no platform package at ${path.join(platform, entry.name)}`);
    }
  }
  const packages = new Set(overlays.map((entry) => entry.name));
  const platformEntries = fs.readdirSync(platform).filter((name) => !UNLINKED.has(name));
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(out)) {
    if (!platformEntries.includes(name)) fs.rmSync(path.join(out, name), { recursive: true, force: true });
  }
  const merged = {};
  for (const name of platformEntries) {
    const target = path.join(out, name);
    if (packages.has(name)) {
      merged[name] = mergePackage(path.join(platform, name), path.join(product, name), target);
    } else {
      writeEntry(target, { link: path.relative(out, path.join(platform, name)) });
    }
  }
  return merged;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [platform, product, out] = process.argv.slice(2);
  if (!platform || !product || !out) throw new Error("usage: overlay.mjs <platform-dir> <product-dir> <out-dir>");
  for (const [name, counts] of Object.entries(overlayTree({ platform, product, out }))) {
    console.log(`[overlay] ${path.join(out, name)}: ${counts.platformFiles} platform files, ${counts.productFiles} product files${counts.replaced.length ? `, product ${counts.replaced.join(", ")}` : ""}`);
  }
}
