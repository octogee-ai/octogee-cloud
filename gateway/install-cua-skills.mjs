#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [openclawRoot, source, destination] = process.argv.slice(2);
if (!openclawRoot || !source || !destination) {
  throw new Error("usage: install-cua-skills.mjs <openclaw-root> <skills-source> <destination>");
}
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const provenance = json(path.join(source, "provenance.json"));
const nativeRoot = path.join(openclawRoot, `node_modules/@trycua/cua-driver-linux-${process.arch}-gnu`);
const installed = {
  native: json(path.join(nativeRoot, "package.json")).version,
  plugin: json(path.join(openclawRoot, "dist/extensions/cua-computer/package.json")).dependencies?.["@trycua/cua-driver"],
  sdk: json(path.join(openclawRoot, "node_modules/@trycua/cua-driver/package.json")).version,
};
if (installed.native !== provenance.driverVersion || installed.plugin !== provenance.driverVersion || installed.sdk !== provenance.driverVersion) {
  throw new Error(
    `CUA skills target driver ${provenance.driverVersion}, but the installed driver is ${installed.native} (SDK ${installed.sdk}, plugin ${installed.plugin})`,
  );
}
if (provenance.driverVersion !== "0.38.0" ||
    provenance.driverSourceCommit !== "85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19" ||
    provenance.skills?.["cua-driver"]?.commit !== provenance.driverSourceCommit) {
  throw new Error("CUA skills must pin the official driver release source");
}

function frontmatter(file) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, "utf8"));
  if (!match) throw new Error(`${file} has no frontmatter`);
  return Object.fromEntries(
    match[1].split("\n").flatMap((line) => {
      const field = /^([a-z]+): (.+)$/.exec(line);
      return field ? [[field[1], field[2]]] : [];
    }),
  );
}

const skills = Object.entries(provenance.skills);
const vendored = readdirSync(source, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
if (vendored.sort().join() !== skills.map(([name]) => name).sort().join()) {
  throw new Error(`vendored skill directories ${vendored.join(", ")} do not match provenance`);
}
for (const [name, skill] of skills) {
  if (!/^[0-9a-f]{40}$/.test(skill.commit)) throw new Error(`${name} is not pinned to an exact commit`);
  const files = readdirSync(path.join(source, name)).sort();
  if (files.join() !== [...skill.files].sort().join()) {
    throw new Error(`${name} vendors ${files.join(", ")} but provenance lists ${skill.files.join(", ")}`);
  }
  const fields = frontmatter(path.join(source, name, "SKILL.md"));
  if (fields.name !== name) throw new Error(`${name}/SKILL.md is named ${fields.name}`);
  if (skill.version !== undefined && (skill.version !== provenance.driverVersion || fields.version !== skill.version)) {
    throw new Error(`${name} version ${fields.version} does not match driver ${provenance.driverVersion}`);
  }
}

for (const [name, skill] of skills) {
  mkdirSync(path.join(destination, name), { recursive: true });
  for (const file of skill.files) copyFileSync(path.join(source, name, file), path.join(destination, name, file));
}
writeFileSync(path.join(destination, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
