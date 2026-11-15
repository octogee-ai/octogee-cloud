import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const container = process.env.OCTOGEE_NATIVE_SYSTEMD_CONTAINER;

describe.skipIf(!container)("native retained-home service admission", () => {
  it.each(["docker.service", "user@1000.service"].flatMap(service => [{ service, post: false }, { service, post: true }]))("blocks $service when its required home stage fails (post=$post)", async ({ service, post }) => {
    const id = `octogee-home-${randomUUID()}`;
    const directory = await mkdtemp(join(tmpdir(), `${id}-`));
    const remote = `/opt/${id}`;
    const unit = `${id}.service`;
    const homeUnit = `${id}-home.service`;
    const docker = async (...args: string[]) => exec("docker", ["exec", container!, ...args], { timeout: 10_000 });
    let installed = false;
    try {
      const dropIn = resolve(import.meta.dirname, `../../../desktop/image/rootfs/etc/systemd/system/${service}.d/10-octogee-home.conf`);
      await writeFile(join(directory, "admission.conf"), (await readFile(dropIn, "utf8")).replaceAll(service === "docker.service" ? "octo-home-migrate.service" : "octo-home-disk.service", homeUnit));
      await writeFile(join(directory, "actor.service"), `[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/bin/sh -c 'printf written > ${remote}/fallback-write'\n`);
      await writeFile(join(directory, "home.service"), `[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=${post ? "/bin/true\nExecStartPost=/bin/false" : "/bin/false"}\n`);
      await exec("docker", ["cp", directory, `${container}:${remote}`]);
      await docker("sh", "-c", `set -eu; cp '${remote}/actor.service' '/run/systemd/system/${unit}'; cp '${remote}/home.service' '/run/systemd/system/${homeUnit}'; systemctl daemon-reload`);
      installed = true;
      await docker("systemctl", "start", unit);
      expect((await docker("cat", `${remote}/fallback-write`)).stdout).toBe("written");
      await docker("systemctl", "stop", unit);
      await docker("sh", "-c", `set -eu; rm '${remote}/fallback-write'; mkdir '/run/systemd/system/${unit}.d'; cp '${remote}/admission.conf' '/run/systemd/system/${unit}.d/admission.conf'; systemctl daemon-reload`);
      await expect(docker("systemctl", "start", unit)).rejects.toMatchObject({ code: 1 });
      expect((await docker("systemctl", "show", unit, "-p", "ExecMainPID", "-p", "ActiveState")).stdout).toContain("ExecMainPID=0");
      await expect(docker("test", "-e", `${remote}/fallback-write`)).rejects.toMatchObject({ code: 1 });
      await docker("sh", "-c", `set -eu; sed -i 's|/bin/false|/bin/true|' '/run/systemd/system/${homeUnit}'; systemctl daemon-reload; systemctl reset-failed '${homeUnit}'; systemctl start '${unit}'`);
      expect((await docker("systemctl", "is-active", homeUnit)).stdout.trim()).toBe("active");
      expect((await docker("cat", `${remote}/fallback-write`)).stdout).toBe("written");
    } finally {
      try {
        if (installed) await docker("systemctl", "stop", unit, homeUnit);
        await docker("sh", "-c", `rm -rf '/run/systemd/system/${unit}' '/run/systemd/system/${unit}.d' '/run/systemd/system/${homeUnit}' '${remote}'; systemctl daemon-reload`);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
  it.each([false, true])("requires a ready user manager at boot and survives its later stop (failedUserStart=%s)", async (failedUserStart) => {
    const id = `octogee-migration-${randomUUID()}`;
    const directory = await mkdtemp(join(tmpdir(), `${id}-`));
    const remote = `/opt/${id}`;
    const names = { home: `${id}-home.service`, user: `${id}-user.service`, migration: `${id}-migration.service`, runtime: `${id}-runtime.service` };
    const docker = async (...args: string[]) => exec("docker", ["exec", container!, ...args], { timeout: 10_000 });
    const units = resolve(import.meta.dirname, "../../../desktop/image/rootfs/etc/systemd/system");
    const map = (text: string) => text.replaceAll("octo-home-disk.service", names.home).replaceAll("user@1000.service", names.user)
      .replaceAll("octo-home-migrate.service", names.migration).replaceAll("docker.service", names.runtime);
    try {
      await writeFile(join(directory, names.home), "[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/bin/true\n");
      await writeFile(join(directory, names.user), map(await readFile(join(units, "user@1000.service.d/10-octogee-home.conf"), "utf8")) +
        `[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=${failedUserStart ? "/bin/false" : `/usr/bin/touch ${remote}/user-ready`}\n`);
      await writeFile(join(directory, names.migration), map(await readFile(join(units, "octo-home-migrate.service"), "utf8"))
        .replace("ExecStart=/usr/local/bin/octo-home-migrate", `ExecStart=/bin/sh -c 'test -f ${remote}/user-ready && test -f ${remote}/migration-ok'`));
      await writeFile(join(directory, names.runtime), map(await readFile(join(units, "docker.service.d/10-octogee-home.conf"), "utf8")) +
        `[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/touch ${remote}/runtime-ready\n`);
      await exec("docker", ["cp", directory, `${container}:${remote}`]);
      await docker("sh", "-c", `cp '${remote}/'*.service /run/systemd/system/; systemctl daemon-reload`);
      await expect(docker("systemctl", "start", names.runtime)).rejects.toMatchObject({ code: 1 });
      if (failedUserStart) {
        await expect(docker("test", "-f", `${remote}/user-ready`)).rejects.toMatchObject({ code: 1 });
        await expect(docker("test", "-f", `${remote}/runtime-ready`)).rejects.toMatchObject({ code: 1 });
        await docker("sh", "-c", `sed -i 's|ExecStart=/bin/false|ExecStart=/usr/bin/touch ${remote}/user-ready|' '/run/systemd/system/${names.user}'; systemctl daemon-reload; systemctl reset-failed '${names.user}'`);
        await expect(docker("systemctl", "start", names.runtime)).rejects.toMatchObject({ code: 1 });
      }
      await docker("test", "-f", `${remote}/user-ready`);
      await expect(docker("test", "-f", `${remote}/runtime-ready`)).rejects.toMatchObject({ code: 1 });
      await docker("touch", `${remote}/migration-ok`);
      await docker("systemctl", "reset-failed", names.migration);
      await docker("systemctl", "start", names.runtime);
      await docker("test", "-f", `${remote}/runtime-ready`);
      await docker("systemctl", "stop", names.user);
      for (const unit of [names.migration, names.runtime]) {
        expect((await docker("systemctl", "is-active", unit)).stdout.trim()).toBe("active");
      }
      await docker("systemctl", "start", names.user);
      expect((await docker("systemctl", "is-active", names.runtime)).stdout.trim()).toBe("active");
    } finally {
      await docker("systemctl", "stop", ...Object.values(names)).catch(() => undefined);
      await docker("sh", "-c", `rm -f /run/systemd/system/${id}-*.service; rm -rf '${remote}'; systemctl daemon-reload`);
      await rm(directory, { recursive: true, force: true });
    }
  });

  describe("checkpoint restore gate", () => {
    const GATE = "/srv/octogee/home-restore.gate";
    const units = resolve(import.meta.dirname, "../../../desktop/image/rootfs/etc/systemd/system");
    const unitSection = (text: string) => text.split("\n[Service]")[0];

    async function bootFixture(gated: boolean) {
      const id = `octogee-gate-${randomUUID()}`;
      const directory = await mkdtemp(join(tmpdir(), `${id}-`));
      const remote = `/opt/${id}`;
      const names = {
        home: `${id}-home.service`, user: `${id}-user.service`, migration: `${id}-migration.service`, runtime: `${id}-runtime.service`,
        agent: `${id}-agent.service`, desktop: `${id}-desktop.service`, ssh: `${id}-ssh.service`,
      };
      const docker = async (...args: string[]) => exec("docker", ["exec", container!, ...args], { timeout: 10_000 });
      const map = (text: string) => text.replaceAll(GATE, `${remote}/home-restore.gate`)
        .replaceAll("octo-home-disk.service", names.home).replaceAll("user@1000.service", names.user).replaceAll("user-runtime-dir@1000.service", names.home)
        .replaceAll("octo-home-migrate.service", names.migration).replaceAll("docker.service", names.runtime)
        .replaceAll("octo-gateway-agent.service", names.agent).replaceAll("octo-desktop.service", names.desktop).replaceAll("octo-desktop-lifecycle.service", names.home);
      const ready = (name: string) => `[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/touch ${remote}/${name}\n`;
      const source = (path: string) => readFile(join(units, path), "utf8");
      await writeFile(join(directory, names.home), ready("home-ready"));
      await writeFile(join(directory, names.user), map(await source("user@1000.service.d/10-octogee-home.conf")) + ready("user-ready"));
      await writeFile(join(directory, names.migration), map(await source("octo-home-migrate.service"))
        .replace("ExecStart=/usr/local/bin/octo-home-migrate", `ExecStart=/bin/sh -c 'test -f ${remote}/restored && touch ${remote}/migrated'`));
      await writeFile(join(directory, names.runtime), map(await source("docker.service.d/10-octogee-home.conf")) + ready("runtime-ready"));
      await writeFile(join(directory, names.agent), `${map(unitSection(await source("octo-gateway-agent.service")))}\n${ready("agent-ready")}`);
      await writeFile(join(directory, names.desktop), `${map(unitSection(await source("octo-desktop.service")))}\n${ready("desktop-ready")}`);
      await writeFile(join(directory, names.ssh), map(await source("sshd.service.d/10-octogee-home-authorization.conf"))
        .replace("ExecStartPre=/usr/local/bin/octo-metadata-ssh-keys", "ExecStartPre=/bin/true") + ready("ssh-ready").replace("[Service]\n", ""));
      if (gated) await writeFile(join(directory, "home-restore.gate"), "");
      await exec("docker", ["cp", directory, `${container}:${remote}`]);
      await docker("sh", "-c", `cp '${remote}/'*.service /run/systemd/system/; systemctl daemon-reload`);
      const boot = () => docker("systemctl", "start", ...Object.values(names));
      const shutdown = () => docker("systemctl", "stop", ...Object.values(names));
      const present = async (name: string) => {
        try {
          await docker("test", "-e", `${remote}/${name}`);
          return true;
        } catch (error) {
          if ((error as { code?: number }).code !== 1) {
            throw error;
          }
          return false;
        }
      };
      const cleanup = async () => {
        await shutdown().catch(() => undefined);
        await docker("sh", "-c", `rm -f /run/systemd/system/${id}-*.service; rm -rf '${remote}'; systemctl daemon-reload`);
        await rm(directory, { recursive: true, force: true });
      };
      return { docker, names, remote, boot, shutdown, present, cleanup };
    }

    it("boots the restore bootstrap with every writer off, keeps them off across a failed restore and a reboot, then migrates the restored home before admission", async () => {
      const f = await bootFixture(true);
      try {
        await f.boot();
        expect(await f.present("runtime-ready")).toBe(true);
        expect(await f.present("agent-ready")).toBe(true);
        for (const writer of ["user-ready", "migrated", "desktop-ready", "ssh-ready"]) expect(await f.present(writer), writer).toBe(false);
        expect((await f.docker("systemctl", "show", "--property=ActiveState", "--value", f.names.desktop, f.names.user, f.names.ssh)).stdout.trim().split(/\s+/)).toEqual(["inactive", "inactive", "inactive"]);

        await f.docker("systemctl", "start", f.names.desktop, f.names.ssh);
        expect(await f.present("desktop-ready")).toBe(false);
        expect(await f.present("ssh-ready")).toBe(false);

        await f.shutdown();
        await f.boot();
        for (const writer of ["user-ready", "migrated", "desktop-ready", "ssh-ready"]) expect(await f.present(writer), writer).toBe(false);

        await f.docker("sh", "-c", `touch '${f.remote}/restored'; rm '${f.remote}/home-restore.gate'`);
        await f.docker("systemctl", "start", f.names.user);
        await f.docker("systemctl", "start", f.names.migration);
        await f.docker("systemctl", "start", f.names.desktop);
        await f.docker("systemctl", "start", f.names.ssh);
        for (const writer of ["user-ready", "migrated", "desktop-ready", "ssh-ready"]) expect(await f.present(writer), writer).toBe(true);
      } finally {
        await f.cleanup();
      }
    });

    it("admits SSH and still restarts the agent when the restored home's migration fails after admission", async () => {
      const f = await bootFixture(true);
      try {
        await f.boot();
        await f.docker("rm", `${f.remote}/home-restore.gate`);
        await f.docker("systemctl", "start", f.names.user);
        await expect(f.docker("systemctl", "start", f.names.migration)).rejects.toMatchObject({ code: 1 });
        await f.docker("systemctl", "start", f.names.ssh);
        expect(await f.present("ssh-ready")).toBe(true);
        expect(await f.present("desktop-ready")).toBe(false);

        await f.docker("rm", `${f.remote}/agent-ready`);
        await f.docker("systemctl", "restart", f.names.agent);
        expect(await f.present("agent-ready")).toBe(true);
      } finally {
        await f.cleanup();
      }
    });

    it("boots a retained home exactly as before: migration, desktop and SSH start with the bootstrap", async () => {
      const f = await bootFixture(false);
      try {
        await f.docker("touch", `${f.remote}/restored`);
        await f.boot();
        for (const ready of ["runtime-ready", "agent-ready", "user-ready", "migrated", "desktop-ready", "ssh-ready"]) expect(await f.present(ready), ready).toBe(true);
      } finally {
        await f.cleanup();
      }
    });
  });
});
