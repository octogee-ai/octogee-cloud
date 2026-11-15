import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

type LaunchOptions = { keyboard?: boolean; bus?: boolean; busFailures?: number; existing?: object; identityFails?: boolean; doctorFails?: boolean; stopNode?: boolean };

function launch({ keyboard = true, bus = true, busFailures = 0, existing, identityFails = false, doctorFails = false, stopNode = false }: LaunchOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "desktop-node-"));
  roots.push(root);
  const bin = join(root, "bin");
  const runtime = join(root, "runtime");
  mkdirSync(bin);
  mkdirSync(runtime);
  if (existing) {
    mkdirSync(join(root, ".openclaw"));
    chmodSync(join(root, ".openclaw"), 0o755);
    writeFileSync(join(root, ".openclaw/openclaw.json"), JSON.stringify(existing));
  }
  writeFileSync(join(runtime, "wayland-1"), "");
  for (const name of ["mkdir", "chmod", "ls", "grep", "head", "cat", "rm", "stat"]) {
    const executable = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
    if (executable.status !== 0) throw new Error(`Missing test dependency: ${name}`);
    symlinkSync(executable.stdout.trim(), join(bin, name));
  }
  symlinkSync(process.execPath, join(bin, "node"));
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub("curl", "exit 0");
  stub("sleep", "exit 0");
  const publicKey = Buffer.alloc(32, 1).toString('base64url');
  const identity = { deviceId: createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex'), publicKey };
  const identityPath = join(root, 'public-identity.json');
  const capturedPath = join(root, 'captured-identity.json');
  const stoppedPath = join(root, 'stopped');
  writeFileSync(identityPath, JSON.stringify({ deviceId: 'stale' }));
  stub("openclaw", `if [ "$(stat ${process.platform === "darwin" ? "-f %Lp" : "-c %a"} "$HOME/.openclaw")" != 700 ]; then echo "OpenClaw client root is not private before invocation" >&2; exit 91; fi
if [ "$1" = "doctor" ] && ${doctorFails}; then
  echo "desktop driver unavailable" >&2
  exit 23
fi
if [ "$*" = "node identity --json" ]; then
  ${identityFails ? 'echo "native identity unavailable" >&2; exit 1' : `printf '%s\\n' '${JSON.stringify(identity)}'; exit 0`}
fi
printf "%s\\n" "$*"; printf "display=%s\\n" "$DISPLAY"; printf "bus=%s\\n" "$DBUS_SESSION_BUS_ADDRESS"
if [ "$1 $2" = "node run" ]; then
  while [ ! -s "$OCTOGEE_DESKTOP_NODE_IDENTITY_PATH" ]; do /bin/sleep 0.01; done
  cat "$OCTOGEE_DESKTOP_NODE_IDENTITY_PATH" > "${capturedPath}"
  if ${stopNode}; then
    trap 'echo stopped > "${stoppedPath}"; exit 0' TERM
    kill -TERM "$PPID"
    while :; do /bin/sleep 0.01; done
  fi
fi`);
  if (keyboard) stub("wtype", "exit 0");
  if (bus) {
    writeFileSync(join(root, "bus-failures"), String(busFailures));
    stub("dbus-send", `printf '%s\\n' "$DBUS_SESSION_BUS_ADDRESS $*" >> "${root}/bus-calls"
remaining="$(cat "${root}/bus-failures")"
if [ "$remaining" -gt 0 ]; then echo $((remaining - 1)) > "${root}/bus-failures"; exit 1; fi`);
  }
  const result = spawnSync("/bin/bash", ["-c", 'umask 022; exec /bin/bash "$1"', "desktop-node-test", resolve(__dirname, "../../gateway/desktop-node.sh")], {
    encoding: "utf8", timeout: 15_000,
    env: { PATH: bin, HOME: root, XDG_RUNTIME_DIR: runtime, OCTOGEE_DESKTOP_NODE_NAME: "test-desktop", OCTOGEE_DESKTOP_NODE_IDENTITY_PATH: identityPath, OPENCLAW_GATEWAY_PASSWORD: "fixture" },
  });
  const configPath = join(root, ".openclaw/openclaw.json");
  const busCallsPath = join(root, "bus-calls");
  return {
    ...result,
    config: existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : null,
    stateMode: existsSync(configPath) ? statSync(join(root, ".openclaw")).mode & 0o7777 : null,
    busCalls: existsSync(busCallsPath) ? readFileSync(busCallsPath, "utf8").trim().split("\n") : [],
    runtime,
    identity,
    capturedIdentity: existsSync(capturedPath) ? JSON.parse(readFileSync(capturedPath, "utf8")) : null,
    identityRemains: existsSync(identityPath),
    nodeStopped: existsSync(stoppedPath),
  };
}

it("refuses to advertise computer control without its Wayland keyboard helper", () => {
  const result = launch({ keyboard: false });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("wtype is required for CUA Wayland keyboard input");
  expect(result.stdout).not.toContain("node run");
});

it("refuses to advertise computer control without a client for the desktop's accessibility bus", () => {
  const result = launch({ bus: false });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("dbus-send is required to reach the desktop's accessibility bus");
  expect(result.stdout).not.toContain("node run");
});

it.each([undefined, { plugins: { entries: { "cua-computer": { enabled: true } } }, nodeHost: { browserProxy: { enabled: true } } }])(
  "configures desktop streaming and removes browser advertising on every boot: %j", (existing) => {
    const result = launch({ existing });
    expect(result.status).toBe(0);
    expect(result.stateMode).toBe(0o700);
    expect(result.config.nodeHost.browserProxy.enabled).toBe(false);
    expect(result.config.desktop.host).toEqual({
      enabled: true, managed: false, port: 5901,
      passwordFile: `${result.runtime}/octogee-openclaw-vnc/password`,
    });
    expect(result.config.plugins.entries["cua-computer"].enabled).toBe(true);
  },
);

it("checks the driver and connects on the desktop's session bus once its accessibility bus answers", () => {
  const result = launch();
  expect(result.status).toBe(0);
  expect(result.busCalls).toEqual([
    `unix:path=${result.runtime}/bus --session --print-reply --reply-timeout=5000 --dest=org.a11y.Bus /org/a11y/bus org.a11y.Bus.GetAddress`,
  ]);
  expect(result.stdout).toContain("doctor --lint --only cua-computer/driver-artifacts");
  expect(result.stdout).toContain("node run --host 127.0.0.1 --port 18789 --display-name test-desktop");
  expect(result.stdout).toContain("display=:0");
  expect(result.stdout).toContain(`bus=unix:path=${result.runtime}/bus`);
});

it("keeps the CUA driver stopped until the accessibility bus answers", () => {
  const result = launch({ busFailures: 2 });
  expect(result.status).toBe(0);
  expect(result.busCalls).toHaveLength(3);
  const waits = result.stdout.split("\n").filter((line) => line.includes("waiting for the accessibility bus (org.a11y.Bus)"));
  expect(waits).toHaveLength(2);
  expect(result.stdout.lastIndexOf(waits[1])).toBeLessThan(result.stdout.indexOf("doctor --lint"));
});

it("publishes the native public identity before serving and clears it when the node exits", () => {
  const result = launch();
  expect(result.status).toBe(0);
  expect(result.capturedIdentity).toEqual(result.identity);
  expect(result.identityRemains).toBe(false);
});

it("fails startup explicitly when the native node cannot publish its identity", () => {
  const result = launch({ identityFails: true });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("desktop-node: native public identity was not available after startup");
  expect(result.identityRemains).toBe(false);
});

it("removes the previous identity before dependency checks can fail", () => {
  const result = launch({ doctorFails: true });
  expect(result.status).toBe(23);
  expect(result.stderr).toContain("desktop driver unavailable");
  expect(result.stdout).not.toContain("node run");
  expect(result.identityRemains).toBe(false);
});

it("terminates and waits for its native child when the container stops", () => {
  const result = launch({ stopNode: true });
  expect(result.status).toBe(143);
  expect(result.nodeStopped).toBe(true);
  expect(result.identityRemains).toBe(false);
});
