

import type { ManagedChannelHost } from "@octogee/core/channel-host";
import type { ManagedGitHost } from "@octogee/core/git-host";
import { PROJECT_AGENT_REPO } from "@octogee/shared/types/project";
import type { UserDataScope } from "./user-lifecycle-product.js";

export interface NukeCloudCtx extends UserDataScope {
  repoNames: string[];
  projectSlugs: string[];
  workspaceTeamId: string | null;
  mmUserId: string | null;
  mmCoachUserId: string | null;
  adminChannelId: string | null;
  credentialSecretNames: string[];
  projectAgentMmUserIds: string[];
  projectAgentCredentialDocPaths: string[];
  skipHosting?: boolean;
  skipAuth?: boolean;
}

export type NukeCloudStepKey =
  | "gitea"
  | "mattermost"
  | "storage"
  | "hosting"
  | "credentials"
  | "computer"
  | "computer-home"
  | "records"
  | "sign-in";

export interface NukeCloudStepResult {
  key: NukeCloudStepKey;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  detail?: string;
}

export interface NukeCloudDeps {
  git: Pick<ManagedGitHost, "eraseOwner">;
  channels: Pick<ManagedChannelHost, "erase">;

  eraseUserRecords: (scope: UserDataScope) => Promise<void>;
  deleteUserStorage: (scope: UserDataScope) => Promise<void>;
  deleteCredentialSecrets: (secretNames: string[]) => Promise<void>;
  deleteSignIn?: (uid: string) => Promise<void>;
  deleteHostingSites?: (slug: string, projectSlugs: string[]) => Promise<{ deleted: number }>;
  deleteVm?: (uid: string) => Promise<boolean>;
  deleteVmHome?: (slug: string) => Promise<{ deleted: number }>;
  log?: (msg: string) => void;
}

export async function nukeUserCloudSide(
  ctx: NukeCloudCtx,
  deps: NukeCloudDeps,
): Promise<NukeCloudStepResult[]> {
  const log = deps.log ?? (() => undefined);
  const results: NukeCloudStepResult[] = [];

if (!ctx.slug) {
  results.push({ key: "gitea", ok: true, skipped: true });
} else {
  results.push(
    await runStep("gitea", log, async () => {
      await deps.git.eraseOwner(ctx.slug, [...ctx.repoNames, PROJECT_AGENT_REPO]);
    }),
  );
}

results.push(
    await runStep("mattermost", log, async () => {
      await deps.channels.erase({
        teamId: ctx.workspaceTeamId,
        ownerUserId: ctx.mmUserId,
        channelIds: ctx.adminChannelId ? [ctx.adminChannelId] : [],
        userIds: [
          ...(ctx.mmCoachUserId ? [ctx.mmCoachUserId] : []),
          ...ctx.projectAgentMmUserIds,
        ],
      });
    }),
  );

results.push(
    await runStep("storage", log, async () => {
      await deps.deleteUserStorage(ctx);
    }),
  );

if (ctx.skipHosting || !deps.deleteHostingSites || !ctx.slug) {
    results.push({ key: "hosting", ok: true, skipped: true });
  } else {
    results.push(
      await runStep("hosting", log, async () => {
        await deps.deleteHostingSites!(ctx.slug, ctx.projectSlugs);
      }),
    );
  }

  results.push(
    await runStep("credentials", log, async () => {
      await deps.deleteCredentialSecrets(ctx.credentialSecretNames);
    }),
  );

  if (deps.deleteVm) {
    const deleteVm = deps.deleteVm;
    results.push(
      await runStep("computer", log, async () => {
        await deleteVm(ctx.uid);
      }),
    );
  } else {
    results.push({ key: "computer", ok: true, skipped: true });
  }

  const deleteVmHome = deps.deleteVmHome;
  if (!ctx.slug || !deleteVmHome) {
    results.push({ key: "computer-home", ok: true, skipped: true });
  } else {
    results.push(
      await runStep("computer-home", log, async () => {
        const { deleted } = await deleteVmHome(ctx.slug);
        return `${deleted} ${deleted === 1 ? "object" : "objects"}`;
      }),
    );
  }

  const anchoredCleanupFailed = results.some((result) => ["hosting", "computer", "computer-home"].includes(result.key) && !result.ok);
  if (anchoredCleanupFailed) {
    results.push({ key: "records", ok: true, skipped: true });
  } else {
    results.push(
      await runStep("records", log, async () => {
        await deps.eraseUserRecords(ctx);
      }),
    );
  }

  const earlierFailure = results.some((result) => !result.ok && !result.skipped);
  const deleteSignIn = deps.deleteSignIn;
  if (ctx.skipAuth || earlierFailure || !deleteSignIn) {
    results.push({ key: "sign-in", ok: true, skipped: true });
  } else {
    results.push(
      await runStep("sign-in", log, async () => {
        await deleteSignIn(ctx.uid);
      }),
    );
  }

  return results;
}

async function runStep(
  key: NukeCloudStepKey,
  log: (msg: string) => void,
  body: () => Promise<string | void>,
): Promise<NukeCloudStepResult> {
  try {
    const detail = await body();
    log(detail ? `[nuke-cloud] step ${key} ✅ ${detail}` : `[nuke-cloud] step ${key} ✅`);
    return detail ? { key, ok: true, detail } : { key, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[nuke-cloud] step ${key} ⚠ ${message}`);
    return { key, ok: false, error: message };
  }
}
