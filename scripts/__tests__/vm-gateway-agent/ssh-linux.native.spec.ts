import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const source = resolve(import.meta.dirname, "../../../desktop/image/rootfs");
const fixture = resolve(import.meta.dirname, "ssh-linux-fixture.py");
const image = process.env.OCTOGEE_NATIVE_SSH_IMAGE;
const native = process.env.OCTOGEE_NATIVE_DOCKER_TEST === "1" && !!image;

async function removeFixture(name: string): Promise<void> {
  try { await exec("docker", ["rm", "-f", name]); }
  catch (error) { if (!String((error as { stderr?: string }).stderr).includes("No such container")) throw error; }
}

describe.skipIf(!native)("native Linux fresh-boot SSH authorization", () => {
  it("rejects revoked keys across metadata outages and admission retries while preserving private home state", async () => {
    const name = `octogee-ssh-${randomUUID()}`;
    try {
      const result = await exec("docker", ["run", "--rm", "--pull", "never", "--network", "none", "--name", name,
        "--mount", `type=bind,source=${fixture},target=/fixture.py,readonly`,
        "--mount", `type=bind,source=${source}/usr/local/bin/octo-metadata-ssh-keys,target=/source/octo-metadata-ssh-keys,readonly`,
        "--mount", `type=bind,source=${source}/etc/systemd/system/sshd.service.d/10-octogee-home-authorization.conf,target=/source/10-octogee-home-authorization.conf,readonly`,
        "--entrypoint", "python3", image!, "/fixture.py"], { timeout: 45_000 });
      expect(result.stderr).toContain("OK");
    } finally { await removeFixture(name); }
  });
});
