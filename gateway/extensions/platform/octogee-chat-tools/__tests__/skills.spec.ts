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

  it("ships chat/SKILL.md with name + description frontmatter", () => {
    const body = fs.readFileSync(path.join(root, "skills", "chat", "SKILL.md"), "utf8");
    expect(body.startsWith("---")).toBe(true);
    expect(body).toMatch(/\nname:\s*chat\b/);
    expect(body).toMatch(/\ndescription:\s*\S/);
  });

  it("ships coach-identity/SKILL.md with the identity tool contract", () => {
    const body = fs.readFileSync(path.join(root, "skills", "coach-identity", "SKILL.md"), "utf8");
    expect(body.startsWith("---")).toBe(true);
    expect(body).toMatch(/\nname:\s*coach-identity\b/);
    expect(body).toMatch(/octogee_chat_set_identity/);
    expect(body).toMatch(/no brand logos/i);
  });

  it("ships catch-up/SKILL.md that re-primes a contextless conversation from chat history", () => {
    const body = fs.readFileSync(path.join(root, "skills", "catch-up", "SKILL.md"), "utf8");
    expect(body.startsWith("---")).toBe(true);
    expect(body).toMatch(/\nname:\s*catch-up\b/);
    // The description is the trigger — it must name the observable condition
    // (an ongoing conversation this session has no record of), not a vibe.
    expect(body).toMatch(/\ndescription:.*(no record|no memory|without context|missing context)/i);
    expect(body).toMatch(/octogee_chat_history/);
    expect(body).toMatch(/memory_search/);
    // Honesty contract: read back BEFORE answering, and the read-back is
    // full-fidelity — the agent's own replies come back labeled `self: true`
    // and standing commitments in them are honored, not re-litigated.
    expect(body).toMatch(/before/i);
    expect(body).toMatch(/own\s+(replies|posts|messages)/i);
    expect(body).toMatch(/self:\s*true/);
  });
});
