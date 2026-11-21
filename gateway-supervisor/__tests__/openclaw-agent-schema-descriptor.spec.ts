import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it, vi } from "vitest";
import { readImageAgentSchemaVersion } from "../lib/openclaw-agent-schema-descriptor.js";

it("validates a root-owned read-only version against the installed OpenClaw build", async () => {
  const install = await fs.mkdtemp(path.join(os.tmpdir(), "image-schema-test-"));
  const descriptor = path.join(install, "octogee-agent-schema.json");
  const buildInfo = path.join(install, "dist", "build-info.json");
  const release = '{"commit":"same-release"}';
  const open = fs.open;
  let descriptorOwner = 0;
  const trustedStat = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === descriptor) {
      const stat = handle.stat.bind(handle);
      handle.stat = (async (...opts: Parameters<typeof handle.stat>) => {
        const result = await stat(...opts);
        result.uid = descriptorOwner;
        return result;
      }) as typeof handle.stat;
    }
    return handle;
  });

  try {
    await expect(readImageAgentSchemaVersion(install)).resolves.toBeUndefined();
    await fs.mkdir(path.dirname(buildInfo));
    await fs.writeFile(buildInfo, release);
    await fs.writeFile(descriptor, JSON.stringify({
      schema: "octogee.openclaw-agent-schema.v1",
      releaseHash: createHash("sha256").update(release).digest("hex"),
      targetVersion: 38,
    }), { mode: 0o444 });

    await expect(readImageAgentSchemaVersion(install)).resolves.toBe(38);
    descriptorOwner = 1000;
    await expect(readImageAgentSchemaVersion(install)).rejects.toThrow(/immutable root-owned regular file/);
    descriptorOwner = 0;
    await fs.writeFile(buildInfo, '{"commit":"different-release"}');
    await expect(readImageAgentSchemaVersion(install)).rejects.toThrow(/Invalid OpenClaw image schema descriptor/);
    await fs.chmod(descriptor, 0o644);
    await expect(readImageAgentSchemaVersion(install)).rejects.toThrow(/immutable root-owned regular file/);
    await fs.rm(descriptor);
    await fs.symlink(buildInfo, descriptor);
    await expect(readImageAgentSchemaVersion(install)).rejects.toThrow(/must not be a symlink/);
  } finally {
    trustedStat.mockRestore();
    await fs.rm(install, { recursive: true, force: true });
  }
});
