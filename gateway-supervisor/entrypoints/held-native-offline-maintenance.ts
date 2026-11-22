import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readHeldNativeOfflineDesiredProjection } from "@octogee/core/held-native-offline-protocol";
import { SAFE_DEFAULT_AGENT_ID } from "../lib/openclaw-config-users.js";
import { prepareHeldBrokerNativeProjectionFromSnapshot } from "../lib/user-lifecycle-broker-adapter.js";
import { createOfflineLinuxWitness } from "../lib/held-native-offline-linux.js";
import { runHeldNativeOfflineStdio, type HeldNativeOfflineStdioOptions } from "../lib/held-native-offline-stdio.js";

const enrollmentRoot = "/etc/octogee-held-native-offline";
const maintenanceRoot = "/var/lib/octogee-held-native-offline";
const cloneRoot = "/mnt/octogee-held-native-original";
const sourceState = "/home/node/.openclaw";
const localMattermostAccounts = "secrets/mattermost-accounts.json";
const stageDirectory = join(maintenanceRoot, "stage");
const controlDirectory = join(maintenanceRoot, "control");
const configPath = join(stageDirectory, "openclaw.json");
const sha256 = /^[a-f0-9]{64}$/;
const agentId = /^[a-z0-9][a-z0-9-]{0,127}$/;
const maxConfigBytes = 8 * 1024 * 1024;

interface Enrollment {
  version: 1;
  maintenanceUid: number;
  earliestClaimStartedAt: number;
  expected: HeldNativeOfflineStdioOptions["expected"];
  cloneDevice: string;
  originalConfig: string;
  originalOwnerAnchor: string;
  anchorWitnesses: { path: string; sha256: string }[];
  agentIds: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function stableFile(path: string, max: number, rootTrusted = false): Promise<Buffer> {
  if (await realpath(path) !== path) throw new Error("Held Native maintenance file is not canonical");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0 || info.size > max || (rootTrusted && (info.uid !== 0 || (info.mode & 0o022) !== 0))) {
      throw new Error("Held Native maintenance file is not eligible");
    }
    const bytes = await file.readFile();
    if (bytes.length !== info.size) throw new Error("Held Native maintenance file size changed");
    return bytes;
  } finally {
    await file.close();
  }
}

function clonePath(path: string): string {
  if (typeof path !== "string" || !path.split("/").every(part =>
    /^[a-zA-Z0-9._-]+$/.test(part) && part !== "." && part !== "..")) {
    throw new Error("Invalid Held Native clone-relative file");
  }
  return join(cloneRoot, path);
}

function hasIndirectOrExecutableInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasIndirectOrExecutableInput);
  const record = asRecord(value);
  return record !== null && (record.source === "exec" || Object.hasOwn(record, "$include") ||
    Object.values(record).some(hasIndirectOrExecutableInput));
}

function assertSupportedConfig(value: unknown) {
  const plugins = asRecord(asRecord(value)?.plugins);
  const pluginPaths = asRecord(plugins?.load)?.paths;
  const installs = plugins?.installs;
  if (hasIndirectOrExecutableInput(value) || (pluginPaths !== undefined && (!Array.isArray(pluginPaths) || pluginPaths.length > 0)) ||
      (installs !== undefined && (!asRecord(installs) || Object.keys(asRecord(installs)!).length > 0))) {
    throw new Error("Held Native offline config requires indirect, executable or externally installed state");
  }
}

function validateEnrollment(value: Enrollment) {
  if (![
    value.version === 1, Number.isSafeInteger(value.maintenanceUid), value.maintenanceUid >= 1000,
    value.maintenanceUid === process.getuid?.(), Number.isSafeInteger(value.earliestClaimStartedAt),
    value.earliestClaimStartedAt > 0, value.expected?.maintenance,
    sha256.test(value.expected?.desiredSnapshotSha256),
  ].every(Boolean)) {
    throw new Error("Held Native maintenance enrollment is invalid");
  }
  if (!value.agentIds?.length || !value.agentIds.every(id => agentId.test(id)) ||
      new Set(value.agentIds).size !== value.agentIds.length || !value.anchorWitnesses?.length ||
      !value.anchorWitnesses.every(anchor => clonePath(anchor.path) && sha256.test(anchor.sha256))) {
    throw new Error("Held Native offline enrollment has no exact roster and anchors");
  }
}

async function loadEnrollment() {
  const [bytes, fleetPublicKey, maintenancePrivateKey] = await Promise.all([
    stableFile(join(enrollmentRoot, "enrollment.json"), maxConfigBytes, true),
    stableFile(join(enrollmentRoot, "fleet-public.pem"), 16384, true).then(key => key.toString("utf8")),
    stableFile(join(enrollmentRoot, "maintenance-private.pem"), 16384, true).then(key => key.toString("utf8")),
  ]);
  const enrollment = JSON.parse(bytes.toString("utf8")) as Enrollment;
  validateEnrollment(enrollment);
  if (createPublicKey(fleetPublicKey).asymmetricKeyType !== "ed25519" ||
      createPrivateKey(maintenancePrivateKey).asymmetricKeyType !== "ed25519") {
    throw new Error("Held Native maintenance keys are not Ed25519");
  }
  return { enrollment, fleetPublicKey, maintenancePrivateKey };
}

async function verifiedDesired(
  request: Parameters<HeldNativeOfflineStdioOptions["prepareProjection"]>[0], enrollment: Enrollment, publicKey: string,
) {
  const { identity } = request;
  const cleanCredential = join(dirname(clonePath(enrollment.originalConfig)), localMattermostAccounts);
  const aliasCredential = join(sourceState, localMattermostAccounts);
  const [desired, clean, alias] = await Promise.all([
    stableFile(join(enrollmentRoot, "desired.json"), 256 * 1024, true),
    stat(cleanCredential), stat(aliasCredential),
  ]);
  if (clean.dev !== alias.dev || clean.ino !== alias.ino) {
    throw new Error("Held Native projection credential reference is not the exact restored file");
  }
  const envelope = JSON.parse(desired.toString("utf8")) as { raw: string; signature: string };
  const secrets = asRecord(JSON.parse((await stableFile(cleanCredential, maxConfigBytes)).toString("utf8")));
  const snapshot = await readHeldNativeOfflineDesiredProjection({
    ...envelope, expectedSha256: identity.desiredSnapshotSha256, fleetPublicKey: publicKey,
    scope: { uid: identity.uid, slug: identity.slug, gatewayId: identity.sourceGatewayId,
      operationId: identity.operationId, requestId: identity.requestId, holdGeneration: identity.holdGeneration },
    async readRestoredCredential(accountId) {
      const secret = secrets?.[accountId];
      return typeof secret === "string" ? secret : null;
    },
  });
  if (!isDeepStrictEqual([...snapshot.agentIds].sort(), enrolledOwnerAgents(enrollment.agentIds))) {
    throw new Error("Held Native broker roster differs from the verified retained owner");
  }
  const compose = prepareHeldBrokerNativeProjectionFromSnapshot(snapshot);
  return (config: unknown) => {
    const projection = compose(config);
    assertSupportedConfig(projection.patch);
    return projection;
  };
}

function enrolledOwnerAgents(agentIds: readonly string[]): string[] {
  return agentIds.filter(id => id !== SAFE_DEFAULT_AGENT_ID).sort();
}

async function main() {
  if (!isDeepStrictEqual(process.argv.slice(2), ["--stdio"])) throw new Error("Held Native maintenance takes its signed input on stdin only");
  const { enrollment, fleetPublicKey, maintenancePrivateKey } = await loadEnrollment();
  const { expected, earliestClaimStartedAt } = enrollment;
  const witness = createOfflineLinuxWitness({
    cloneRoot, cloneDevice: enrollment.cloneDevice, instanceId: expected.maintenance.instanceId, bootId: expected.maintenance.bootId,
  });
  const verifyRoster = enrolledOwnerAgents(enrollment.agentIds);
  const workspace = {
    stateDirectory: stageDirectory, controlDirectory,
    originalConfig: clonePath(enrollment.originalConfig), originalOwnerAnchor: clonePath(enrollment.originalOwnerAnchor),
    stageEnvironment: { PATH: "/usr/local/bin:/usr/bin:/bin", OPENCLAW_NO_RESPAWN: "1", OPENCLAW_OFFLINE: "1", OPENCLAW_DIR: stageDirectory },
    ...witness,
    async readStage() {
      const bytes = await stableFile(configPath, maxConfigBytes);
      return { value: JSON.parse(bytes.toString("utf8")) as unknown, contentSha256: createHash("sha256").update(bytes).digest("hex") };
    },
    async assertOwnerAnchorsAndRoster(config: unknown) {
      assertSupportedConfig(config);
      const entries = asRecord(asRecord(asRecord(config)?.agents)?.entries);
      if (!entries || !isDeepStrictEqual(enrolledOwnerAgents(Object.keys(entries)), verifyRoster)) {
        throw new Error("Held Native staged roster differs from its enrolled owner");
      }
      for (const anchor of enrollment.anchorWitnesses) {
        const bytes = await stableFile(clonePath(anchor.path), maxConfigBytes);
        if (createHash("sha256").update(bytes).digest("hex") !== anchor.sha256) {
          throw new Error("Held Native restored owner anchor differs from enrollment");
        }
      }
    },
  };
  const result = await runHeldNativeOfflineStdio({
    expected, earliestClaimStartedAt, fleetPublicKey, maintenancePrivateKey, workspace,
    prepareProjection: request => verifiedDesired(request, enrollment, fleetPublicKey),
  }, process.stdin);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main().catch(() => {
  process.stderr.write("Held Native offline maintenance refused; no receipt emitted.\n");
  process.exitCode = 1;
});
