import { describe, expect, it } from "vitest";
import { fetchPulseReport, fetchPulseWindow } from "../lib/pulse-ingest.js";
import { computeDxCore4, pctDelta } from "../lib/pulse-metrics.js";
import type { FileTarget } from "@octogee/core/workspace/fileTarget";

const RUN_LIVE = process.env.RUN_LIVE === "1";

function octogee(): FileTarget {
  return {
    slug: "live",
    projectSlug: "live",
    provider: "github",
    org: "octogee-ai",
    repoName: "octogee",
    gcsPrefix: "live",
    githubToken: process.env.GITHUB_TOKEN,
  };
}

// The dogfood: the whole Pulse pipeline (ingest → DX Core 4 → week-over-week) on the
// real repo. Needs a token that can read the private repo.
describe.skipIf(!RUN_LIVE || !process.env.GITHUB_TOKEN)("Pulse — live dogfood on octogee-ai/octogee", () => {
  it("scores DX Core 4 for this week vs last", async () => {
    const tgt = octogee();
    const [thisW, lastW] = await Promise.all([
      fetchPulseWindow(tgt, "2026-06-19", "2026-06-26"),
      fetchPulseWindow(tgt, "2026-06-12", "2026-06-19"),
    ]);
    const cur = computeDxCore4(thisW);
    const prev = computeDxCore4(lastW);

    console.log("THIS week:", JSON.stringify(cur, null, 0));
    console.log("LAST week:", JSON.stringify(prev, null, 0));
    console.log("PRs week-over-week:", JSON.stringify(pctDelta(cur.speed.prsMerged, prev.speed.prsMerged)));

    expect(cur.speed.prsMerged).toBeGreaterThan(50);
    expect(cur.speed.leadTimeMedianHours).not.toBeNull();
    expect(cur.impact.feat + cur.impact.fix + cur.impact.chore).toBeGreaterThan(0);
  }, 60_000);

  it("assembles the full report (current + previous + trend)", async () => {
    const report = await fetchPulseReport(octogee(), Date.parse("2026-06-26T12:00:00Z"));
    expect(report.current.speed.prsMerged).toBeGreaterThan(50);
    expect(report.previous.speed.prsMerged).toBeGreaterThan(0);
    expect(report.trendPrs).toHaveLength(6);
    expect(report.trendPrs[5]).toBe(report.current.speed.prsMerged); // newest = current
    expect(report.week.until).toBe("2026-06-26");
    expect(report.current.quality.reverts).toBe(report.reverts.length); // count matches evidence
    expect(Array.isArray(report.stalePrs)).toBe(true);
    expect(report.bugs).toHaveProperty("openNow");
  }, 90_000);
});
