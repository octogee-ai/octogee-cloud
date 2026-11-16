import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [chartDirectory, mode] = process.argv.slice(2);
if (!chartDirectory || (mode !== undefined && mode !== "--verify")) {
  throw new Error("Usage: monitoring-collection-filter.mjs CHART_DIRECTORY [--verify]");
}

const basePath = join(chartDirectory, "gmp-collection-filter.json");
const additions = join(chartDirectory, "gmp-collection-filters");
const filter = JSON.parse(readFileSync(basePath, "utf8"));

function selectors(value, file) {
  if (!Array.isArray(value) || value.some(selector => typeof selector !== "string" || !selector.trim())) {
    throw new Error(`Expected an array of monitoring selectors in ${file}`);
  }
  return value;
}

const base = selectors(filter.collection?.filter?.matchOneOf, basePath);
const extra = existsSync(additions)
  ? readdirSync(additions, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => join(additions, entry.name))
    .sort()
    .flatMap(file => selectors(JSON.parse(readFileSync(file, "utf8")), file))
  : [];
const desired = [...new Set([...base, ...extra])];
filter.collection.filter.matchOneOf = desired;

if (mode === "--verify") {
  const actual = JSON.parse(readFileSync(0, "utf8"));
  if (JSON.stringify(actual.collection?.filter?.matchOneOf) !== JSON.stringify(desired)) {
    throw new Error("gmp-public/config collection filter drifted");
  }
} else {
  process.stdout.write(JSON.stringify(filter));
}
