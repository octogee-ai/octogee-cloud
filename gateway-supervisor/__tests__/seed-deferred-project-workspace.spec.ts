import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// CUSTOMERS_DIR resolves from OPENCLAW_DIR when @octogee/core/config first
// loads, so the root is fixed before any import and each case uses its own slug.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-deferred-project-"));
process.env.OPENCLAW_DIR = root;

const { deferredProjectPlaceholderPaths, seedDeferredProjectWorkspace } = await import("../lib/deferred-project-workspace.js");

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function projectDir(slug: string, projectSlug: string): string {
  return path.join(root, "customers", slug, "projects", projectSlug);
}

describe("seedDeferredProjectWorkspace", () => {
  it("leaves a workspace file behind so OpenClaw does not call the directory vanished", () => {
    expect(seedDeferredProjectWorkspace("alpha", "octogee")).toBe(true);

    const present = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"].filter((name) =>
      fs.existsSync(path.join(projectDir("alpha", "octogee"), name)),
    );
    expect(present.length).toBeGreaterThan(0);
  });

  it("says the checkout lives on the isolated runtime rather than pretending the project is empty", () => {
    seedDeferredProjectWorkspace("bravo", "octogee");

    const body = fs.readFileSync(path.join(projectDir("bravo", "octogee"), "AGENTS.md"), "utf-8");
    expect(body).toMatch(/isolated runtime/);
    expect(body).toMatch(/octogee/);
  });

  it("never overwrites a workspace the agent already authored", () => {
    const dir = projectDir("charlie", "octogee");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SOUL.md"), "the agent's own identity\n", "utf-8");

    expect(seedDeferredProjectWorkspace("charlie", "octogee")).toBe(false);

    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "SOUL.md"), "utf-8")).toBe("the agent's own identity\n");
  });

  it("leaves a dangling workspace marker in place without creating its target", () => {
    const dir = projectDir("delta", "octogee");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync("missing.md", path.join(dir, "AGENTS.md"));

    expect(seedDeferredProjectWorkspace("delta", "octogee")).toBe(false);
    expect(fs.readlinkSync(path.join(dir, "AGENTS.md"))).toBe("missing.md");
    expect(fs.existsSync(path.join(dir, "missing.md"))).toBe(false);
    expect(deferredProjectPlaceholderPaths(root, "delta")).toEqual([]);
  });
});
