import { createHash } from "node:crypto";

import { resyncSshKeyIfDrifted, type UserLifecycleAdapter } from "@octogee/core/user-lifecycle";

import { KeyRegistrationRefused, withResyncRegistration } from "./gitea-admin-broker-client.js";
import { pendingCloneOnlyStale } from "./pending-clone-fingerprint.js";
import { preStopStarted, type PreStopMarker } from "./prestop-marker.js";

export const GIT_KEY_RESYNC_INTERVAL_MS = 10 * 60_000;

export type GitKeyResyncPass = () => Promise<"ran" | "skipped">;

export interface GitKeyResyncDeps {
  adapter: Pick<UserLifecycleAdapter, "readLocalUserPubKey" | "giveUpUserGitKey" | "gitHost" | "log">;
  mountedUsers: () => readonly string[];
  settled: (slug: string) => boolean;
  podStopping: () => boolean;
  log: (message: string, fields?: { status: "failed" }) => void;
}

export interface GitKeyResyncUserState {
  ensureAllowed: boolean;
  desiredFingerprint: string | undefined;
  appliedFingerprint: string | undefined;
}

export function settledForGitKeyResync(state: GitKeyResyncUserState): boolean {
  const { desiredFingerprint: desired, appliedFingerprint: applied } = state;
  return state.ensureAllowed &&
    desired !== undefined &&
    (desired === applied || pendingCloneOnlyStale(applied, desired));
}

export interface GitKeyResyncRoster {
  ensureAllowed: ReadonlyMap<string, boolean>;
  desiredFingerprints: ReadonlyMap<string, string>;
  appliedFingerprints: ReadonlyMap<string, string>;
}

export function settledInRoster(roster: GitKeyResyncRoster): (slug: string) => boolean {
  return (slug) => settledForGitKeyResync({
    ensureAllowed: roster.ensureAllowed.get(slug) === true,
    desiredFingerprint: roster.desiredFingerprints.get(slug),
    appliedFingerprint: roster.appliedFingerprints.get(slug),
  });
}

export function gitKeyResyncJitterMs(podId: string, intervalMs: number): number {
  return createHash("sha256").update(podId).digest().readUInt32BE(0) % intervalMs;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class KeyResyncStoodDown extends Error {}

export function createGitKeyResync(deps: GitKeyResyncDeps): GitKeyResyncPass {
  const { adapter } = deps;
  const refusals = new Map<string, string>();
  let running = false;
  const failed = (message: string): void => deps.log(`[git-key-resync] ${message}`, { status: "failed" });

  function standDownUnlessStillServing(slug: string): void {
    if (deps.podStopping()) throw new KeyResyncStoodDown("the pod's prestop flush started");
    if (!deps.mountedUsers().includes(slug)) throw new KeyResyncStoodDown("the user was unmounted");
    if (!deps.settled(slug)) throw new KeyResyncStoodDown("the user stopped being settled here");
  }

  async function resyncUser(slug: string): Promise<void> {
    if (adapter.readLocalUserPubKey(slug) === null) {
      refusals.delete(slug);
      failed(`${slug}: no readable public key on disk, so nothing is resynced and the key directory is left as it is`);
      return;
    }
    try {
      const steps = await withResyncRegistration(() => standDownUnlessStillServing(slug), () => resyncSshKeyIfDrifted(adapter, slug, false));
      refusals.delete(slug);
      if (steps.length > 0) deps.log(`[git-key-resync] ${slug}: the key was missing on the git host and is registered again`);
    } catch (error) {
      if (error instanceof KeyResyncStoodDown) {
        deps.log(`[git-key-resync] ${slug}: ${error.message} since its keys were listed, so its key is not registered`);
        return;
      }
      if (!(error instanceof KeyRegistrationRefused)) {
        refusals.delete(slug);
        failed(`${slug}: the key resync failed and is tried again on the next pass: ${describe(error)}`);
        return;
      }
      if (refusals.get(slug) === error.reason) return;
      refusals.set(slug, error.reason);
      failed(`${slug}: the platform refuses to register this pod's key (reason ${error.reason}); it is asked again on every pass and logged again when the reason changes`);
    }
  }

  async function resyncSettledUsers(): Promise<void> {
    let mounted: readonly string[];
    try {
      mounted = deps.mountedUsers();
    } catch (error) {
      failed(`the mounted users could not be read, so this pass resyncs nothing: ${describe(error)}`);
      return;
    }
    for (const slug of [...refusals.keys()]) {
      if (!mounted.includes(slug)) refusals.delete(slug);
    }
    for (const slug of mounted) {
      if (deps.podStopping()) {
        deps.log("[git-key-resync] the pod's prestop flush started during this pass, so the remaining users are left alone");
        return;
      }
      if (deps.settled(slug)) await resyncUser(slug);
    }
  }

  return async () => {
    if (running) {
      deps.log("[git-key-resync] the previous pass is still running, so this tick is skipped");
      return "skipped";
    }
    if (deps.podStopping()) {
      deps.log("[git-key-resync] the pod's prestop flush has started and releases every key, so this tick is skipped");
      return "skipped";
    }
    running = true;
    try {
      await resyncSettledUsers();
      return "ran";
    } finally {
      running = false;
    }
  };
}

export function startGitKeyResync(pass: GitKeyResyncPass, schedule: { intervalMs: number; jitterMs: number }, log: GitKeyResyncDeps["log"]): () => void {
  let interval: NodeJS.Timeout | null = null;
  const tick = (): void => {
    pass().catch((error: unknown) => log(`[git-key-resync] a pass failed and the next one runs on schedule: ${describe(error)}`, { status: "failed" }));
  };
  const first = setTimeout(() => {
    tick();
    interval = setInterval(tick, schedule.intervalMs);
    interval.unref();
  }, schedule.jitterMs);
  first.unref();
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}

export interface PodGitKeyResync {
  adapter: GitKeyResyncDeps["adapter"];
  mountedUsers: () => readonly string[];
  roster: GitKeyResyncRoster;
  marker: PreStopMarker;
  intervalMs?: number;
}

export function startGitKeyResyncForPod(input: PodGitKeyResync): () => void {
  const { adapter, marker, intervalMs = GIT_KEY_RESYNC_INTERVAL_MS } = input;
  const pass = createGitKeyResync({
    adapter,
    mountedUsers: input.mountedUsers,
    settled: settledInRoster(input.roster),
    podStopping: () => {
      try {
        return preStopStarted(marker);
      } catch (error) {
        adapter.log(`[git-key-resync] the prestop marker could not be read, so no key is resynced: ${describe(error)}`, { status: "failed" });
        return true;
      }
    },
    log: adapter.log,
  });
  return startGitKeyResync(pass, { intervalMs, jitterMs: gitKeyResyncJitterMs(marker.podId, intervalMs) }, adapter.log);
}
