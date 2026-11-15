import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, chown, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomeFs } from "../../scripts/lib/vm-gateway-agent/home-fs.ts";

for (const archiveHasSsh of [false, true]) {
  test(`root restore creates writable private SSH directory; archived SSH=${archiveHasSsh}`, { skip: process.getuid?.() !== 0 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "octogee-ssh-owner-"));
    try {
      await chmod(root, 0o755);
      const source = `${root}/source`, target = `${root}/target`;
      await mkdir(source);
      await mkdir(target);
      await chown(source, 1000, 1000);
      await chown(target, 1000, 1000);
      if (archiveHasSsh) {
        await mkdir(`${source}/.ssh`, { mode: 0o700 });
        await chown(`${source}/.ssh`, 1000, 1000);
        await writeFile(`${source}/.ssh/config`, "user config\n");
        await writeFile(`${source}/.ssh/authorized_keys`, "revoked archived key\n");
      }
      await createHomeFs(root).replaceDirectoryContents(source, target, [".ssh/authorized_keys", ".ssh/authorized_keys.metadata"]);
      const owner = await stat(`${target}/.ssh`);
      assert.deepEqual([owner.uid, owner.gid, owner.mode & 0o777], [1000, 1000, 0o700]);
      await assert.rejects(readFile(`${target}/.ssh/authorized_keys`), { code: "ENOENT" });
      execFileSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], 'new user key')", `${target}/.ssh/new-key`], { uid: 1000, gid: 1000 });
      assert.equal(await readFile(`${target}/.ssh/new-key`, "utf8"), "new user key");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("root restore preserves existing SSH directory inode, owner, mode and current keys", { skip: process.getuid?.() !== 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "octogee-ssh-owner-"));
  try {
    await mkdir(`${root}/source`);
    await mkdir(`${root}/target/.ssh`, { recursive: true, mode: 0o750 });
    await chown(`${root}/target/.ssh`, 1000, 1000);
    await writeFile(`${root}/target/.ssh/authorized_keys`, "current key\n");
    const before = await stat(`${root}/target/.ssh`);
    await createHomeFs(root).replaceDirectoryContents(`${root}/source`, `${root}/target`, [".ssh/authorized_keys", ".ssh/authorized_keys.metadata"]);
    const after = await stat(`${root}/target/.ssh`);
    assert.deepEqual([after.ino, after.uid, after.gid, after.mode], [before.ino, before.uid, before.gid, before.mode]);
    assert.equal(await readFile(`${root}/target/.ssh/authorized_keys`, "utf8"), "current key\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
