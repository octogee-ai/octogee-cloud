import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

let tmpRoot: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tier-tpl-"));
  prevEnv = process.env.OCTOGEE_TEMPLATES_DIR;
  process.env.OCTOGEE_TEMPLATES_DIR = tmpRoot;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.OCTOGEE_TEMPLATES_DIR;
  else process.env.OCTOGEE_TEMPLATES_DIR = prevEnv;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function seedTier(tier: string, files: string[]): void {
  const dir = path.join(tmpRoot, "tiers", tier);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), `# ${f}\n`, "utf-8");
}

async function load() {
  const mod = await import(
    "../lib/tier-template-files.ts?t=" + Date.now()
  );
  return mod;
}

describe("listTierTemplateFiles", () => {
  it("returns only the files present in the tier directory", async () => {
    seedTier("trial", ["AGENTS.md", "BOOTSTRAP.md", "SOUL.md", "IDENTITY.md"]);
    seedTier("default", ["AGENTS.md", "BOOTSTRAP.md", "SOUL.md", "MEMORY.md"]);
    const { listTierTemplateFiles } = await load();
    expect(listTierTemplateFiles("trial").sort()).toEqual(
      ["AGENTS.md", "BOOTSTRAP.md", "IDENTITY.md", "SOUL.md"],
    );
    expect(listTierTemplateFiles("default").sort()).toEqual(
      ["AGENTS.md", "BOOTSTRAP.md", "MEMORY.md", "SOUL.md"],
    );
  });

  it("does not include files removed from a tier", async () => {
    seedTier("trial", ["AGENTS.md", "BOOTSTRAP.md", "SOUL.md"]);
    const { listTierTemplateFiles } = await load();
    expect(listTierTemplateFiles("trial")).not.toContain("MEMORY.md");
  });

  it("includes new files added to a tier without a code change", async () => {
    seedTier("trial", ["AGENTS.md", "IDENTITY.md"]);
    const { listTierTemplateFiles } = await load();
    expect(listTierTemplateFiles("trial")).toContain("IDENTITY.md");
  });

  it("ignores subdirectories and non-md files", async () => {
    const trialDir = path.join(tmpRoot, "tiers", "trial");
    fs.mkdirSync(trialDir, { recursive: true });
    fs.writeFileSync(path.join(trialDir, "AGENTS.md"), "# A\n");
    fs.writeFileSync(path.join(trialDir, "config.json"), "{}\n");
    fs.writeFileSync(path.join(trialDir, ".DS_Store"), "");
    fs.mkdirSync(path.join(trialDir, "subdir"));
    fs.writeFileSync(path.join(trialDir, "subdir", "SHOULD_NOT_COPY.md"), "x");

    const { listTierTemplateFiles } = await load();
    const out = listTierTemplateFiles("trial");
    expect(out).toEqual(["AGENTS.md"]);
  });

  it("throws a clear error when the tier directory does not exist", async () => {
    const { listTierTemplateFiles } = await load();
    expect(() => listTierTemplateFiles("nope-not-a-tier")).toThrow(
      /tiers\/nope-not-a-tier/,
    );
  });
});

function customerDir(name = "alice"): string {
  const dir = path.join(tmpRoot, "customers", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("writeTierTemplateFiles — write-if-missing (cattle recovery)", () => {
  it("regenerates a missing gitignored file without clobbering a present tracked one", async () => {
    seedTier("default", ["AGENTS.md", "SOUL.md"]);
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "SOUL.md"), "USER-EDITED SOUL\n", "utf-8");

    const { writeTierTemplateFiles } = await load();
    const written = writeTierTemplateFiles(dir, "default", { slug: "alice" });

    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "SOUL.md"), "utf-8")).toBe("USER-EDITED SOUL\n");
    expect(written).toContain("AGENTS.md");
    expect(written).not.toContain("SOUL.md");
  });

  it("removes legacy AGENTS.md and TOOLS.md ignores so context files are user-owned", async () => {
    seedTier("default", ["AGENTS.md", "TOOLS.md"]);
    const dir = customerDir("owned");
    fs.writeFileSync(
      path.join(dir, ".gitignore"),
      ["AGENTS.md", "TOOLS.md", ".ssh/", "node_modules/", ""].join("\n"),
      "utf-8",
    );

    const { writeTierTemplateFiles } = await load();
    writeTierTemplateFiles(dir, "default", {});

    const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
    expect(gitignore).not.toMatch(/^AGENTS\.md$/m);
    expect(gitignore).not.toMatch(/^TOOLS\.md$/m);
    expect(gitignore).toMatch(/^\.ssh\/$/m);
    expect(gitignore).toMatch(/^node_modules\/$/m);
  });

  it("writes every template file on a fresh dir", async () => {
    seedTier("default", ["AGENTS.md", "SOUL.md", "TOOLS.md"]);
    const dir = customerDir("bob");

    const { writeTierTemplateFiles } = await load();
    const written = writeTierTemplateFiles(dir, "default", {});

    for (const f of ["AGENTS.md", "SOUL.md", "TOOLS.md"]) {
      expect(fs.existsSync(path.join(dir, f))).toBe(true);
    }
    expect(written).toEqual(expect.arrayContaining(["AGENTS.md", "SOUL.md", "TOOLS.md"]));
  });

  it("does not copy retired context directories into user workspaces", async () => {
    seedTier("default", ["AGENTS.md"]);
    const retiredContextDir = path.join(tmpRoot, ["br", "ain-context"].join(""));
    fs.mkdirSync(retiredContextDir, { recursive: true });
    fs.writeFileSync(path.join(retiredContextDir, "DEVELOPER.md"), "# Retired\n", "utf-8");
    const dir = customerDir("legacy");

    const { writeTierTemplateFiles } = await load();
    const written = writeTierTemplateFiles(dir, "default", {});

    expect(written.filter((item) => item.endsWith("/"))).toEqual([]);
    expect(fs.readdirSync(dir).sort()).toEqual(["AGENTS.md"]);
  });

  it("is a no-op when every file already exists", async () => {
    seedTier("default", ["AGENTS.md"]);
    const dir = customerDir("carol");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "EXISTING\n", "utf-8");

    const { writeTierTemplateFiles } = await load();
    const written = writeTierTemplateFiles(dir, "default", {});

    expect(written).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("EXISTING\n");
  });

  it("applies template placeholders in regenerated files", async () => {
    const tierDir = path.join(tmpRoot, "tiers", "default");
    fs.mkdirSync(tierDir, { recursive: true });
    fs.writeFileSync(path.join(tierDir, "AGENTS.md"), "Hello {{slug}}\n", "utf-8");
    const dir = customerDir("dave");

    const { writeTierTemplateFiles } = await load();
    writeTierTemplateFiles(dir, "default", { slug: "dave" });

    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("Hello dave\n");
  });
});
