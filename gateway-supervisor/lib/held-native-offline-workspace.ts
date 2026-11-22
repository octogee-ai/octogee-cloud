import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { open, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  signOfflineNativeResult, verifyOfflineNativeRequest,
  type OfflineNativeRecoveryIdentity, type OfflineNativeRequest,
} from "@octogee/core/held-native-offline-protocol";
import { applyHeldNativeStagedConfig } from "./held-native-offline-config.js";
import type { OpenClawCommand } from "./openclaw-cli.js";

type NativeStage = Parameters<typeof applyHeldNativeStagedConfig>[0]["stage"];
type Compose = Parameters<typeof applyHeldNativeStagedConfig>[0]["compose"];

interface MaintainedNativeWorkspace {
  stateDirectory: string;
  controlDirectory: string;
  originalConfig: string;
  originalOwnerAnchor: string;
  stageEnvironment: NodeJS.ProcessEnv;
  assertReadOnlyOriginal(): Promise<void>;
  assertIsolatedRuntime(): Promise<void>;
  readStage(): ReturnType<NativeStage["read"]>;
  assertOwnerAnchorsAndRoster(value: unknown): Promise<void>;
}

interface OfflineWorkspaceOptions {
  expected: OfflineNativeRecoveryIdentity;
  fleetPublicKey: string;
  maintenancePrivateKey: string;
  workspace: MaintainedNativeWorkspace;
  compose: Compose;
  assertCurrent(request: OfflineNativeRequest): Promise<void>;
  runNative?: OpenClawCommand;
  now?: () => number;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function protectedDirectory(path: string) {
  if (await realpath(path) !== path) throw new Error("Held Native offline directory is not canonical");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  const info = await handle.stat();
  if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) {
    await handle.close();
    throw new Error("Held Native offline directory is not private");
  }
  return handle;
}

async function readRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  if (await realpath(path) !== path) throw new Error("Held Native offline input is not a canonical file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("Held Native offline input is not an eligible file");
    return handle.readFile();
  } finally { await handle.close(); }
}

async function writeDurableFile(path: string, bytes: Buffer | string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally { await file.close(); }
}

async function activateStagedConfig(state: string, nonce: string, contents: Buffer): Promise<void> {
  const pending = join(state, `offline-config-${nonce}.pending`);
  await writeDurableFile(pending, contents);
  try { await rename(pending, join(state, "openclaw.json")); }
  catch (error) { await unlink(pending); throw error; }
}

async function takeFileLock(handle: Awaited<ReturnType<typeof open>>) {
  const child = spawn("/usr/bin/flock", ["--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", handle.fd] });
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error("Held Native offline source already has an active maintenance command");
}

function stageBootEnvironment(workspace: MaintainedNativeWorkspace): NodeJS.ProcessEnv {
  const dir = workspace.stateDirectory;
  return { ...workspace.stageEnvironment, HOME: dir, OPENCLAW_HOME: dir, OPENCLAW_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: join(dir, "openclaw.json") };
}

export function createHeldNativeOfflineWorkspaceActor(options: OfflineWorkspaceOptions) {
  const { expected, workspace } = options;
  const now = options.now ?? Date.now;
  return async (signed: { raw: string; signature: string }) => {
    const request = verifyOfflineNativeRequest({ ...signed, expected, fleetPublicKey: options.fleetPublicKey, now: now() });
    const assertHeld = async () => {
      if (now() > request.expiresAt) throw new Error("Held Native offline maintenance expired");
      await options.assertCurrent(request);
      await workspace.assertIsolatedRuntime();
      await workspace.assertReadOnlyOriginal();
    };
    await assertHeld();
    const stage = await protectedDirectory(workspace.stateDirectory);
    let control: Awaited<ReturnType<typeof protectedDirectory>> | undefined;
    try {
      control = await protectedDirectory(workspace.controlDirectory);
      const stageStat = await stage.stat();
      const controlStat = await control.stat();
      if (stageStat.dev === controlStat.dev && stageStat.ino === controlStat.ino) {
        throw new Error("Held Native offline lock cannot share its mutable config root");
      }
      await takeFileLock(control);
      await assertHeld();
      const restoredConfig = await readRegularFile(workspace.originalConfig, 8 * 1024 * 1024);
      const anchorSha256 = digest(await readRegularFile(workspace.originalOwnerAnchor, 8 * 1024 * 1024));
      if (digest(restoredConfig) !== expected.cleanFileSha256 || anchorSha256 !== expected.ownerAnchorSha256) {
        throw new Error("Held Native offline source copy differs from its authenticated retained bytes");
      }
      await writeDurableFile(join(workspace.controlDirectory, request.nonce), request.action);
      await control.sync();
      const readStageDigest = () => readRegularFile(join(workspace.stateDirectory, "openclaw.json"), 8 * 1024 * 1024).then(digest);
      const stagedSha256 = request.action === "rollback"
        ? await restoreCleanConfig(request, workspace, restoredConfig, readStageDigest)
        : await reconcilePrivateConfig({ options, restoredConfig, assertHeld });
      await stage.sync();
      await assertHeld();
      if (await readStageDigest() !== stagedSha256) throw new Error("Held Native staged file changed before proof");
      return signOfflineNativeResult({
        request, fileSha256: stagedSha256, ownerAnchorSha256: anchorSha256,
        outcome: request.action === "rollback" ? "restored" : "staged",
      }, options.maintenancePrivateKey);
    } finally {
      await control?.close();
      await stage.close();
    }
  };
}

async function restoreCleanConfig(
  request: OfflineNativeRequest, workspace: MaintainedNativeWorkspace, bytes: Buffer, readStageDigest: () => Promise<string>,
): Promise<string> {
  await activateStagedConfig(workspace.stateDirectory, request.nonce, bytes);
  const restored = await readStageDigest();
  if (restored !== request.identity.cleanFileSha256) throw new Error("Held Native offline rollback did not restore exact bytes");
  return restored;
}

async function reconcilePrivateConfig(input: {
  options: OfflineWorkspaceOptions;
  restoredConfig: Buffer;
  assertHeld: () => Promise<void>;
}): Promise<string> {
  const { options, restoredConfig, assertHeld } = input;
  const workspace = options.workspace;
  const path = join(workspace.stateDirectory, "openclaw.json");
  try { await writeDurableFile(path, restoredConfig); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await readRegularFile(path, 8 * 1024 * 1024);
  }
  const result = await applyHeldNativeStagedConfig({
    stage: {
      environment: stageBootEnvironment(workspace), read: () => workspace.readStage(),
      assertPrivateStaging: () => workspace.assertIsolatedRuntime(),
      assertOwnerAnchorsAndRoster: value => workspace.assertOwnerAnchorsAndRoster(value),
    },
    compose: options.compose, assertHeld, runNative: options.runNative,
  });
  return result.stagedSha256;
}
