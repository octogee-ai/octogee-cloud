import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Guards that the plugin BUNDLES its skill: the manifest must declare `skills`
// (so openclaw loads it when the plugin is enabled) AND the SKILL.md must exist
// with the frontmatter openclaw requires (name + description).
describe("bundled skills", () => {
  const root = path.join(__dirname, "..");

  it("declares ./skills in the manifest", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"),
    ) as { skills?: unknown };
    expect(manifest.skills).toEqual(["./skills"]);
  });

  it("ships workspace-commit/SKILL.md with name + description frontmatter", () => {
    const body = fs.readFileSync(path.join(root, "skills", "workspace-commit", "SKILL.md"), "utf8");
    expect(body.startsWith("---")).toBe(true);
    expect(body).toMatch(/\nname:\s*workspace-commit\b/);
    expect(body).toMatch(/\ndescription:\s*\S/);
  });

  it("ships canvas-dashboard/SKILL.md with name + description frontmatter", () => {
    const body = fs.readFileSync(path.join(root, "skills", "canvas-dashboard", "SKILL.md"), "utf8");
    expect(body.startsWith("---")).toBe(true);
    expect(body).toMatch(/\nname:\s*canvas-dashboard\b/);
    expect(body).toMatch(/\ndescription:\s*\S/);
  });
});
