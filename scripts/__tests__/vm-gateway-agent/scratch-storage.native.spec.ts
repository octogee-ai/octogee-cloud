import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const container = process.env.OCTOGEE_NATIVE_SYSTEMD_CONTAINER;
describe.skipIf(!container)("native disposable scratch filesystem", () => {
  it("bounds writes, preserves factory data and remounts the same cache without touching retained home", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octogee-scratch-limit-"));
    const remote = `/opt/octogee-scratch-limit-${randomUUID()}`;
    const docker = async (...args: string[]) => exec("docker", ["exec", container!, ...args], { timeout: 30_000 });
    try {
      const source = await readFile(resolve(import.meta.dirname, "../../../desktop/image/rootfs/usr/local/bin/octo-scratch-storage"), "utf8");
      await writeFile(join(directory, "storage"), source.replace("BYTES=8589934592", "BYTES=16777216"));
      await exec("docker", ["cp", directory, `${container}:${remote}`]);
      await docker("sh", "-c", `mkdir '${remote}/volumes'; printf factory > '${remote}/volumes/seed'; printf home > '${remote}/retained-home'`);
      const invoke = ["env", `OCTO_SCRATCH_ROOT=${remote}/volumes`, `OCTO_SCRATCH_IMAGE=${remote}/cache.ext4`, "bash", `${remote}/storage`];
      await expect(docker(...invoke)).rejects.toThrow();
      await docker(...invoke, "--initialize-factory");
      expect((await docker("cat", `${remote}/volumes/seed`)).stdout).toBe("factory");
      await expect(docker("dd", "if=/dev/zero", `of=${remote}/volumes/full`, "bs=1M", "count=32", "conv=fsync")).rejects.toMatchObject({ stderr: expect.stringContaining("No space left on device") });
      expect((await docker("cat", `${remote}/retained-home`)).stdout).toBe("home");
      await docker("umount", `${remote}/volumes`);
      await docker(...invoke);
      expect((await docker("cat", `${remote}/volumes/seed`)).stdout).toBe("factory");
      expect((await docker("stat", "-c", "%s", `${remote}/cache.ext4`)).stdout.trim()).toBe("16777216");
    } finally {
      try { await docker("sh", "-c", `if mountpoint -q '${remote}/volumes'; then umount '${remote}/volumes'; fi; rm -rf '${remote}'`); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, 60_000);
});
