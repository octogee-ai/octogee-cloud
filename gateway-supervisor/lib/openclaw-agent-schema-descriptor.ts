import { createHash } from "node:crypto";
import fs from "node:fs/promises";
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
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o222) !== 0 || stat.size > 1024) {
    throw new Error("OpenClaw image schema descriptor must be an immutable root-owned regular file");
  }

  try {
    const descriptor = JSON.parse(await fs.readFile(file, "utf8"));
    if (descriptor?.schema !== descriptorSchema || descriptor.releaseHash !== await installedReleaseHash(install) ||
        !Number.isSafeInteger(descriptor.targetVersion) || descriptor.targetVersion < 1) {
      throw new Error("descriptor schema, installed release hash or target version does not match");
    }
    return descriptor.targetVersion;
  } catch (error) {
    throw new Error("Invalid OpenClaw image schema descriptor", { cause: error });
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
