import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { agentStoreRoutineFingerprint, agentStoreRoutinesQuery, agentStoreTriggerFingerprint, agentStoreTriggersQuery, agentStoreExpressionFingerprint, agentStoreExpressionsQuery } from "./dist/agent-store-routines.js";

const require = createRequire(new URL("./package.json", import.meta.url));
const { default: pg } = await import(require.resolve("pg"));
const checkout = process.argv[2];
const dsn = process.env.OCTOGEE_TEST_POSTGRES_DSN;
if (!checkout || !dsn) throw new Error("Usage: OCTOGEE_TEST_POSTGRES_DSN=<disposable database> node core/qualify-agent-store-routines.mjs <OpenClaw checkout>");
const pin = JSON.parse(readFileSync(new URL("../gateway/openclaw-tarball/current.json", import.meta.url), "utf8"));
const head = execFileSync("/usr/bin/git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("/usr/bin/git", ["-C", checkout, "status", "--porcelain"], { encoding: "utf8" }).trim();
if (head !== pin.sourceSha || dirty) throw new Error("OpenClaw must be clean at the exact pinned source SHA");
const schema = `octogee_qualify_${randomUUID().replaceAll("-", "")}`;
const nativeDdl = JSON.parse(execFileSync(process.execPath, ["--import", "./scripts/tsx.mjs", "--input-type=module", "-e", `
  import { postgresSchemaMetadataSql, postgresSchemaSql } from "./src/infra/database-engine/postgres-schema.ts";
  import { agentEngineSchema } from "./src/state/openclaw-agent-db-engine.ts";
  import { memoryVectorSearchSchema, memoryTextSearchSchema, memoryStandingIntentSearchSchema } from "./packages/memory-host-sdk/src/host/memory-search-schema.ts";
  const searchExtensions = {
    memoryText: memoryTextSearchSchema("trigram"),
    memoryStandingIntent: memoryStandingIntentSearchSchema,
    memoryVector: memoryVectorSearchSchema(1536),
  };
  const schemas = [agentEngineSchema, ...(agentEngineSchema.postgresMigrations ?? []).flatMap(step =>
    [step.fromSchema, step.schema].map(definition => ({ id: "agent", version: step.version, sqlite: "",
      search: agentEngineSchema.search, ...definition })))];
  process.stdout.write(JSON.stringify({ metadata: postgresSchemaMetadataSql,
    agents: [...new Set(schemas.map(definition => postgresSchemaSql({ ...definition, searchExtensions }, ${JSON.stringify(schema)})))] }));
`], { cwd: checkout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
const client = new pg.Client({ connectionString: dsn });
await client.connect();
const routines = {}, triggers = {}, expressions = {};
function collect(target, entries) {
  for (const [key, fingerprint] of entries) {
    target[key] ??= [];
    if (!target[key].includes(fingerprint)) target[key].push(fingerprint);
  }
}
try {
  for (const agent of nativeDdl.agents) {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
    await client.query(`SET LOCAL search_path = ${pg.escapeIdentifier(schema)}`);
    await client.query(nativeDdl.metadata);
    await client.query(agent);
    await client.query("SET LOCAL search_path = pg_catalog");
    const { rows } = await client.query(agentStoreRoutinesQuery, [schema]);
    collect(routines, rows.map(row => [row.proname, agentStoreRoutineFingerprint(row, schema)]));
    const captured = await client.query(agentStoreTriggersQuery, [schema]);
    collect(triggers, captured.rows.map(row => [row.tgname, agentStoreTriggerFingerprint(row, schema)]));
    const executable = await client.query(agentStoreExpressionsQuery, [schema]);
    collect(expressions, executable.rows.map(row => [`${row.kind}:${row.relname}:${row.name}`, agentStoreExpressionFingerprint(row, schema)]));
    await client.query("ROLLBACK");
  }
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
const output = new URL("./src/agent-store-routines.json", import.meta.url);
const sorted = table => Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(output, `${JSON.stringify({ sourceSha: pin.sourceSha, routines: sorted(routines), triggers: sorted(triggers), expressions: sorted(expressions) }, null, 2)}\n`);
console.log(`Qualified ${Object.keys(routines).length} routine definitions from ${pin.sourceSha} into ${fileURLToPath(output)}`);
