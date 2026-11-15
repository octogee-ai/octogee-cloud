// Pulse — the pure DX Core 4 metrics engine. Takes a window's worth of normalized
// signals (PRs + commit count + issue flow) and rolls them into Speed / Quality /
// Impact, week-over-week-ready. Effectiveness (DXI) is survey-based → out of scope.
// Pure: no fetch, no clock — the ingestion layer windows + normalizes; this computes.

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface PulsePr {
  title: string;
  createdAt: string;
  mergedAt: string;
  additions: number;
  deletions: number;
  files?: FileChange[];
}

export interface RevertCommit {
  subject: string;
  url: string;
}

export interface PulseWindow {
  prs: PulsePr[];
  commits: number;
  // Reverts come from commit subjects, not PR titles — a direct `Revert "…"` commit to
  // main has no PR, so PR-title matching misses it (it read 0 when there were 2). The
  // ingestion filters commits with isRevert and passes them here as evidence.
  revertCommits: RevertCommit[];
  issuesClosed: number;
  issuesOpened: number;
}

// Allow zero or more scope groups: `feat:`, `fix(core):`, `chore(api)(deps-dev):`.
const TYPE_RE = /^([a-z]+)(\([^)]*\))*!?:/;

export function conventionalType(subject: string): string | null {
  const m = TYPE_RE.exec(subject.trim());
  return m ? m[1] : null;
}

export function isRevert(subject: string): boolean {
  const s = subject.trim();
  return /^revert/i.test(s) || conventionalType(s) === "revert";
}

// Bot dependency PRs are the bulk of merge volume, and their *titles* aren't
// conventional ("Bump X from A to B", "Update dep X to Y") even when the squash
// subject is `chore(deps):`. Catch the common bot title shapes so they land in the
// autopilot bucket instead of polluting "other".
export function isDependencyBump(subject: string): boolean {
  const s = subject.trim();
  return (
    /^bump\s/i.test(s) ||
    /^update\b.*\bto\b/i.test(s) ||
    /^\[snyk\]/i.test(s) ||
    /\(deps(-dev)?\)/i.test(s) || // a (deps) / (deps-dev) scope anywhere: chore(api)(deps): bump …
    /dependabot|renovate/i.test(s)
  );
}

// LOC headlines lie unless generated + vendored paths are filtered first (lockfiles,
// the committed @octogee/core interface, build output, sourcemaps).
const GENERATED_RE: RegExp[] = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/,
  /\.tgz$/,
  /(^|\/)(dist|build)\//,
  /\.min\.js$/,
  /\.map$/,
  /(^|\/)node_modules\//,
];

export function isGeneratedPath(path: string): boolean {
  return GENERATED_RE.some((re) => re.test(path));
}

export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface Delta {
  current: number;
  previous: number;
  pct: number | null;
}

export function pctDelta(current: number, previous: number): Delta {
  return { current, previous, pct: previous === 0 ? null : ((current - previous) / previous) * 100 };
}

export interface DxCore4 {
  speed: { prsMerged: number; commits: number; leadTimeMedianHours: number | null };
  quality: { reverts: number; fixes: number };
  impact: {
    feat: number;
    fix: number;
    chore: number;
    other: number;
    issuesClosed: number;
    issuesOpened: number;
    newCapabilityShare: number | null;
  };
  loc: { added: number; removed: number };
  deps: number;
}

function prLoc(pr: PulsePr): { added: number; removed: number } {
  if (!pr.files) return { added: pr.additions, removed: pr.deletions };
  let added = 0;
  let removed = 0;
  for (const f of pr.files) {
    if (isGeneratedPath(f.path)) continue;
    added += f.additions;
    removed += f.deletions;
  }
  return { added, removed };
}

function leadHours(pr: PulsePr): number | null {
  const ms = Date.parse(pr.mergedAt) - Date.parse(pr.createdAt);
  return Number.isFinite(ms) ? ms / 3_600_000 : null;
}

export function computeDxCore4(window: PulseWindow): DxCore4 {
  let feat = 0;
  let fix = 0;
  let chore = 0;
  let other = 0;
  let deps = 0;
  let added = 0;
  let removed = 0;
  const leads: number[] = [];

  for (const pr of window.prs) {
    if (isDependencyBump(pr.title)) {
      deps += 1;
    } else {
      const type = conventionalType(pr.title);
      if (type === "feat") feat += 1;
      else if (type === "fix") fix += 1;
      else if (type === "chore") chore += 1;
      else other += 1;
    }
    const loc = prLoc(pr);
    added += loc.added;
    removed += loc.removed;
    const lh = leadHours(pr);
    if (lh !== null) leads.push(lh);
  }

  // Coverage caveat: `other` is work with descriptive (non-conventional) titles that
  // prefix-matching can't type — often the bulk on repos that don't enforce prefixes.
  // So newCapabilityShare is a floor (features hidden in `other` aren't counted);
  // accurate Impact typing wants labels or the agent's semantic pass (Pulse Phase 4).
  const typed = feat + fix + chore + other;
  return {
    speed: { prsMerged: window.prs.length, commits: window.commits, leadTimeMedianHours: median(leads) },
    quality: { reverts: window.revertCommits.length, fixes: fix },
    impact: {
      feat,
      fix,
      chore,
      other,
      issuesClosed: window.issuesClosed,
      issuesOpened: window.issuesOpened,
      newCapabilityShare: typed === 0 ? null : feat / typed,
    },
    loc: { added, removed },
    deps,
  };
}
