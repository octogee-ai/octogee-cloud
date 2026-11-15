import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { acquireSystemConfigSyncLeaseSync } from "@octogee/core/system-config-mutation-lease";
import { userClaimSlug } from "@octogee/shared/server/user-claim";

const DISABLED_MARKER = "system_config.watch.disabled";
const STATE_LOCK = "system_config.watch.state.lock";
const DEFAULT_FENCE_TIMEOUT_MS = 30_000;
const DEFAULT_FENCE_RETRY_MS = 25;

interface SystemConfigWatchFenceOptions {
  runtimeProjection?: true;
  heartbeatMs?: number;
  staleAfterMs?: number;
  timeoutMs?: number;
  retryMs?: number;
}

interface SystemConfigWatchFence {
  runtimeProjection?: true;
  slug: string;
  generation: string;
}

export function systemConfigWatchDisabledPath(openclawDir: string): string {
  return path.join(openclawDir, DISABLED_MARKER);
}

function readSystemConfigWatchFence(openclawDir: string): SystemConfigWatchFence | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(systemConfigWatchDisabledPath(openclawDir), "utf8"),
    ) as Partial<SystemConfigWatchFence>;
    if (
      typeof parsed.slug !== "string" ||
      parsed.slug.length === 0 ||
      typeof parsed.generation !== "string" ||
      parsed.generation.length === 0
    ) {
      throw new Error("system config watcher fence is invalid");
    }
    return { slug: parsed.slug, generation: parsed.generation, ...(parsed.runtimeProjection ? { runtimeProjection: true } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function isSystemConfigRuntimeProjection(openclawDir: string, slug: string): boolean {
  const fence = readSystemConfigWatchFence(openclawDir);
  return fence?.slug === slug && fence.runtimeProjection === true;
}

export function isSystemConfigWatchDisabled(openclawDir: string, slug: string): boolean {
  return readSystemConfigWatchFence(openclawDir)?.slug === slug;
}

export function readSystemConfigWatchFenceGeneration(
  openclawDir: string,
  slug: string,
): string | null {
  const fence = readSystemConfigWatchFence(openclawDir);
  return fence?.slug === slug ? fence.generation : null;
}

export function isConfiguredGatewayUser(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return userClaimSlug(env) === slug;
}

function rejectDifferentUserFence(openclawDir: string, slug: string): void {
  const current = readSystemConfigWatchFence(openclawDir);
  if (current !== null && current.slug !== slug) {
    throw new Error(`system config watcher fence belongs to ${current.slug}, not ${slug}`);
  }
}

async function acquireStateLock(
  openclawDir: string,
  options: SystemConfigWatchFenceOptions,
): Promise<() => Promise<void>> {
  await fsp.mkdir(openclawDir, { recursive: true });
  const timeoutMs = options.timeoutMs ?? DEFAULT_FENCE_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_FENCE_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const lease = acquireSystemConfigSyncLeaseSync({
      openclawDir,
      lockName: STATE_LOCK,
      heartbeatMs: options.heartbeatMs,
      staleAfterMs: options.staleAfterMs,
    });
    if (lease) {
      return async () => lease.release();
    }
    if (Date.now() >= deadline) {
      throw new Error(`system config watcher state lock timed out after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
  }
}

async function writeDisabledUserSlug(
  openclawDir: string,
  slug: string,
  options: SystemConfigWatchFenceOptions,
): Promise<string> {
  const releaseStateLock = await acquireStateLock(openclawDir, options);
  const target = systemConfigWatchDisabledPath(openclawDir);
  const generation = randomUUID();
  const temporary = `${target}.${process.pid}.${generation}.tmp`;
  try {
    rejectDifferentUserFence(openclawDir, slug);
    const runtimeProjection = options.runtimeProjection || readSystemConfigWatchFence(openclawDir)?.runtimeProjection;
    await fsp.writeFile(
      temporary,
      `${JSON.stringify({ slug, generation, ...(runtimeProjection ? { runtimeProjection: true } : {}) })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await fsp.rename(temporary, target);
    await fsp.chmod(target, 0o600);
    return generation;
  } finally {
    await fsp.rm(temporary, { force: true });
    await releaseStateLock();
  }
}

async function acknowledgeDrainedWriter(
  openclawDir: string,
  options: SystemConfigWatchFenceOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FENCE_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_FENCE_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const lease = acquireSystemConfigSyncLeaseSync({ openclawDir });
    if (lease) {
      lease.release();
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`system config watcher fence timed out draining writer after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
  }
}

export async function disableSystemConfigWatch(
  openclawDir: string,
  slug: string,
  options: SystemConfigWatchFenceOptions = {},
): Promise<string> {
  const generation = await writeDisabledUserSlug(openclawDir, slug, options);
  await acknowledgeDrainedWriter(openclawDir, options);
  return generation;
}

export async function enableSystemConfigWatch(
  openclawDir: string,
  slug: string,
  expectedGeneration?: string | null,
): Promise<boolean> {
  const releaseStateLock = await acquireStateLock(openclawDir, {});
  try {
    rejectDifferentUserFence(openclawDir, slug);
    const current = readSystemConfigWatchFence(openclawDir);
    if (!current) return false;
    if (
      expectedGeneration !== undefined &&
      current.generation !== expectedGeneration
    ) {
      return false;
    }
    await fsp.rm(systemConfigWatchDisabledPath(openclawDir));
    return true;
  } finally {
    await releaseStateLock();
  }
}
