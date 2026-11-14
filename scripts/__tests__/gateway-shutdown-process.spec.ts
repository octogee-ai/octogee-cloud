import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const entrypoint = fs.readFileSync(path.join(root, "infra/gateway/entrypoint.sh"), "utf8");
const surge = fs.readFileSync(path.join(root, "scripts/entrypoints/surge-openclaw-supervisor.ts"), "utf8");
const loader = path.join(root, "scripts/node_modules/tsx/dist/loader.mjs");
const runner = path.join(root, "scripts/entrypoints/supervise-runner.ts");
const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const fixtures: Array<{ directory: string; child: ChildProcess; exited: Promise<number | null> }> = [];

function killOwned(pid: number): void {
  try { process.kill(pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("shutdown fixture did not reach its owned barrier");
    await delay(10);
  }
}
function shellFunction(name: string): string {
  const body = entrypoint.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0];
  if (!body) throw new Error(`Missing entrypoint function ${name}`);
  return body;
}
async function fixture(kind: "shared" | "isolated", exitCode = 0) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gateway-shutdown-"));
  const native = path.join(directory, "native.mjs"), supervisor = path.join(directory, "supervisor.ts");
  const nativeProgram = `import fs from 'node:fs';
const dir=process.argv[2];let stopping=false;
const event=name=>fs.appendFileSync(dir+'/events',name+'\\n');
const stop=()=>{event('native-term');if(stopping){process.exit(81);}stopping=true;
  const finish=()=>{if(fs.existsSync(dir+'/release')){event('native-clean');process.exit(${exitCode});}};
  setInterval(finish,10);finish();};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
fs.writeFileSync(dir+'/native-pid',String(process.pid));event('native-start');fs.writeFileSync(dir+'/native-ready','ready');setInterval(()=>{},1000);
`;
  fs.writeFileSync(native, nativeProgram);
  const signalBlock = surge.match(/(?: {2}let stopPromise[^\n]*\n)? {2}const stop = \(\) => \{[\s\S]*? {2}process\.(?:once|on)\("SIGINT", stop\);/)?.[0];
  if (!signalBlock) throw new Error("Missing surge supervisor signal owner");
  fs.writeFileSync(supervisor, `import fs from 'node:fs';import {spawn} from 'node:child_process';
const dir=process.argv[2];const native=spawn(process.execPath,[${JSON.stringify(native)},dir],{stdio:'inherit',detached:true});
const exited=new Promise<number|null>(resolve=>native.once('exit',resolve));
const supervisor={async stop(){native.kill('SIGTERM');const code=await exited;if(code!==0)throw Error('owned Native cleanup failed');}};
const runtimeLogger={error:()=>{}};const errorMessage=(error:Error)=>error.message;
fs.writeFileSync(dir+'/surge-pid',String(process.pid));fs.writeFileSync(dir+'/runner-pid',String(process.ppid));
${signalBlock}
`);
  const startup = kind === "shared"
    ? `${shellQuote(process.execPath)} ${shellQuote(native)} "$FIXTURE_DIR" &\nOPENCLAW_PID=$!`
    : `supervise_runner surge-openclaw-supervisor 0 ${shellQuote(process.execPath)} --import ${shellQuote(loader)} ${shellQuote(supervisor)} "$FIXTURE_DIR"\n${entrypoint.match(/supervise_runner surge-openclaw-supervisor[^\n]*\n( {2}OPENCLAW_PID=\$!\n)?/)?.[1] ?? ""}`;
  const script = `set -e
TEST_STOPPING=0
log() { case "$*" in *received*SIGTERM*) TEST_STOPPING=1;; esac; }
wait() { if [ "$TEST_STOPPING" = 1 ]; then echo waiting > "$FIXTURE_DIR/root-wait"; fi; command wait "$@"; }
${shellFunction("supervise_runner")}
${shellFunction("shutdown")}
trap shutdown TERM INT
trap 'echo root-exit >> "$FIXTURE_DIR/events"' EXIT
${startup}
${kind === "shared" ? 'wait "$OPENCLAW_PID"' : "wait"} || true
`;
  const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, FIXTURE_DIR: directory, OCTOGEE_RUNNER_HEARTBEAT_DIR: path.join(directory, "heartbeats"),
    SUPERVISE: `${process.execPath} --import ${loader} ${runner}`,
  } });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  fixtures.push({ directory, child, exited });
  let stderr = "";child.stderr!.on("data", chunk => { stderr += chunk; });child.stdout!.resume();
  await until(() => fs.existsSync(path.join(directory, "native-ready")) || child.exitCode !== null);
  expect(child.exitCode, stderr).toBeNull();
  return { directory, child, exited, stderr: () => stderr, events: () => fs.readFileSync(path.join(directory, "events"), "utf8").trim().split("\n") };
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    fs.writeFileSync(path.join(f.directory, "release"), "cleanup");
    killOwned(-f.child.pid!);
    const pidFile = path.join(f.directory, "native-pid");
    if (fs.existsSync(pidFile) && !fs.readFileSync(path.join(f.directory, "events"), "utf8").includes("native-clean")) {
      killOwned(Number(fs.readFileSync(pidFile, "utf8")));
    }
    await f.exited;fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

it.each(["shared", "isolated"] as const)("joins %s Native cleanup before exiting PID1", async kind => {
  const f = await fixture(kind);f.child.kill("SIGTERM");
  await until(() => fs.existsSync(path.join(f.directory, "root-wait")) || f.child.exitCode !== null);
  expect(fs.existsSync(path.join(f.directory, "root-wait"))).toBe(true);
  await until(() => f.events().includes("native-term") || f.child.exitCode !== null);
  expect(f.child.exitCode, f.stderr()).toBeNull();expect(f.events()).not.toContain("native-clean");
  if (kind === "builder") {
    process.kill(Number(fs.readFileSync(path.join(f.directory, "surge-pid"), "utf8")), "SIGINT");
    process.kill(Number(fs.readFileSync(path.join(f.directory, "runner-pid"), "utf8")), "SIGTERM");
  }
  f.child.kill("SIGINT");f.child.kill("SIGTERM");
  fs.writeFileSync(path.join(f.directory, "release"), "finish cleanup");
  expect(await f.exited).toBe(0);
  expect(f.events().filter(event => event === "native-term")).toHaveLength(1);
  expect(f.events().filter(event => event === "native-start")).toHaveLength(1);
  expect(f.events().indexOf("native-clean")).toBeLessThan(f.events().indexOf("root-exit"));
});

it.each([["shared", 23], ["builder", 1]] as const)("preserves %s Native-chain cleanup failure", async (kind, expected) => {
  const f = await fixture(kind, 23);f.child.kill("SIGTERM");
  await until(() => fs.existsSync(path.join(f.directory, "root-wait")) || f.child.exitCode !== null);
  expect(f.child.exitCode, f.stderr()).toBeNull();fs.writeFileSync(path.join(f.directory, "release"), "finish failed cleanup");
  expect(await f.exited).toBe(expected);
  expect(f.events().indexOf("native-clean")).toBeLessThan(f.events().indexOf("root-exit"));
});
