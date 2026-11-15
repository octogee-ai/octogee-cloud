import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = resolve(import.meta.dirname, "../../../desktop/image/rootfs/usr/local/bin/octo-grow-root");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const GIB = 1024 ** 3;
const mock = `#!/usr/bin/python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ['GROW_FIXTURE'])
command = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
stdin = sys.stdin.read() if command == 'sfdisk' else ''
with (root / 'calls').open('a') as out: out.write(json.dumps([command, *args, *([stdin] if stdin else [])]) + '\\n')
layout = json.loads((root / 'layout.json').read_text())
if command == 'findmnt': print('/dev/sda2[/@]')
elif command == 'lsblk' and args[-1] == '/dev/sda2': print(f"sda 2 {layout['start']} {layout['size']}")
elif command == 'lsblk': print(layout['disk'])
elif command == 'sfdisk' and layout.get('sfdiskFails'): sys.exit(3)
`;

async function fixture(layout: Record<string, unknown>) {
  const root = await mkdtemp(`${tmpdir()}/octogee-grow-root-`);
  roots.push(root);
  await writeFile(`${root}/layout.json`, JSON.stringify(layout));
  for (const name of ["findmnt", "lsblk", "sfdisk", "partx", "btrfs"]) await writeFile(`${root}/${name}`, mock, { mode: 0o755 });
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, GROW_FIXTURE: root };
  const calls = async () => (await readFile(`${root}/calls`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
  return { env, calls };
}

describe("octo-grow-root", () => {
  it("grows the root partition, tells the kernel, and resizes btrfs when the disk outgrew the partition", async () => {
    const h = await fixture({ start: 2048, size: 40 * GIB - 2048 * 512 - 17 * 1024, disk: 100 * GIB });
    const { stdout } = await run("bash", [script], { env: h.env });
    expect(stdout).toContain("growing /dev/sda2");
    expect((await h.calls()).slice(2)).toEqual([
      ["lsblk", "-bdno", "SIZE", "/dev/sda"],
      ["sfdisk", "--no-reread", "--no-tell-kernel", "--force", "-N", "2", "/dev/sda", ", +\n"],
      ["partx", "--update", "--nr", "2", "/dev/sda"],
      ["btrfs", "filesystem", "resize", "max", "/"],
    ]);
  });

  it("leaves a partition that already fills the disk alone but still resizes the filesystem to it", async () => {
    const h = await fixture({ start: 2048, size: 100 * GIB - 2048 * 512 - 17 * 1024, disk: 100 * GIB });
    const { stdout } = await run("bash", [script], { env: h.env });
    expect(stdout).toContain("already fills /dev/sda");
    expect((await h.calls()).slice(2)).toEqual([["lsblk", "-bdno", "SIZE", "/dev/sda"], ["btrfs", "filesystem", "resize", "max", "/"]]);
  });

  it("stops before touching the kernel or filesystem when the partition table write fails", async () => {
    const h = await fixture({ start: 2048, size: 40 * GIB, disk: 100 * GIB, sfdiskFails: true });
    await expect(run("bash", [script], { env: h.env })).rejects.toMatchObject({ code: 3 });
    expect((await h.calls()).map((call) => call[0])).toEqual(["findmnt", "lsblk", "lsblk", "sfdisk"]);
  });
});
