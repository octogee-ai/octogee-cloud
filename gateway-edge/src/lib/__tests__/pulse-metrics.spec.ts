import { describe, it, expect } from "vitest";
import {
  conventionalType,
  isRevert,
  isDependencyBump,
  isGeneratedPath,
  median,
  pctDelta,
  computeDxCore4,
  type PulseWindow,
  type PulsePr,
} from "../pulse-metrics.js";

describe("conventionalType", () => {
  it("extracts the type with zero, one, or multiple scope groups", () => {
    expect(conventionalType("feat(board): kanban")).toBe("feat");
    expect(conventionalType("fix: typo")).toBe("fix");
    expect(conventionalType("chore(octogee-api)(deps-dev): bump @types/node")).toBe("chore");
  });
  it("returns null for descriptive (non-conventional) titles", () => {
    expect(conventionalType("Bump lodash from 1 to 2")).toBeNull();
    expect(conventionalType("Rename durable-artifact path")).toBeNull();
    expect(conventionalType("octogee-api: cut over to core")).toBeNull(); // not `type:`
  });
});

describe("isRevert", () => {
  it("flags reverts in either form", () => {
    expect(isRevert('Revert "feat: x"')).toBe(true);
    expect(isRevert("revert(core): undo")).toBe(true);
    expect(isRevert("feat: not a revert")).toBe(false);
  });
});

describe("isDependencyBump", () => {
  it("flags dependabot/renovate-style bumps across title and conventional forms", () => {
    expect(isDependencyBump("Bump vite from 8.0 to 8.1")).toBe(true); // dependabot title
    expect(isDependencyBump("Update dependency eslint to v9")).toBe(true); // renovate title
    expect(isDependencyBump("chore(deps): bump react")).toBe(true); // squash subject
    expect(isDependencyBump("chore(octogee-api)(deps-dev): bump @types/node")).toBe(true); // double scope
    expect(isDependencyBump("build(deps-dev): bump tsx")).toBe(true);
    expect(isDependencyBump("[Snyk] Security upgrade lodash")).toBe(true);
    expect(isDependencyBump("feat: real work")).toBe(false);
    expect(isDependencyBump("fix: update the cache to expire")).toBe(false); // not a dep PR
  });
});

describe("isGeneratedPath (the noise filter)", () => {
  it("flags lockfiles, vendored tarballs, build output, maps", () => {
    for (const p of [
      "app/package-lock.json",
      "yarn.lock",
      "gateway/openclaw-tarball/openclaw.tgz",
      "app/dist/index.js",
      "x.min.js",
      "a/b.js.map",
    ]) {
      expect(isGeneratedPath(p)).toBe(true);
    }
  });
  it("keeps real source", () => {
    expect(isGeneratedPath("app/src/lib/board/metrics.ts")).toBe(false);
    expect(isGeneratedPath("docs/specs/PULSE-SPEC.md")).toBe(false);
  });
});

describe("median", () => {
  it("returns the middle (or mean of two middles), or null when empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("pctDelta — week over week", () => {
  it("computes percent change and matches the dogfood headline (266 vs 157 = +69%)", () => {
    const d = pctDelta(266, 157);
    expect(d.current).toBe(266);
    expect(d.previous).toBe(157);
    expect(Math.round(d.pct!)).toBe(69);
  });
  it("returns null pct when the previous value is zero (no false infinity)", () => {
    expect(pctDelta(2, 0).pct).toBeNull();
  });
});

// Default PR: 1h lead time. The two feat PRs override to 0h and 2h, so the six
// lead times are [0, 2, 1, 1, 1, 1] → sorted [0,1,1,1,1,2] → median 1h.
function pr(p: Partial<PulsePr>): PulsePr {
  return { title: "feat: x", createdAt: "2026-06-20T00:00:00Z", mergedAt: "2026-06-20T01:00:00Z", additions: 0, deletions: 0, ...p };
}

describe("computeDxCore4", () => {
  const window: PulseWindow = {
    commits: 286,
    issuesClosed: 22,
    issuesOpened: 1,
    revertCommits: [{ subject: 'Revert "broke prod"', url: "https://x/commit/abc" }],
    prs: [
      pr({ title: "feat(board): kanban", mergedAt: "2026-06-20T00:00:00Z" }), // 0h
      pr({ title: "feat(pulse): engine", mergedAt: "2026-06-20T02:00:00Z" }), // 2h
      pr({ title: "fix: guard" }),
      pr({ title: "chore: tidy" }),
      pr({ title: "Rename the thing" }), // descriptive → other
      pr({ title: "Bump vite from 8.0 to 8.1" }),
    ],
  };

  it("rolls PRs into DX Core 4 dimensions; reverts come from commits, not PR titles", () => {
    const m = computeDxCore4(window);
    expect(m.speed.prsMerged).toBe(6);
    expect(m.speed.commits).toBe(286);
    expect(m.speed.leadTimeMedianHours).toBe(1);
    expect(m.quality.reverts).toBe(1); // from revertCommits, even though no PR title is a revert
    expect(m.impact.feat).toBe(2);
    expect(m.impact.fix).toBe(1);
    expect(m.impact.chore).toBe(1);
    expect(m.impact.other).toBe(1); // the descriptive "Rename" PR
    expect(m.impact.issuesClosed).toBe(22);
    expect(m.deps).toBe(1);
  });

  it("counts zero reverts when no commit is a revert, regardless of PR titles", () => {
    const m = computeDxCore4({ ...window, revertCommits: [] });
    expect(m.quality.reverts).toBe(0);
  });

  it("computes new-capability share from classified work (excluding deps)", () => {
    // feat 2 / (feat 2 + fix 1 + chore 1 + other 1) = 2/5
    const m = computeDxCore4(window);
    expect(m.impact.newCapabilityShare).toBeCloseTo(0.4, 3);
  });

  it("filters generated paths out of LOC totals", () => {
    const w: PulseWindow = {
      commits: 1, issuesClosed: 0, issuesOpened: 0, revertCommits: [],
      prs: [pr({ title: "feat: x", files: [
        { path: "app/src/a.ts", additions: 10, deletions: 2 },
        { path: "app/package-lock.json", additions: 5000, deletions: 4000 },
      ] } as Partial<PulsePr>)],
    };
    const m = computeDxCore4(w);
    expect(m.loc.added).toBe(10);
    expect(m.loc.removed).toBe(2);
  });
});
