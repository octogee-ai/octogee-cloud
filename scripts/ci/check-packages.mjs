import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const matrix = JSON.parse(readFileSync(new URL("../../.github/check-packages.json", import.meta.url), "utf8"));
const services = new Set(["gateway-supervisor", "gateway-edge", "llm-broker", "platform-api", "fleet-controller", "provisioning-service"]);
const repositoryChecks = new Set(["scripts", "tests", "release-artifacts"]);
const documentation = /^(?:docs\/.*\.md|(?:README|AGENTS|CONTRIBUTING|SHIP|SECURITY|CODE_OF_CONDUCT)\.md)$/;

export function checkPackages(paths, full = false) {
  if (full || paths.length === 0) return matrix;
  const changed = new Set();
  for (const path of paths) {
    if (documentation.test(path)) continue;
    const component = path.split("/")[0];
    if (!services.has(component) || /(?:^|\/)package(?:-lock)?\.json$/.test(path)) return matrix;
    changed.add(component);
  }
  return {
    include: matrix.include.filter(job => repositoryChecks.has(job.name)
      || job.installs.split(/\s+/).some(component => changed.has(component))),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2];
  if (!input) throw new Error("Usage: check-packages.mjs <NUL-delimited-paths-file>|--full");
  const full = input === "--full";
  const paths = full ? [] : readFileSync(input, "utf8").split("\0").filter(Boolean);
  console.log(JSON.stringify(checkPackages(paths, full)));
}
