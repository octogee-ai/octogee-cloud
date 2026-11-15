import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { runOpenClawBootPhase } from "../entrypoints/openclaw-boot-sentinel.js";

const repo = path.resolve(import.meta.dirname, "../..");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

it("restarts a failed boot as-is without Doctor, reports the installed build with health, and starts a changed build the same way", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-openclaw-boot-")); roots.push(root);
  const database = path.join(root, "agents/octogee-unmatched-route/agent/openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(database), { recursive: true });
  await fs.writeFile(path.join(root, "openclaw.json"), JSON.stringify({ agents: { entries: {
    "octogee-unmatched-route": { default: true },
  } } }));
  const db = new DatabaseSync(database);
  db.exec("PRAGMA user_version=24; CREATE TABLE history(body TEXT); INSERT INTO history VALUES ('retained default state')"); db.close();
  const fakeCli = path.join(root, "native-contract.mjs");
  await fs.writeFile(fakeCli, `
import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
const root=process.env.QUAL_BOOT_ROOT, database=root+'/agents/octogee-unmatched-route/agent/openclaw-agent.sqlite';
const append=value=>fs.appendFileSync(root+'/order.log',value+'\\n');
if(process.argv[2]==='doctor'){append('doctor');console.error('Doctor must never run from the boot hook');process.exit(1);}
const db=new DatabaseSync(database),version=db.prepare('PRAGMA user_version').get().user_version;db.close();
append('gateway-'+version);
if(!fs.existsSync(root+'/booted-once')){fs.writeFileSync(root+'/booted-once','true');console.error('transient startup failure');process.exit(1);}
fs.writeFileSync(root+'/writer-active','true');fs.writeFileSync(root+'/healthy','true');
process.on('SIGTERM',()=>{fs.rmSync(root+'/writer-active',{force:true});process.exit(0)});
setInterval(()=>{},1000);
`);
  const hook = path.join(root, "boot-hook.mts");
  await fs.writeFile(hook, `
import fs from 'node:fs';
import {runOpenClawBootPhase} from ${JSON.stringify(path.join(repo, "gateway-supervisor/entrypoints/openclaw-boot-sentinel.ts"))};
const root=process.env.QUAL_BOOT_ROOT,file=root+'/sentinel';
await runOpenClawBootPhase(process.argv[2],{log:()=>{},openclawBinary:root+'/openclaw',
client:{claimOpenClawBoot:async()=>{fs.appendFileSync(root+'/order.log','claim\\n');return{action:'start'};},
completeOpenClawDoctor:async()=>{},completeOpenClawBoot:async({openclawBuild})=>{
 fs.writeFileSync(root+'/healthy-build',openclawBuild);fs.appendFileSync(root+'/order.log','healthy\\n');}}});
`);
  const tsx = path.join(root, "tsx");
  await fs.writeFile(tsx, `#!/bin/sh\ncase "$1" in\n*prepare-openclaw-sqlite-journals.ts) exit 0;;\n*openclaw-boot-sentinel.ts) shift; exec ${quote(process.execPath)} --import ${quote(path.join(repo, "gateway-supervisor/node_modules/tsx/dist/loader.mjs"))} ${quote(hook)} "$@";;\n*) exit 2;;\nesac\n`, { mode: 0o700 });
  await fs.writeFile(path.join(root, "openclaw"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fakeCli)} "$@"\n`, { mode: 0o700 });
  await fs.writeFile(path.join(root, "curl"), '#!/bin/sh\ntest -f "$QUAL_BOOT_ROOT/healthy"\n', { mode: 0o700 });
  const installBuild = (commit: string) => fs.writeFile(path.join(root, "dist/build-info.json"), JSON.stringify({ commit }));
  await fs.mkdir(path.join(root, "dist"));
  await installBuild("a".repeat(40));
  const entrypoint = await fs.readFile(path.join(repo, "gateway/entrypoint.sh"), "utf8");
  const start = entrypoint.indexOf('  "$TSX" /octogee/scripts/entrypoints/prepare-openclaw-sqlite-journals.ts');
  const end = entrypoint.indexOf('\nfi', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const shell = `set -e\nTSX=${quote(tsx)}\nlog(){ :; }\nOPENCLAW_PID=''\ntrap 'test -z "$OPENCLAW_PID" || kill "$OPENCLAW_PID" 2>/dev/null || true' EXIT\n${entrypoint.slice(start, end)}\n`;
  const boot = () => spawnSync("sh", ["-s"], { input: shell, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PATH: root+path.delimiter+process.env.PATH, QUAL_BOOT_ROOT: root, OPENCLAW_DIR: root,
      OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"), GATEWAY_ID: "shared-fixture", BUILD_SHA: "qualified-new-image" } });
  const first = boot(); expect(first.status).not.toBe(0);
  const second = boot(); expect(second.status, second.stderr).toBe(0);
  await installBuild("b".repeat(40));
  const upgraded = boot(); expect(upgraded.status, upgraded.stderr).toBe(0);
  expect(await fs.readFile(path.join(root, "healthy-build"), "utf8")).toBe("b".repeat(40));
  const verified = new DatabaseSync(database, { readOnly: true });
  try { expect(verified.prepare("PRAGMA user_version").get()?.user_version).toBe(24);
    expect(verified.prepare("SELECT body FROM history").get()?.body).toBe("retained default state"); }
  finally { verified.close(); }
  expect((await fs.readFile(path.join(root, "order.log"), "utf8")).trim().split("\n"))
    .toEqual(["claim", "gateway-24", "claim", "gateway-24", "healthy", "claim", "gateway-24", "healthy"]);
});


it("uses the installed build identity when in-place recovery retains the old pod image tag", async () => {
  const client = { claimOpenClawBoot: vi.fn().mockResolvedValue({ action: "start" }), completeOpenClawDoctor: vi.fn(async () => undefined),
      completeOpenClawBoot: vi.fn().mockResolvedValue(undefined) };
  const input = { client, installedOpenClawBuild: async () => "c".repeat(40),
    env: { GATEWAY_ID: "shared-fixture", BUILD_SHA: "new-build-sha", GATEWAY_IMAGE_TAG: "old-pod-tag" } };
  await runOpenClawBootPhase("before-start", input);
  await runOpenClawBootPhase("healthy", input);
  expect(client.claimOpenClawBoot).toHaveBeenCalledWith({ releaseKey: "new-build-sha", openclawBuild: "c".repeat(40) });
  expect(client.completeOpenClawBoot).toHaveBeenCalledWith({ releaseKey: "new-build-sha", openclawBuild: "c".repeat(40) });
});

it("fails the pre-start phase on a Doctor claim without a source request rather than repairing the home", async () => {
  const client = { claimOpenClawBoot: vi.fn().mockResolvedValue({ action: "doctor" }), completeOpenClawDoctor: vi.fn(async () => undefined),
      completeOpenClawBoot: vi.fn() };
  await expect(runOpenClawBootPhase("before-start", { client, log: () => {}, installedOpenClawBuild: async () => "c".repeat(40), env: { GATEWAY_ID: "shared-fixture", BUILD_SHA: "build-sha" } })).rejects.toThrow("OpenClaw boot claim requested Doctor without a source request");
  expect(client.completeOpenClawBoot).not.toHaveBeenCalled();
});
