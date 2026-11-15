import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = resolve(import.meta.dirname, "../../../desktop/image/rootfs/usr/local/bin/octo-home-disk");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const mock = `#!/usr/bin/python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ['HOME_DISK_FIXTURE'])
command = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with (root / 'calls').open('a') as out: out.write(json.dumps([command, *args]) + '\\n')
layout = json.loads((root / 'layout.json').read_text())
if command == 'blkid':
    if '-s' in args and args[args.index('-s') + 1] == 'UUID':
        print('owned-home-uuid'); sys.exit(0)
    if layout['probe'] == 0: print(layout['fstype'])
    sys.exit(layout['probe'])
if command == 'findmnt':
    if args[-1].endswith('/home/octo'): print(layout.get('desktopMount', 'owned-home-uuid btrfs /desktop-home'))
    else: print(layout.get('stateMount', 'owned-home-uuid btrfs /'))
if command == 'mountpoint':
    sys.exit(0 if args[-1] in layout.get('mounted', []) else 1)
if command == 'curl':
    restore = layout.get('restore', {'status': 404, 'body': 'not found'})
    if isinstance(restore, list):
        asked = sum(1 for line in (root / 'calls').read_text().splitlines() if json.loads(line)[0] == 'curl')
        restore = restore[min(asked, len(restore)) - 1]
    if restore.get('unreachable'): sys.exit(7)
    print(restore['body'] + '\\n' + str(restore['status']), end='')
`;

type RestoreAnswer = { status: number; body: string } | { unreachable: true };
type RestoreMetadata = RestoreAnswer | RestoreAnswer[];
const RESTORE_ATTRIBUTE = "http://169.254.169.254/computeMetadata/v1/instance/attributes/octogee-home-restore";
const exists = (path: string) => access(path).then(() => true, () => false);

async function fixture(layout: { probe: number; fstype?: string; attached?: boolean; mounted?: string[]; stateMount?: string; desktopMount?: string; desktopWanted?: number; restore?: RestoreMetadata }) {
  const root = await mkdtemp(`${tmpdir()}/octogee-home-disk-`);
  roots.push(root);
  const paths = { device: `${root}/dev/scsi-0Google_PersistentDisk_octogee-home`, stateRoot: `${root}/srv/octogee`, userHome: `${root}/home/octo` };
  await mkdir(`${root}/bin`);
  await mkdir(`${root}/dev`);
  await mkdir(paths.userHome, { recursive: true });
  await writeFile(`${paths.userHome}/.bashrc`, "image default\n");
  if (layout.attached !== false) await writeFile(paths.device, "");
  const mounted = (layout.mounted ?? []).map((name) => paths[name as keyof typeof paths]);
  await writeFile(`${root}/layout.json`, JSON.stringify({ ...layout, mounted }));
  for (const name of ["blkid", "mkfs.btrfs", "mountpoint", "mount", "btrfs", "findmnt", "curl"]) await writeFile(`${root}/bin/${name}`, mock, { mode: 0o755 });
  await writeFile(`${root}/desktop-wanted`, `#!/bin/sh\nexit ${layout.desktopWanted ?? 0}\n`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${root}/bin:${process.env.PATH}`,
    HOME_DISK_FIXTURE: root,
    OCTO_HOME_DEVICE: paths.device,
    OCTO_VM_STATE_ROOT: paths.stateRoot,
    OCTO_USER_HOME: paths.userHome,
    OCTO_HOME_DEVICE_WAIT_SECONDS: "1",
    OCTO_DESKTOP_WANTED: `${root}/desktop-wanted`,
    OCTO_HOME_RESTORE_ATTEMPTS: "2",
    OCTO_HOME_RESTORE_RETRY_SECONDS: "0",
  };
  const calls = async () => (await readFile(`${root}/calls`, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return { env, calls, paths, gate: `${paths.stateRoot}/home-restore.gate` };
}

describe("octo-home-disk", () => {
  it("asks the desktop selector the image ships, at the path it is installed to", async () => {
    const source = await readFile(script, "utf8");
    const selector = /OCTO_DESKTOP_WANTED:-(\/usr\/local\/bin\/[a-z-]+)\}/.exec(source)?.[1];
    expect(selector).toBe("/usr/local/bin/octo-desktop-wanted");
    await expect(access(resolve(import.meta.dirname, "../../../desktop/image/rootfs", `.${selector}`), constants.X_OK)).resolves.toBeUndefined();
  });
  it("keeps an X11 VM's login home on the boot disk and leaves the desktop home to its gateway", async () => {
    const h = await fixture({ probe: 0, fstype: "btrfs", desktopWanted: 1 });
    const { stdout } = await run("bash", [script], { env: h.env });
    expect(await readFile(`${h.paths.stateRoot}/desktop-home/.bashrc`, "utf8")).toBe("image default\n");
    expect((await h.calls()).filter(([command, ...args]) => command === "mount" && args.includes("--bind"))).toEqual([]);
    expect(stdout).toContain(`${h.paths.userHome} stays the boot-disk login home`);
  });
  it("refuses an X11 VM whose login home is already bound to the home disk", async () => {
    const h = await fixture({ probe: 0, fstype: "btrfs", desktopWanted: 1, mounted: ["stateRoot", "userHome"] });
    await mkdir(`${h.paths.stateRoot}/desktop-home`, { recursive: true });
    await expect(run("bash", [script], { env: h.env })).rejects.toThrow(/X11 VM's .* is bound to the home disk/);
  });
  it("refuses to bind the home when it cannot tell which desktop the VM runs", async () => {
    const h = await fixture({ probe: 0, fstype: "btrfs", desktopWanted: 255 });
    await expect(run("bash", [script], { env: h.env })).rejects.toThrow(/cannot tell which desktop this computer runs/);
    expect((await h.calls()).filter(([command, ...args]) => command === "mount" && args.includes("--bind"))).toEqual([]);
  });
  it("adds native desktop defaults to a migrated Hobby home without overwriting user files", async () => {
    const h = await fixture({ probe: 0, fstype: "btrfs" });
    await mkdir(`${h.paths.stateRoot}/desktop-home`, { recursive: true });
    await writeFile(`${h.paths.stateRoot}/.octogee-home-layout.json`, JSON.stringify({ version: 1 }));
    await writeFile(`${h.paths.stateRoot}/desktop-home/document.txt`, "keep me");
    await run("bash", [script], { env: h.env });
    expect(await readFile(`${h.paths.stateRoot}/desktop-home/.bashrc`, "utf8")).toBe("image default\n");
    expect(await readFile(`${h.paths.stateRoot}/desktop-home/document.txt`, "utf8")).toBe("keep me");
    await writeFile(`${h.paths.stateRoot}/desktop-home/.bashrc`, "my shell");
    await run("bash", [script], { env: h.env });
    expect(await readFile(`${h.paths.stateRoot}/desktop-home/.bashrc`, "utf8")).toBe("my shell");
  });
  it("formats a blank home disk, mounts it as the agent state root, seeds the desktop home from the image, and binds it over the user's home", async () => {
    const h = await fixture({ probe: 2 });
    const { stdout } = await run("bash", [script], { env: h.env });
    expect(stdout).toContain(`formatting blank ${h.paths.device} as btrfs`);
    expect(await h.calls()).toEqual([
      ["blkid", "-p", "-s", "TYPE", "-o", "value", h.paths.device],
      ["mkfs.btrfs", "-q", "-L", "octogee-home", h.paths.device],
      ["blkid", "-s", "UUID", "-o", "value", h.paths.device],
      ["mountpoint", "-q", h.paths.stateRoot],
      ["mount", "-o", "noatime", h.paths.device, h.paths.stateRoot],
      ["findmnt", "-n", "-o", "UUID,FSTYPE,FSROOT", "--mountpoint", h.paths.stateRoot],
      ["mountpoint", "-q", h.paths.userHome],
      ["btrfs", "filesystem", "resize", "max", h.paths.stateRoot],
      ["curl", "-sS", "--connect-timeout", "2", "--max-time", "5", "-H", "Metadata-Flavor: Google", "-w", "\\n%{http_code}", RESTORE_ATTRIBUTE],
      ["mountpoint", "-q", h.paths.userHome],
      ["mount", "--bind", `${h.paths.stateRoot}/desktop-home`, h.paths.userHome],
      ["findmnt", "-n", "-o", "UUID,FSTYPE,FSROOT", "--mountpoint", h.paths.userHome],
    ]);
    expect(await readFile(`${h.paths.stateRoot}/desktop-home/.bashrc`, "utf8")).toBe("image default\n");
    expect(await exists(h.gate)).toBe(false);
  });

  it("closes the writer gate on a fresh home the controller restores from a checkpoint, before seeding it", async () => {
    const h = await fixture({ probe: 2, restore: { status: 200, body: "checkpoint" } });
    const { stdout } = await run("bash", [script], { env: h.env });
    expect(await exists(h.gate)).toBe(true);
    expect(stdout).toContain(`restores a checkpoint before SSH, the desktop and the user manager start; the restore clears ${h.gate}`);
    expect(await readFile(`${h.paths.stateRoot}/desktop-home/.bashrc`, "utf8")).toBe("image default\n");
  });

  it("gates an X11 VM's fresh checkpoint-backed home too", async () => {
    const h = await fixture({ probe: 2, desktopWanted: 1, restore: { status: 200, body: "checkpoint" } });
    await run("bash", [script], { env: h.env });
    expect(await exists(h.gate)).toBe(true);
  });

  it("leaves a retained home ungated without asking the metadata server, even when a restore was once requested", async () => {
    const h = await fixture({ probe: 0, fstype: "btrfs", restore: { status: 200, body: "checkpoint" } });
    await mkdir(`${h.paths.stateRoot}/desktop-home`, { recursive: true });
    await run("bash", [script], { env: h.env });
    expect(await exists(h.gate)).toBe(false);
    expect((await h.calls()).map(([command]) => command)).not.toContain("curl");
  });

  it("keeps the gate of a restore interrupted by a reboot", async () => {
    const h = await fixture({ probe: 0, fstype: "btrfs" });
    await mkdir(`${h.paths.stateRoot}/desktop-home`, { recursive: true });
    await writeFile(h.gate, "");
    await run("bash", [script], { env: h.env });
    expect(await exists(h.gate)).toBe(true);
  });

  it.each([
    [{ unreachable: true } as const, 2, "after 2 attempts: metadata server unreachable"],
    [{ status: 200, body: "yes" }, 1, "unexpected octogee-home-restore (HTTP 200): yes"],
    [{ status: 500, body: "boom" }, 2, "after 2 attempts: octogee-home-restore answered HTTP 500: boom"],
    [{ status: 429, body: "slow down" }, 2, "after 2 attempts: octogee-home-restore answered HTTP 429: slow down"],
  ])("fails closed and leaves a fresh home unseeded when it cannot tell whether the home restores: %j", async (restore, attempts, message) => {
    const h = await fixture({ probe: 2, restore });
    await expect(run("bash", [script], { env: h.env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(message) });
    expect((await h.calls()).filter(([command]) => command === "curl")).toHaveLength(attempts);
    expect(await exists(`${h.paths.stateRoot}/desktop-home`)).toBe(false);
    expect(await exists(h.gate)).toBe(false);
    expect((await h.calls()).filter(([command, ...args]) => command === "mount" && args.includes("--bind"))).toEqual([]);
  });

  it.each([
    [[{ status: 503, body: "unavailable" }, { status: 200, body: "checkpoint" }], true],
    [[{ unreachable: true }, { status: 200, body: "checkpoint" }], true],
    [[{ status: 429, body: "slow down" }, { status: 404, body: "not found" }], false],
  ] as const)("retries a transient metadata answer within the attempt budget: %j", async (restore, gated) => {
    const h = await fixture({ probe: 2, restore: [...restore] });
    await run("bash", [script], { env: h.env });
    expect(await exists(h.gate)).toBe(gated);
    expect(await readFile(`${h.paths.stateRoot}/desktop-home/.bashrc`, "utf8")).toBe("image default\n");
  });

  it("reattaches an existing home without formatting it or reseeding over the user's files, and grows it to a resized disk", async () => {
    const h = await fixture({ probe: 0, fstype: "btrfs" });
    await mkdir(`${h.paths.stateRoot}/desktop-home`, { recursive: true });
    await writeFile(`${h.paths.stateRoot}/desktop-home/.bashrc`, "user edit\n");
    await run("bash", [script], { env: h.env });
    const calls = await h.calls();
    expect(calls.map((call) => call[0])).not.toContain("mkfs.btrfs");
    expect(calls).toContainEqual(["btrfs", "filesystem", "resize", "max", h.paths.stateRoot]);
    expect(await readFile(`${h.paths.stateRoot}/desktop-home/.bashrc`, "utf8")).toBe("user edit\n");
  });

  it("leaves mounts that are already in place alone on a unit restart", async () => {
    const h = await fixture({ probe: 0, fstype: "btrfs", mounted: ["stateRoot", "userHome"] });
    await mkdir(`${h.paths.stateRoot}/desktop-home`, { recursive: true });
    await run("bash", [script], { env: h.env });
    expect((await h.calls()).filter((call) => call[0] === "mount")).toEqual([]);
  });

  it.each([
    [{ stateMount: "another-disk-uuid btrfs /" }, "stateRoot"],
    [{ stateMount: "owned-home-uuid btrfs /another-subvolume" }, "stateRoot"],
    [{ desktopMount: "another-disk-uuid btrfs /desktop-home" }, "userHome"],
    [{ desktopMount: "owned-home-uuid btrfs /wrong-home" }, "userHome"],
  ])("refuses a pre-existing mount with the wrong disk or directory: %j", async (layout, mount) => {
    const h = await fixture({ probe: 0, fstype: "btrfs", mounted: [mount], ...layout });
    await expect(run("bash", [script], { env: h.env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("does not match the attached home") });
    expect((await h.calls()).filter((call) => call[0] === "mkfs.btrfs")).toEqual([]);
  });

  it.each([
    [{ probe: 0, fstype: "ext4" }, "holds ext4, not btrfs; refusing to mount or format it"],
    [{ probe: 4 }, "blkid could not probe"],
    [{ probe: 2, attached: false }, "is not attached; the Builder home stays unmounted rather than landing on the boot disk"],
  ])("fails loudly without formatting or mounting when the disk is %j", async (layout, message) => {
    const h = await fixture(layout);
    await expect(run("bash", [script], { env: h.env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(message) });
    expect((await h.calls()).map((call) => call[0]).filter((command) => command === "mkfs.btrfs" || command === "mount")).toEqual([]);
  });
});
