import { mkdtemp, readFile, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const script = resolve(import.meta.dirname, "../../../desktop/image/rootfs/usr/local/bin/octo-home-migrate");
const machineId = "11111111222233334444555555555555";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function run(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), "octogee-home-migrate-"));
  directories.push(root);
  await writeFile(join(root, "image"), "octogee-computer-fixture");
  await writeFile(join(root, "machine-id"), machineId);
  await writeFile(join(root, "btrfs"), `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$TEST_ROOT/btrfs-calls"
case "$*" in
  'subvolume list -o '*) [[ "$TEST_SCENARIO" != nested ]] || echo 'ID 256 gen 3 top level 5 path user-subvolume' ;;
  'subvolume snapshot -r '*) [[ "$TEST_SCENARIO" != snapshot-failed ]] || exit 4; mkdir -p "$5/.home-checkpoint"; cp "$TEST_ROOT/.home-checkpoint/recovery-"* "$5/.home-checkpoint/" ;;
  'subvolume delete '*) rm -rf "$3" ;;
  'property get -ts '*) if [[ "$TEST_SCENARIO" != writable-point ]]; then echo ro=true; else echo ro=false; fi ;;
esac
`, { mode: 0o755 });
  await writeFile(join(root, "sync"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (["older-point", "unverified-older", "failed-with-older"].includes(scenario)) {
    const marker = join(root, ".home-checkpoint/pre-migration/older-point/.home-checkpoint");
    await mkdir(marker, { recursive: true });
    if (scenario !== "unverified-older") {
      await writeFile(join(marker, "recovery-point"), "older-point");
      await writeFile(join(root, ".home-checkpoint/migration-complete"), "older-point");
    }
  }
  if (scenario === "full") {
    await mkdir(join(root, ".home-checkpoint/pre-migration/old-one"), { recursive: true });
    await mkdir(join(root, ".home-checkpoint/pre-migration/old-two"));
  }
  const stub = join(root, "setpriv");
  await writeFile(stub, `#!/bin/bash
set -eu
printf '%s\n' "$*" >> "$TEST_ROOT/calls"
if [[ "$*" == *--pending* ]]; then
  if [[ "$TEST_SCENARIO" == complete || -e "$TEST_ROOT/migrated" ]]; then exit 1; fi
  if [[ "$TEST_SCENARIO" == broken-check ]]; then echo failed >&2; exit 2; fi
  if [[ "$TEST_SCENARIO" == ambiguous ]]; then exit 0; fi
  echo 123-native-home.sh
  exit 0
fi
if [[ "$TEST_SCENARIO" == user-session && ( "$*" != *"XDG_RUNTIME_DIR=/run/user/1000"* || "$*" != *"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus"* ) ]]; then echo "native migration cannot contact the user service manager" >&2; exit 23; fi
if [[ "$TEST_SCENARIO" == failed || "$TEST_SCENARIO" == failed-with-older ]]; then exit 3; fi
if [[ "$TEST_SCENARIO" != still-pending ]]; then touch "$TEST_ROOT/migrated"; fi
`);
  await chmod(stub, 0o755);
  const invoke = async () => {
    try { return { ...(await exec("bash", [script], { env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_ROOT: root, TEST_SCENARIO: scenario, OCTO_VM_STATE_ROOT: root, OCTO_COMPUTER_IMAGE_FILE: join(root, "image"), OCTO_MACHINE_ID_FILE: join(root, "machine-id") } })), code: 0 }; }
    catch (error) { return error as { stdout: string; stderr: string; code: number }; }
  };
  const result = await invoke();
  return { ...result, root, invoke, btrfs: await readFile(join(root, "btrfs-calls"), "utf8").catch(() => ""), calls: await readFile(join(root, "calls"), "utf8").catch(() => "") };
}

describe("native home migration admission", () => {
  it("admits an already migrated home without running migrations again", async () => {
    const result = await run("complete");
    expect(result.code).toBe(0);
    expect(result.calls.trim().split("\n")).toHaveLength(1);
    expect(result.calls).toContain("HOME=/home/octo");
    expect(result.calls).toContain("--reuid=octo --regid=octo --init-groups");
    expect(result.calls).toContain("USER=octo LOGNAME=octo");
  });
  it("runs pending migrations and confirms native completion before admission", async () => {
    const result = await run("pending");
    expect(result.code).toBe(0);
    expect(result.calls.trim().split("\n")).toHaveLength(3);
  });
  it("runs migrations that contact the native user service manager", async () => {
    const result = await run("user-session");
    expect(result.code).toBe(0);
    expect(await readFile(join(result.root, "migrated"), "utf8")).toBe("");
  });
  it("takes a fresh pre-admission point for a replacement machine using the same image", async () => {
    const result = await run("complete");
    const nextMachine = "aaaaaaaabbbbccccddddeeeeeeeeeeee";
    await writeFile(join(result.root, "machine-id"), nextMachine);
    expect((await result.invoke()).code).toBe(0);
    const calls = await readFile(join(result.root, "btrfs-calls"), "utf8");
    expect(calls).toContain(`subvolume snapshot -r ${result.root} ${result.root}/.home-checkpoint/pre-migration/octogee-computer-fixture-${nextMachine}`);
    expect(calls).not.toContain("subvolume delete");
  });
  it("does not replace or delete the pre-migration point after Omarchy succeeds but gateway/native-store admission fails and reboots", async () => {
    const result = await run("pending");
    expect(result.code).toBe(0);
    const point = join(result.root, `.home-checkpoint/pre-migration/octogee-computer-fixture-${machineId}`, "before-native-migration");
    await writeFile(point, "good");
    await writeFile(join(result.root, "failed-native-store"), "partial migration");
    expect((await result.invoke()).code).toBe(0);
    const calls = await readFile(join(result.root, "btrfs-calls"), "utf8");
    expect(calls.match(/subvolume snapshot -r/g)).toHaveLength(1);
    expect(calls).not.toContain("subvolume delete");
    expect(await readFile(point, "utf8")).toBe("good");
  });
  it("allows repeated wakes but blocks a third replacement point until explicit recovery retention review", async () => {
    const result = await run("complete");
    for (let wake = 0; wake < 3; wake++) expect((await result.invoke()).code).toBe(0);
    await writeFile(join(result.root, "machine-id"), "aaaaaaaabbbbccccddddeeeeeeeeeeee");
    expect((await result.invoke()).code).toBe(0);
    await writeFile(join(result.root, "machine-id"), "99999999888877776666555555555555");
    expect((await result.invoke()).code).not.toBe(0);
    expect(await readFile(join(result.root, "btrfs-calls"), "utf8")).not.toContain("subvolume delete");
  });
  it("keeps an earlier failed-boot point when a later boot completes migrations", async () => {
    const result = await run("still-pending");
    expect(result.code).not.toBe(0);
    await writeFile(join(result.root, "migrated"), "complete");
    await writeFile(join(result.root, "machine-id"), "aaaaaaaabbbbccccddddeeeeeeeeeeee");
    expect((await result.invoke()).code).toBe(0);
    expect(await readFile(join(result.root, "btrfs-calls"), "utf8")).not.toContain("subvolume delete");
  });
  it("keeps an older recovery point because Omarchy success does not prove gateway/native-store admission", async () => {
    const result = await run("older-point");
    expect(result.code).toBe(0);
    expect(result.btrfs).not.toContain("subvolume delete");
    expect(await readFile(join(result.root, `.home-checkpoint/pre-migration/octogee-computer-fixture-${machineId}/.home-checkpoint/recovery-image`), "utf8")).toContain("octogee-computer-fixture");
  });
  it.each(["unverified-older", "failed-with-older"])("retains the older recovery point for %s", async scenario => {
    const result = await run(scenario);
    expect(result.btrfs).not.toContain("subvolume delete");
    expect(result.code).toBe(scenario === "unverified-older" ? 0 : 3);
  });
  it.each(["nested", "snapshot-failed", "writable-point", "full"])("does not migrate without a complete preserved home point: %s", async scenario => {
    const result = await run(scenario);
    expect(result.code).not.toBe(0);
    expect(result.calls).toBe("");
  });
  it.each(["failed", "still-pending", "broken-check", "ambiguous"])("keeps admission closed for %s", async scenario => {
    const result = await run(scenario);
    expect(result.calls).toContain("--pending");
    expect(result.code).not.toBe(0);
  });
});
