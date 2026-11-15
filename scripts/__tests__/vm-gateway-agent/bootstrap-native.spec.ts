import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const mock = `#!/usr/bin/python3
import json, os, pathlib, sys, time
root=pathlib.Path(os.environ['BOOTSTRAP_FIXTURE'])
command=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
if command == 'curl':
    key=args[-1].split('/')[-1]
    print({'id':'4242','token':'{"access_token":"fixture-token"}'}.get(key, (root/key).read_text() if (root/key).exists() else ''))
elif command == 'df':
    print('Filesystem 1024-blocks Used Available Capacity Mounted')
    print('fixture 0 0 33554432 0% /')
elif command == 'ufw':
    with (root/'events').open('a') as out: out.write(json.dumps(['ufw', *args])+'\\n')
elif command == 'docker':
    with (root/'events').open('a') as out: out.write(json.dumps(args)+'\\n')
    if args[:2] == ['image', 'inspect']: sys.exit(0 if (root/'cached').exists() and (root/'cached').read_text() == args[-1] else 1)
    if args[0] == 'pull':
        (root/'cached').write_text(args[-1])
        (root/'pull-token').write_text(os.environ.get('OCTOGEE_REGISTRY_TOKEN', ''))
    if args[:2] == ['image', 'prune']: print('Total reclaimed space: 38.2GB')
    if args[0] == 'run':
        while not (root/'stopped').exists(): time.sleep(0.02)
    if args[0] == 'stop': (root/'stopped').touch()
`;

describe("native VM bootstrap supervision", () => {
  it.each(["gateway-image", "gateway-id", "octogee-api-url"])("stops the old registration agent when %s changes without stopping runtime containers", async (attribute) => {
    const root = await mkdtemp(`${tmpdir()}/octogee-bootstrap-`);
    roots.push(root);
    await mkdir(`${root}/bin`);
    for (const name of ["curl", "df", "docker", "iptables", "ufw"]) await writeFile(`${root}/bin/${name}`, mock, { mode: 0o755 });
    const assignment = { "gateway-id": "b-fixture", "gateway-image": "registry.invalid/gateway@sha256:old", "octogee-api-url": "https://api.invalid" };
    for (const [key, value] of Object.entries(assignment)) await writeFile(`${root}/${key}`, value);
    const binaries = resolve(import.meta.dirname, "../../../desktop/image/rootfs/usr/local/bin");
    const script = `${root}/bootstrap`;
    await writeFile(`${root}/bin/octo-gateway-firewall`, await readFile(`${binaries}/octo-gateway-firewall`), { mode: 0o755 });
    await writeFile(script, (await readFile(`${binaries}/octo-gateway-agent`, "utf8")).replace("/usr/local/bin/octo-gateway-firewall", `${root}/bin/octo-gateway-firewall`));
    const child = spawn("bash", [script], {
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, BOOTSTRAP_FIXTURE: root, OCTO_VM_STATE_ROOT: `${root}/state`, OCTO_ASSIGNMENT_POLL_SECONDS: "0.05" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const done = new Promise<number | null>((accept, reject) => { child.once("close", accept); child.once("error", reject); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 8_000);
    try {
      await expect.poll(async () => readFile(`${root}/events`, "utf8").catch(() => ""), { timeout: 5_000 }).toContain('"run"');
      await writeFile(`${root}/${attribute}`, `${assignment[attribute as keyof typeof assignment]}-updated`);
      expect(await done, output).toBe(0);
      expect(output).toContain("bootstrap metadata changed; restarting the agent");
      const events = (await readFile(`${root}/events`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(events.slice(0, 3)).toEqual([3001, 3003, 30873].map((port) => ["ufw", "allow", "proto", "tcp", "from", "10.117.0.0/17", "to", "any", "port", String(port)]));
      expect(events.filter((args) => args[0] === "stop")).toEqual([["stop", "--time", "20", "octo-gateway-agent"]]);
      expect(events.filter((args) => args[0] === "rm")).toEqual([["rm", "-f", "octo-gateway-agent"]]);
      const dockerVerbs = events.filter((args) => args[0] !== "ufw").map((args) => args.slice(0, 2).join(" "));
      expect(dockerVerbs.slice(0, 2)).toEqual(["image inspect", "pull -q"]);
      expect(events.some((args) => args[0] === "login" || args[0] === "logout")).toBe(false);
      expect(await readFile(`${root}/pull-token`, "utf8")).toBe("fixture-token");
      expect(output).not.toContain("fixture-token");
      expect(events.some((args) => args[0] === "image" && args[1] === "prune")).toBe(false);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGTERM");
      await done;
    }
  });
});

it.each(["omarchy", "x11"])("gives the %s agent the home disk's desktop-home, never the boot disk's login home", async (desktop) => {
  const root = await mkdtemp(`${tmpdir()}/octogee-bootstrap-home-`);
  roots.push(root);
  await mkdir(`${root}/bin`);
  for (const name of ["curl", "df", "docker", "iptables", "ufw"]) await writeFile(`${root}/bin/${name}`, mock, { mode: 0o755 });
  const binaries = resolve(import.meta.dirname, "../../../desktop/image/rootfs/usr/local/bin");
  await writeFile(`${root}/bin/octo-gateway-firewall`, await readFile(`${binaries}/octo-gateway-firewall`), { mode: 0o755 });
  const script = `${root}/bootstrap`;
  await writeFile(script, (await readFile(`${binaries}/octo-gateway-agent`, "utf8")).replace("/usr/local/bin/octo-gateway-firewall", `${root}/bin/octo-gateway-firewall`));
  const assignment = { "gateway-id": "b-fixture", "gateway-image": "registry.invalid/gateway@sha256:old", "octogee-api-url": "https://api.invalid", "octogee-computer-desktop": desktop };
  for (const [key, value] of Object.entries(assignment)) await writeFile(`${root}/${key}`, value);
  const child = spawn("bash", [script], {
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, BOOTSTRAP_FIXTURE: root, OCTO_VM_STATE_ROOT: `${root}/state`, OCTO_ASSIGNMENT_POLL_SECONDS: "0.05" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const done = new Promise<number | null>((accept, reject) => { child.once("close", accept); child.once("error", reject); });
  const events = async () => (await readFile(`${root}/events`, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  try {
    await expect.poll(async () => (await events()).some((args) => args[0] === "run"), { timeout: 5_000 }).toBe(true);
    const run = (await events()).find((args) => args[0] === "run")!;
    const volumes = run.flatMap((arg, index) => run[index - 1] === "-v" ? [arg] : []);
    expect(volumes).toContain(`${root}/state:${root}/state`);
    expect(volumes.filter((volume) => volume.split(":")[1]?.startsWith(`${root}/state/`))).toEqual([]);
    expect(volumes.some((volume) => volume.startsWith("/home/octo"))).toBe(false);
  } finally {
    child.kill("SIGTERM");
    await done;
  }
});

it("prefetches before assignment, refreshes a changed image, and reuses it without pruning", async () => {
  const root = await mkdtemp(`${tmpdir()}/octogee-bootstrap-prefetch-`);
  roots.push(root);
  await mkdir(`${root}/bin`);
  for (const name of ["curl", "df", "docker", "iptables", "ufw"]) await writeFile(`${root}/bin/${name}`, mock, { mode: 0o755 });
  const binaries = resolve(import.meta.dirname, "../../../desktop/image/rootfs/usr/local/bin");
  await writeFile(`${root}/bin/octo-gateway-firewall`, await readFile(`${binaries}/octo-gateway-firewall`), { mode: 0o755 });
  const script = `${root}/bootstrap`;
  await writeFile(script, (await readFile(`${binaries}/octo-gateway-agent`, "utf8")).replace("/usr/local/bin/octo-gateway-firewall", `${root}/bin/octo-gateway-firewall`));
  await writeFile(`${root}/gateway-image`, "registry.invalid/gateway@sha256:old");
  const child = spawn("bash", [script], {
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, BOOTSTRAP_FIXTURE: root, OCTO_VM_STATE_ROOT: `${root}/state`, OCTO_ASSIGNMENT_POLL_SECONDS: "0.05" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const done = new Promise<number | null>((accept, reject) => { child.once("close", accept); child.once("error", reject); });
  const events = async () => (await readFile(`${root}/events`, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  try {
    await expect.poll(async () => readFile(`${root}/cached`, "utf8").catch(() => ""), { timeout: 5_000 }).toBe("registry.invalid/gateway@sha256:old");
    expect((await events()).some((args) => args[0] === "run")).toBe(false);
    await writeFile(`${root}/gateway-image`, "registry.invalid/gateway@sha256:next");
    await expect.poll(async () => readFile(`${root}/cached`, "utf8"), { timeout: 5_000 }).toBe("registry.invalid/gateway@sha256:next");
    await writeFile(`${root}/gateway-id`, "b-fixture");
    await writeFile(`${root}/octogee-api-url`, "https://api.invalid");
    await expect.poll(async () => (await events()).some((args) => args[0] === "run"), { timeout: 5_000 }).toBe(true);
    expect((await events()).filter((args) => args[0] === "pull")).toHaveLength(2);
    expect((await events()).filter((args) => args[0] === "image" && args[1] === "rm")).toEqual([["image", "rm", "--", "registry.invalid/gateway@sha256:old"]]);
    expect((await events()).some((args) => args[0] === "image" && args[1] === "prune")).toBe(false);
  } finally {
    child.kill("SIGTERM");
    await done;
  }
});
