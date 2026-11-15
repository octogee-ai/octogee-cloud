import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";

const desktop = fs.readFileSync(path.resolve(import.meta.dirname, "../../gateway/hobby-desktop.sh"), "utf8");
const lifecycle = desktop.slice(desktop.includes("session_runtime=") ? desktop.indexOf("session_runtime=") : desktop.lastIndexOf("exec dbus-run-session"));

it.each([[72, 0], [2, 1], [1, 1]])("stops the desktop for gateway exit %s with container exit %s", (gatewayStatus, expected) => {
  const session = fs.readFileSync(path.resolve(import.meta.dirname, "../../gateway/hobby-session.sh"), "utf8");
  const loop = session.slice(session.lastIndexOf("while true; do\n  exited=")).replace("[[ ! -v exited ]]", "[[ ${exited+x} != x ]]");
  const script = `gateway_pid=11; children=(11); browser_pid=22; panel_pid=33; reopen_pid=''; reopen_desk=0; restart_browser=0
wait() { exited=11; return ${gatewayStatus}; }
${loop}`;
  expect(spawnSync("/bin/bash", ["-c", script], { encoding: "utf8" }).status).toBe(expected);
});
const owned: Array<{ dir: string; root: ChildProcess; exit: Promise<number | null>; foreign?: ChildProcess; foreignExit?: Promise<unknown> }> = [];
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("owned desktop lifecycle barrier was not reached");
    await delay(10);
  }
}
function killOwnedGroup(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function fixture(options: { startup?: boolean; exitCode?: number; pid?: "zero" | "self" | "bus" | "foreign"; publicationFails?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "desktop-stop-"));
  const childPath = path.join(dir, "session"), proxy = path.join(dir, "dbus-run-session");
  const child = `#!${process.execPath}
const fs=require('fs'),dir=process.env.FIXTURE_DIR;let stopping=false;
const event=value=>fs.appendFileSync(dir+'/events',value+'\\n');
process.on('SIGTERM',()=>{event('term');if(stopping)process.exit(81);stopping=true;
const finish=()=>{if(fs.existsSync(dir+'/release')){event('clean');process.exit(Number(process.env.FIXTURE_EXIT_CODE));}};setInterval(finish,10);finish();});
event('ready');setInterval(()=>{},1000);`;
  fs.writeFileSync(childPath, child, { mode: 0o755 });
  const proxySource = `#!${process.execPath}
const fs=require('fs'),cp=require('child_process'),dir=process.env.FIXTURE_DIR;
process.on('SIGTERM',()=>fs.appendFileSync(dir+'/events','bus-term\\n'));process.on('SIGINT',()=>{});
fs.writeFileSync(dir+'/proxy-ready','ready');
function start(){const args=process.argv.slice(3);let child;
if(process.env.BAD_PID){child=cp.spawn(process.execPath,[process.env.FIXTURE_CHILD],{stdio:'inherit'});
 const bad={zero:0,self:process.ppid,bus:process.pid,foreign:process.env.FOREIGN_PID}[process.env.BAD_PID];
 fs.writeFileSync(args.at(-1)+'.tmp',String(bad)+'\\n');fs.renameSync(args.at(-1)+'.tmp',args.at(-1));
}else child=cp.spawn(args[0],args.slice(1),{stdio:'inherit'});
fs.writeFileSync(dir+'/session-child',String(child.pid));
child.once('exit',(code,signal)=>{fs.appendFileSync(dir+'/events','bus-joined\\n');process.exit(code??(signal==='SIGTERM'?143:1));});}
${options.startup ? "const timer=setInterval(()=>{if(fs.existsSync(dir+'/launch')){clearInterval(timer);start();}},10);" : "start();"}
`;
  fs.writeFileSync(proxy, proxySource, { mode: 0o755 });
  if (options.publicationFails) fs.writeFileSync(path.join(dir, "mv"), "#!/bin/sh\nexit 23\n", { mode: 0o755 });
  let foreign: ChildProcess | undefined;
  if (options.pid === "foreign") foreign = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>require('fs').writeFileSync(process.argv[1],'wrong'));setInterval(()=>{},1000);", path.join(dir, "foreign-term")]);
  const body = lifecycle.replaceAll("/usr/local/bin/octogee-hobby-session", childPath);
  const root = spawn("/bin/bash", ["-c", `set -euo pipefail\n${body}`], { detached: true, stdio: ["ignore", "ignore", "pipe"], env: {
    ...process.env, FIXTURE_DIR: dir, XDG_RUNTIME_DIR: dir, PATH: dir + path.delimiter + process.env.PATH,
    FIXTURE_CHILD: childPath, FIXTURE_EXIT_CODE: String(options.exitCode ?? 0), BAD_PID: options.pid ?? "", FOREIGN_PID: String(foreign?.pid ?? ""),
  } });
  const foreignExit = foreign ? new Promise(resolve => foreign!.once("exit", resolve)) : undefined;
  const exit = new Promise<number | null>(resolve => root.once("exit", resolve));
  owned.push({ dir, root, exit, foreign, foreignExit });
  let stderr = "";root.stderr!.on("data", bytes => { stderr += bytes; });
  const events = () => fs.existsSync(path.join(dir, "events")) ? fs.readFileSync(path.join(dir, "events"), "utf8").trim().split("\n") : [];
  await until(() => options.startup || options.publicationFails ? fs.existsSync(path.join(dir, "proxy-ready")) : events().includes("ready"));
  if (foreign) {
    const other = foreign;
    root.once("exit", () => { other.kill("SIGKILL"); });
  }
  return { dir, root, exit, events, stderr: () => stderr, foreign };
}

afterEach(async () => {
  for (const f of owned.splice(0)) {
    fs.writeFileSync(path.join(f.dir, "release"), "release");killOwnedGroup(f.root.pid!);
    await f.exit;if (f.foreign && f.foreign.exitCode === null && f.foreign.signalCode === null) f.foreign.kill("SIGKILL");
    await f.foreignExit;fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

it.each([0, 23])("keeps the dbus runner alive until owned session cleanup joins, preserving status %s", async code => {
  const f = await fixture({ exitCode: code });f.root.kill("SIGTERM");
  await until(() => f.events().includes("term"));
  expect(f.root.exitCode, f.stderr()).toBeNull();expect(f.events()).not.toContain("clean");
  f.root.kill("SIGINT");f.root.kill("SIGTERM");fs.writeFileSync(path.join(f.dir, "release"), "release");
  expect(await f.exit).toBe(code);expect(f.events().filter(event => event === "term")).toHaveLength(1);
  expect(f.events()).not.toContain("bus-term");expect(f.events().indexOf("clean")).toBeLessThan(f.events().indexOf("bus-joined"));
  expect(fs.readdirSync(f.dir).filter(name => name.startsWith("octogee-hobby-session."))).toEqual([]);
});

it("forwards one stop after an in-flight session launch publishes its owned PID", async () => {
  const f = await fixture({ startup: true });f.root.kill("SIGTERM");f.root.kill("SIGINT");f.root.kill("SIGTERM");
  expect(f.root.exitCode).toBeNull();fs.writeFileSync(path.join(f.dir, "launch"), "launch");fs.writeFileSync(path.join(f.dir, "release"), "release");
  expect([0, 143]).toContain(await f.exit);expect(f.events()).not.toContain("bus-term");
  expect(f.events().filter(event => event === "ready").length).toBeLessThanOrEqual(1);
  expect(f.events().filter(event => event === "term").length).toBeLessThanOrEqual(1);
});

it.each(["zero", "self", "bus", "foreign"] as const)("refuses a %s PID without signaling that process or the bus", async pid => {
  const f = await fixture({ pid });f.root.kill("SIGTERM");
  await until(() => f.stderr().includes("hobby-desktop:"));
  expect(f.root.exitCode).toBeNull();expect(f.events()).not.toContain("term");expect(f.events()).not.toContain("bus-term");
  expect(fs.existsSync(path.join(f.dir, "foreign-term"))).toBe(false);
  fs.writeFileSync(path.join(f.dir, "release"), "release");
  const childPid = Number(fs.readFileSync(path.join(f.dir, "session-child"), "utf8"));
  process.kill(childPid, "SIGTERM");
  expect(await f.exit).toBe(1);
});

it.each(["exited", "signal-failed"] as const)("continues joining session children after %s during termination", async outcome => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "desktop-exit-race-"));
  const session = fs.readFileSync(path.resolve(import.meta.dirname, "../../gateway/hobby-session.sh"), "utf8");
  const cleanup = session.match(/^cleanup\(\) \{[\s\S]*?^\}/m)?.[0];
  if (!cleanup) throw new Error("session cleanup owner is missing");
  const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  const program = "const fs=require('fs'), name=process.argv[2];process.on('SIGTERM',()=>{fs.writeFileSync(name+'-clean','clean');process.exit(0)});fs.writeFileSync(name+'-ready','ready');setInterval(()=>{},1000);";
  for (const name of ["race", "critical"]) fs.writeFileSync(path.join(dir, name + ".cjs"), program);
  const script = `set -euo pipefail
children=();browser_pid="";panel_pid="";reopen_pid=""
${cleanup}
trap cleanup EXIT
${shellQuote(process.execPath)} ${shellQuote(path.join(dir, "race.cjs"))} ${shellQuote(path.join(dir, "race"))} &
race_pid=$!;children+=("$race_pid")
${shellQuote(process.execPath)} ${shellQuote(path.join(dir, "critical.cjs"))} ${shellQuote(path.join(dir, "critical"))} &
children+=("$!")
while [[ ! -f ${shellQuote(path.join(dir, "race-ready"))} || ! -f ${shellQuote(path.join(dir, "critical-ready"))} ]]; do sleep 0.01; done
kill() {
  if [[ "$2" == "$race_pid" ]]; then
    ${outcome === "exited" ? `if [[ "$1" == -0 && "$race_checked" == 0 ]]; then
      race_checked=1
      command kill -TERM "$race_pid"
      command wait "$race_pid"
      return 0
    fi` : `if [[ "$1" == -TERM ]]; then signal_failed_once=1;return 1; fi
    if [[ "$1" == -0 && "$signal_failed_once" == 1 ]]; then command kill -TERM "$race_pid";return 0; fi`}
  fi
  command kill "$@"
}
wait() { touch ${shellQuote(path.join(dir, "wait-entered"))};command wait "$@"; }
signal_failed_once=0;race_checked=0
exit ${outcome === "exited" ? 143 : 0}
`;
  const root = spawn("/bin/bash", ["-c", script], { detached: true, stdio: "ignore" });
  const exit = new Promise<number | null>(resolve => root.once("exit", resolve));owned.push({ dir, root, exit });
  expect(await exit).toBe(outcome === "exited" ? 143 : 1);
  expect(fs.existsSync(path.join(dir, "wait-entered"))).toBe(true);
  expect(fs.existsSync(path.join(dir, "critical-clean"))).toBe(true);
});

it("refuses to start a session when its atomic PID publication fails", async () => {
  const f = await fixture({ publicationFails: true });
  await until(() => f.root.exitCode !== null);
  expect(await f.exit).toBe(23);expect(f.events()).not.toContain("ready");
});
