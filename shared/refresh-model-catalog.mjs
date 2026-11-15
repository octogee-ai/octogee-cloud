#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseOpenRouterCatalog } from "./types/openrouter-catalog.ts";

const source = "https://openrouter.ai/api/v1/models?supported_parameters=tools";
const inputFile = process.argv[2];
const payload = inputFile
  ? JSON.parse(await readFile(inputFile, "utf8"))
  : await fetch(source, { signal: AbortSignal.timeout(30_000) }).then((response) => {
    if (!response.ok) throw new Error(`OpenRouter models returned HTTP ${response.status}`);
    return response.json();
  });
const entries = parseOpenRouterCatalog(payload);
const output = new URL("./types/openrouter-model-catalog.generated.ts", import.meta.url);
await writeFile(output, [
  'import type { ModelCatalogEntry } from "./model-catalog.js";',
  "",
  `export const OPENROUTER_CATALOG_SOURCE = ${JSON.stringify(source)};`,
  `export const OPENROUTER_CATALOG_UPDATED_AT = ${JSON.stringify(new Date().toISOString().slice(0, 10))};`,
  "export const OPENROUTER_MODEL_CATALOG: readonly ModelCatalogEntry[] = [",
  ...entries.map((entry) => `  ${JSON.stringify(entry)},`),
  "];",
  "",
].join("\n"));
console.log(`Updated ${entries.length} tool-capable text models in ${output.pathname}`);
