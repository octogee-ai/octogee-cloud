import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installedAgentSchemaVersion } from "./openclaw-source-doctor.js";

const openClawInstall = "/usr/local/lib/node_modules/openclaw";
const descriptorFile = "octogee-agent-schema.json";
const descriptorSchema = "octogee.openclaw-agent-schema.v1";

async function installedReleaseHash(install: string): Promise<string> {
  const buildInfo = await fs.readFile(path.join(install, "dist/build-info.json"));
  return createHash("sha256").update(buildInfo).digest("hex");
}

export async function readImageAgentSchemaVersion(install = openClawInstall): Promise<number | undefined> {
  const file = path.join(install, descriptorFile);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      if (error.code === "ELOOP") throw new Error("OpenClaw image schema descriptor must not be a symlink", { cause: error });
      throw error;
    });
  if (!handle) return undefined;

  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o222) !== 0 || stat.size > 1024) {
      throw new Error("OpenClaw image schema descriptor must be an immutable root-owned regular file");
    }
    const descriptor = JSON.parse(await handle.readFile("utf8"));
    if (descriptor?.schema !== descriptorSchema || descriptor.releaseHash !== await installedReleaseHash(install) ||
        !Number.isSafeInteger(descriptor.targetVersion) || descriptor.targetVersion < 1) {
      throw new Error("descriptor schema, installed release hash or target version does not match");
    }
    return descriptor.targetVersion;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "failed to read descriptor";
    throw new Error(`Invalid OpenClaw image schema descriptor: ${detail}`, { cause: error });
  } finally {
    await handle.close();
  }
}

export async function writeImageAgentSchemaDescriptor(): Promise<void> {
  const probeRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "image-schema-probe-")));
  try {
    const releaseHash = await installedReleaseHash(openClawInstall);
    const targetVersion = await installedAgentSchemaVersion(probeRoot, "octogee-image-schema-probe", { assertCurrent: async () => {} });
    await fs.writeFile(path.join(openClawInstall, descriptorFile),
      JSON.stringify({ schema: descriptorSchema, releaseHash, targetVersion }) + "\n", { flag: "wx", mode: 0o444 });
    if (await readImageAgentSchemaVersion() !== targetVersion) throw new Error("OpenClaw image schema descriptor verification failed");
  } finally {
    await fs.rm(probeRoot, { recursive: true, force: true });
  }
}
