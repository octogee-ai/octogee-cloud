import type {
  FleetBrokerProjectRestore,
  FleetBrokerUserSnapshot,
} from "@octogee/shared/types/fleet-broker";
import { projectCheckoutEnabled } from "@octogee/shared/types/project";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";

// A stable fingerprint of the fields of a user snapshot that shape what an ensure
// applies on disk — the generated OpenClaw config (agents.list,
// channels.mattermost.accounts, bindings) AND the project checkouts the ensure clones. The
// reconcile compares a mounted user's desired fingerprint against the one applied at
// its last successful ensure; a mismatch means the on-disk state is stale and the
// user must be re-ensured even though its mounted membership is unchanged. This is
// what makes a project-agent toggle converge on the next tick instead of only on remount.
//
// `projectCloneSet` is fingerprinted for targets that restore project checkouts because the
// clone only ever runs for an ACTIVE project (listProjectsNeedingClone skips the rest), while
// project create writes the MM channel BEFORE it flips provisioningState to active. Targets
// explicitly scoped to workspace-only project this set away.
//
// It hashes the SET the ensure would actually clone — repo present AND active (or legacy
// undefined), mirroring listProjectsNeedingClone's own filter — rather than raw project
// state. So provisioning→active is drift, while provisioning→failed (never cloned) is not,
// and a repo RENAME is not: cloneProjectRepo skips any path that already has a .git, so
// calling a rename "drift" would only record a fresh fingerprint over a stale checkout.
//
// Deliberately EXCLUDES fields the ensure never reads (status, repoUrl,
// email, ownerName, …) so routine snapshot churn does not trigger needless re-ensures.

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([k, v]) => JSON.stringify(k) + ":" + stableStringify(v));
  return `{${entries.join(",")}}`;
}

// 64-bit FNV-1a (two 32-bit lanes with distinct offset bases) over the canonical string.
// Deterministic — no Date/Math.random — so a resumed reconcile fingerprints identically.
function fnv1a64Hex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function projectCloneKey(project: FleetBrokerProjectRestore): string {
  const repoSource = project.repoSource;
  if (repoSource?.workingCopy?.ready) return `${project.projectSlug}@${project.giteaRepoName}`;
  return repoSource?.provider === "github"
    ? `${project.projectSlug}@github:${repoSource.owner}/${repoSource.repo}`
    : project.projectSlug;
}

export function snapshotConfigFingerprint(snapshot: FleetBrokerUserSnapshot, now: Date = new Date()): string {
  const entitlements = userEntitlements();
  const configSlice = {
    projectCoachMembershipIsolationVersion: 1,
    // Order-independent: bindings/accounts are keyed, not positional.
    channels: [...snapshot.channels]
      .map((c) => ({ scope: c.scope, kind: c.kind, channelId: c.channelId, projectId: c.projectId }))
      .sort((a, b) => compareStrings(a.channelId, b.channelId)),
    projectAgents: [...(snapshot.projectAgents ?? [])]
      .map((p) => ({ projectId: p.projectId, enabled: p.enabled, mmUserId: p.mmUserId, token: p.token, activationId: p.activationId, identity: p.identity, githubBacked: p.githubBacked, deliveryPending: p.deliveryPending }))
      .sort((a, b) => compareStrings(a.projectId, b.projectId)),
    projectCloneSet: snapshot.projectCheckoutScope === "workspace-only" ? [] : [...(snapshot.projects ?? [])]
      .filter(
        (p) =>
          (!!p.giteaRepoName || p.repoSource?.provider === "github")
          && (p.provisioningState === undefined || p.provisioningState === "active")
          && projectCheckoutEnabled(p.checkoutEnabled),
      )
      .map(projectCloneKey)
      .sort(compareStrings),
    coachIdentity: snapshot.coachIdentity ?? null,
    coachToken: snapshot.coachToken,
    coachMmUserId: snapshot.coachMmUserId,
    customerMmUserId: snapshot.customerMmUserId,
    systemConfig: snapshot.systemConfig ?? null,
    byotActive: snapshot.byotActive ?? false,
    plan: entitlements.policy(snapshot.planInputs, now),
    contextFilePolicy: entitlements.contextFilePolicy(snapshot.planInputs, now),
    contextTemplateKey: snapshot.contextTemplateKey,
    // The operator's house model dial: a flip must re-ensure every mounted
    // house-only user, not wait for the next roll.
    freeTierModelRef: snapshot.freeTierModelRef ?? null,
    // The user agent default dial: a flip must re-ensure every mounted
    // catalog user running the platform default.
    builderAgentDefault: snapshot.builderAgentDefault ?? null,
    // The user's time zone lands in USER.md at reassert time, so a change
    // must re-ensure the mounted user.
    timeZone: snapshot.timeZone ?? null,
  };
  return fnv1a64Hex(stableStringify(configSlice));
}
