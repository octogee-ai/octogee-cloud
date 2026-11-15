import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const container = process.env.OCTOGEE_NATIVE_SYSTEMD_CONTAINER;
const dropIn = resolve(import.meta.dirname, "../../../desktop/image/rootfs/etc/systemd/system/sshd.service.d/10-octogee-home-authorization.conf");

describe.skipIf(!container)("native systemd SSH admission ordering and retry", () => {
  it("holds startup while current-key reconciliation fails and retries without opening a stale-key daemon", async () => {
    const id = `octogee-ssh-${randomUUID()}`;
    const directory = await mkdtemp(join(tmpdir(), `${id}-`));
    const remote = `/opt/${id}`;
    const unit = `${id}.service`;
    const homeUnit = `${id}-home.service`;
    const docker = async (...args: string[]) => exec("docker", ["exec", container!, ...args], { timeout: 10_000 });
    let installed = false;
    try {
      await writeFile(join(directory, "reconcile"), `#!/bin/sh\n[ -f '${remote}/metadata-available' ] || exit 1\nprintf current-key > '${remote}/authority'\n`, { mode: 0o755 });
      await writeFile(join(directory, "admit"), `#!/bin/sh\n[ "$(cat '${remote}/authority')" = current-key ] || exit 2\nprintf admitted > '${remote}/admitted'\nexec sleep 120\n`, { mode: 0o755 });
      const configured = (await readFile(dropIn, "utf8")).replaceAll("octo-home-disk.service", homeUnit)
        .replace("/usr/local/bin/octo-metadata-ssh-keys", `${remote}/reconcile`);
      await writeFile(join(directory, "admission.conf"), configured);
      await writeFile(join(directory, "daemon.service"), `[Unit]\nDescription=Native fixture admission actor\n[Service]\nType=simple\nExecStart=${remote}/admit\nRestart=always\nKillMode=process\n`);
      await writeFile(join(directory, "home.service"), "[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/bin/true\n");
      await exec("docker", ["cp", directory, `${container}:${remote}`]);
      await docker("sh", "-c", `set -eu; cp '${remote}/daemon.service' '/run/systemd/system/${unit}'; cp '${remote}/home.service' '/run/systemd/system/${homeUnit}'; mkdir '/run/systemd/system/${unit}.d'; cp '${remote}/admission.conf' '/run/systemd/system/${unit}.d/admission.conf'; systemctl daemon-reload`);
      installed = true;
      await expect(docker("systemctl", "start", unit)).rejects.toMatchObject({ code: 1 });
      const unavailable = (await docker("systemctl", "show", unit, "-p", "ExecMainPID", "-p", "ActiveState")).stdout;
      expect(unavailable).toContain("ExecMainPID=0");
      expect(unavailable).toContain("ActiveState=activating");
      await expect(docker("test", "-e", `${remote}/admitted`)).rejects.toMatchObject({ code: 1 });
      expect((await docker("systemctl", "is-active", homeUnit)).stdout.trim()).toBe("active");
      await docker("touch", `${remote}/metadata-available`);
      const deadline = Date.now() + 15_000;
      let admitted = false;
      while (Date.now() < deadline) {
        try { await docker("test", "-e", `${remote}/admitted`); admitted = true; break; }
        catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(admitted).toBe(true);
      expect((await docker("cat", `${remote}/authority`)).stdout).toBe("current-key");
      const running = (await docker("systemctl", "show", unit, "-p", "NRestarts", "-p", "ActiveState", "-p", "ExecMainPID")).stdout;
      expect(running).toContain("ActiveState=active");
      expect(running).not.toContain("ExecMainPID=0");
      expect(running).not.toContain("NRestarts=0");
    } finally {
      try {
        if (installed) {
          await docker("systemctl", "stop", unit, homeUnit);
        }
        await docker("sh", "-c", `rm -rf '/run/systemd/system/${unit}' '/run/systemd/system/${unit}.d' '/run/systemd/system/${homeUnit}' '${remote}'; systemctl daemon-reload`);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
});
