import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const KIND_SMOKE = "Kind smoke (.github/workflows/kind-smoke.yml)";

export function kindSmokeRunTitle(sha) {
  return `Kind smoke at ${sha}`;
}

export function successfulKindSmokeRun(sha, runs) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error(`A release commit is a full 40-character SHA, not ${sha}`);
  const atCommit = runs.filter(run => run.displayTitle === kindSmokeRunTitle(sha));
  const passed = atCommit.find(run => run.conclusion === "success");
  if (passed) return passed.databaseId;
  const latest = atCommit[0];
  const outcome = latest ? `its latest run there, ${latest.databaseId}, ended ${latest.conclusion || latest.status}` : "it has not run there";
  throw new Error(`${KIND_SMOKE} has no successful run for ${sha}: ${outcome}. Tag a main commit whose kind smokes passed, or run Kind smoke with workflow_dispatch for ${sha}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const flags = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, "").split("=")));
  try {
    const runs = JSON.parse(readFileSync(flags.runs, "utf8"));
    process.stdout.write(`${successfulKindSmokeRun(flags.sha, runs)}\n`);
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exit(1);
  }
}
