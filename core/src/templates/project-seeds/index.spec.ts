import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { ProjectRecipeId } from "@octogee/shared/types/project";
import {
  notesWelcomeSeed,
  projectPlaybookSeeds,
  projectRecipeStarterSeeds,
  type ProjectPlaybookSeedInput,
} from "./index.js";

const RECIPES: ProjectRecipeId[] = ["static-site", "vite-static", "astro-static"];

function seedsFor(overrides: Partial<ProjectPlaybookSeedInput> = {}) {
  return projectPlaybookSeeds({
    projectName: "Wild Card",
    projectType: null,
    recipe: "static-site",
    today: "2026-06-12",
    ...overrides,
  });
}

function page(relPath: string, overrides: Partial<ProjectPlaybookSeedInput> = {}) {
  return seedsFor(overrides).find((s) => s.relPath === relPath)!.content;
}

describe("projectPlaybookSeeds", () => {
  const seeds = () => seedsFor();

  it("seeds the project playbook files at repo-relative paths", () => {
    expect(seeds().map((s) => s.relPath).sort()).toEqual([
      "DECISIONS.md",
      "runbook/how-we-build.md",
      "runbook/shipping-on-gcp.md",
      "runbook/what-done-means.md",
      "runbook/working-with-your-agent.md",
    ]);
  });

  it("keeps the same file set for every project type", () => {
    for (const projectType of ["game", "social", "planner", "trip", "research", "event", "other", null]) {
      expect(seedsFor({ projectType }).map((s) => s.relPath).sort()).toEqual(
        seeds().map((s) => s.relPath).sort(),
      );
    }
  });

  it("seeds DECISIONS.md with a dated, timeline-parseable first entry", () => {
    const decisions = page("DECISIONS.md");
    expect(decisions).toContain("## 2026-06-12 — ");
    expect(decisions).toMatch(/^Why: /m);
    expect(decisions).toContain("Wild Card");
  });

  it("names the project on every seeded page", () => {
    for (const seed of seeds()) expect(seed.content).toContain("Wild Card");
  });

  it("carries the record-a-decision contract in working-with-your-agent", () => {
    expect(page("runbook/working-with-your-agent.md")).toMatch(/record a decision/i);
  });

  it("done means shipped", () => {
    expect(page("runbook/what-done-means.md")).toMatch(/shipped/i);
  });

  it("seeds an Octogee and GCP shipping guide for the project", () => {
    const shipping = page("runbook/shipping-on-gcp.md");
    expect(shipping).toMatch(/Octogee/i);
    expect(shipping).toMatch(/Google Cloud|GCP/i);
    expect(shipping).toMatch(/Firebase Hosting/i);
    expect(shipping).toContain("octogee-{workspaceSlug}-{projectSlug}.web.app");
    expect(shipping).toMatch(/Every merge ships/i);
    expect(shipping).toMatch(/preview/i);
    expect(shipping).toMatch(/secrets/i);
  });

  it("keeps platform doctrine out of the project seeds and points back to the workspace Platform Playbook", () => {
    for (const projectType of ["game", "social", "planner", "trip", "research", "event", null]) {
      for (const recipe of RECIPES) {
        const all = seedsFor({ projectType, recipe }).map((s) => s.content).join("\n");
        expect(all).toMatch(/Platform Playbook/i);
        expect(all).not.toMatch(/glm-controller/i);
        expect(all).not.toMatch(/gateway/i);
        expect(all).not.toMatch(/\bpod\b/i);
        expect(all).not.toMatch(/\bfleet\b/i);
        expect(all).not.toMatch(/octogee-api/i);
      }
    }
  });
});

describe("projectPlaybookSeeds — the starting recipe", () => {
  it("names the recipe and its publish contract in the shipping guide", () => {
    for (const recipe of RECIPES) {
      expect(page("runbook/shipping-on-gcp.md", { recipe })).toContain(recipe);
    }
    expect(page("runbook/shipping-on-gcp.md", { recipe: "static-site" })).toContain(
      "`public/` folder deploys as-is",
    );
    for (const recipe of ["vite-static", "astro-static"] as ProjectRecipeId[]) {
      const shipping = page("runbook/shipping-on-gcp.md", { recipe });
      expect(shipping).toContain("npm run build");
      expect(shipping).toContain("dist/");
      expect(shipping).not.toContain("`public/` folder deploys as-is");
    }
  });

  it("records the starting recipe as a dated decision, newest first", () => {
    for (const recipe of RECIPES) {
      const decisions = page("DECISIONS.md", { recipe });
      expect(decisions).toContain(`## 2026-06-12 — Wild Card starts on the ${recipe} recipe`);
      expect(decisions.indexOf("starts on the")).toBeLessThan(
        decisions.indexOf("keeps a decisions log"),
      );
    }
  });

  it("gives the recipe decision a type-appropriate why", () => {
    const game = page("DECISIONS.md", { projectType: "game", recipe: "vite-static" });
    const trip = page("DECISIONS.md", { projectType: "trip", recipe: "vite-static" });
    expect(game).toMatch(/^Why: .*play/m);
    expect(trip).toMatch(/^Why: .*itinerary/m);
    expect(game).not.toEqual(trip);
  });

  it("says the recipe can change and that the agent moves it", () => {
    const how = page("runbook/how-we-build.md");
    expect(how).toMatch(/not permanent|can change/i);
    expect(how).toMatch(/ask your agent/i);
    expect(how).toMatch(/platform record/i);
  });

  it("names the starting recipe in how-we-build for every recipe", () => {
    for (const recipe of RECIPES) {
      expect(page("runbook/how-we-build.md", { recipe })).toContain(recipe);
    }
  });
});

const TYPE_MARKERS: { projectType: string | null; markers: RegExp[] }[] = [
  { projectType: "game", markers: [/win-or-lose/i, /playtest with a stranger/i, /leaderboard/i] },
  { projectType: "social", markers: [/one profile and one post/i, /two browsers/i, /real accounts/i] },
  {
    projectType: "planner",
    markers: [/survives a reload/i, /the data model is the product/i, /the same list on two devices/i],
  },
  { projectType: "trip", markers: [/answers where and when/i, /airplane mode/i, /travel companions/i] },
  {
    projectType: "research",
    markers: [/one-page brief/i, /frame one decision/i, /the decision is the deliverable/i],
  },
  { projectType: "event", markers: [/one reason to come/i, /run of show/i, /organizer checklist/i] },
  { projectType: null, markers: [/blank canvas/i, /what this might become/i] },
];

describe("projectPlaybookSeeds — how-we-build doctrine", () => {
  it("teaches its own type's doctrine and nobody else's", () => {
    for (const { projectType, markers } of TYPE_MARKERS) {
      const how = page("runbook/how-we-build.md", { projectType });
      for (const marker of markers) expect(how).toMatch(marker);
      for (const other of TYPE_MARKERS) {
        if (other.projectType === projectType) continue;
        for (const marker of other.markers) expect(how).not.toMatch(marker);
      }
    }
  });

  it("carries the shared spine in every version", () => {
    for (const { projectType } of TYPE_MARKERS) {
      const how = page("runbook/how-we-build.md", { projectType });
      expect(how).toMatch(/The first slice we ship/i);
      expect(how).toMatch(/earns real app services/i);
      expect(how).toMatch(/smallest Firebase path/i);
      expect(how).toMatch(/local or mock data/i);
      expect(how).toMatch(/never\s+Octogee's own\s+platform database/i);
      expect(how).toMatch(/decisions log before\s+anything gets wired/i);
      expect(how).toContain("This project's defaults — edit these");
      expect(how).toContain("**Our proof link:** _the URL someone can open_");
    }
  });

  it("falls back to the blank-canvas doctrine for 'other', null, and unknown types", () => {
    const blank = page("runbook/how-we-build.md", { projectType: null });
    for (const projectType of ["other", "widget-emporium", "constructor", "toString", ""]) {
      expect(page("runbook/how-we-build.md", { projectType })).toBe(blank);
    }
    for (const { projectType } of TYPE_MARKERS) {
      if (projectType === null) continue;
      expect(page("runbook/how-we-build.md", { projectType })).not.toBe(blank);
    }
  });
});

describe("projectPlaybookSeeds — what done means", () => {
  const TYPE_DONE_LINES: [string, RegExp][] = [
    ["game", /asked to go again/i],
    ["social", /two different people did it to each other/i],
    ["planner", /the tab closed, and they were still there/i],
    ["trip", /from a phone on the sidewalk/i],
    ["research", /the decision is recorded/i],
    ["event", /a guest found where-and-when/i],
  ];

  it("adds the type's own done line", () => {
    for (const [projectType, line] of TYPE_DONE_LINES) {
      expect(page("runbook/what-done-means.md", { projectType })).toMatch(line);
    }
  });

  it("leaves the blank-canvas list to the common bar alone", () => {
    const done = page("runbook/what-done-means.md", { projectType: "other" });
    for (const [, line] of TYPE_DONE_LINES) expect(done).not.toMatch(line);
    expect(done).toMatch(/Done means shipped/);
  });

  it("keeps the common bar in every version", () => {
    for (const { projectType } of TYPE_MARKERS) {
      const done = page("runbook/what-done-means.md", { projectType });
      expect(done).toMatch(/It works for a real person/);
      expect(done).toMatch(/preview or live link/);
      expect(done).toMatch(/Done means shipped/);
    }
  });
});

describe("notesWelcomeSeed", () => {
  const seed = () => notesWelcomeSeed("Wild Card");

  it("seeds a flat welcome note (never README — it would pollute the rail label)", () => {
    expect(seed().relPath).toBe("notes/welcome.md");
  });

  it("explains the scratch convention and the promotion ritual in the scope's own name", () => {
    const content = seed().content;
    expect(content).toContain("Wild Card");
    expect(content).toMatch(/scratch|half-formed|thinking/i);
    expect(content).toMatch(/promote|graduate|decisions log/i);
  });

  it("invites deletion — a welcome note is not canon", () => {
    expect(seed().content).toMatch(/delete/i);
  });
});

describe("projectRecipeStarterSeeds", () => {
  it("gives a new Vite project an immutable installable dependency graph", () => {
    const seeds = projectRecipeStarterSeeds({
      projectSlug: "wildcard",
      recipe: "vite-static",
    });

    expect(seeds.map((seed) => seed.relPath)).toEqual([
      "package.json",
      "package-lock.json",
      "vendor/picomatch/picomatch-4.0.7-e1f8b86c.tgz",
    ]);
    const manifest = JSON.parse(seeds[0].content) as {
      name: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const lock = JSON.parse(seeds[1].content) as {
      name: string;
      lockfileVersion: number;
      packages: Record<string, { name?: string; devDependencies?: Record<string, string>; resolved?: string; integrity?: string }>;
    };
    expect(manifest).toMatchObject({
      name: "wildcard",
      scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
    });
    expect(Object.values(manifest.devDependencies)).not.toContain("latest");
    expect(lock).toMatchObject({
      name: "wildcard",
      lockfileVersion: 3,
      packages: {
        "": { name: "wildcard", devDependencies: manifest.devDependencies },
      },
    });
    const archive = seeds[2]!;
    const installed = lock.packages["node_modules/picomatch"]!;
    expect(archive.encoding).toBe("base64");
    expect(installed.resolved).toBe(`file:${archive.relPath}`);
    expect(installed.integrity).toBe(`sha512-${createHash("sha512").update(Buffer.from(archive.content, "base64")).digest("base64")}`);
  });

  it("does not pretend a dependency graph exists for another recipe", () => {
    for (const recipe of ["static-site", "astro-static"] as ProjectRecipeId[]) {
      expect(projectRecipeStarterSeeds({ projectSlug: "wildcard", recipe })).toEqual([]);
    }
  });
});
