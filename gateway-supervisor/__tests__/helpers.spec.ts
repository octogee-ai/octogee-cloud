import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  slugify,
  generatePersonalSlug,
  getTemplateForBusinessType,
  applyTemplatePlaceholders,
  copyDirSync,
  BUSINESS_TYPE_TEMPLATES,
} from "../lib/helpers.js";

describe("slugify", () => {
  it("lowercases and replaces non-alphanumeric with hyphens", () => {
    expect(slugify("My Cool Business")).toBe("my-cool-business");
  });

  it("strips leading/trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  it("handles special characters", () => {
    expect(slugify("Bob's Café & Bar!")).toBe("bob-s-caf-bar");
  });

  it("returns empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });

  it("truncates to 30 characters", () => {
    const long = "a".repeat(50);
    expect(slugify(long).length).toBeLessThanOrEqual(30);
  });

  it("handles all-special-char input", () => {
    expect(slugify("!!!@@@###")).toBe("");
  });
});

describe("generatePersonalSlug", () => {
  it("returns a string", () => {
    const slug = generatePersonalSlug();
    expect(typeof slug).toBe("string");
  });

  it("matches two-word-hyphen format", () => {
    const slug = generatePersonalSlug();
    expect(slug).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("generates different slugs on successive calls", () => {
    const slugs = new Set(Array.from({ length: 10 }, () => generatePersonalSlug()));
    expect(slugs.size).toBeGreaterThan(1);
  });
});

describe("getTemplateForBusinessType", () => {
  it("maps salon to hair-salon", () => {
    expect(getTemplateForBusinessType("salon")).toBe("hair-salon");
  });

  it("maps fitness to fitness", () => {
    expect(getTemplateForBusinessType("fitness")).toBe("fitness");
  });

  it("returns general for unknown type", () => {
    expect(getTemplateForBusinessType("spaceship-repair")).toBe("general");
  });

  it("returns general for empty string", () => {
    expect(getTemplateForBusinessType("")).toBe("general");
  });

  it("handles mixed case", () => {
    expect(getTemplateForBusinessType("SALON")).toBe("hair-salon");
  });

  it("normalizes special chars", () => {
    expect(getTemplateForBusinessType("pet grooming")).toBe("pet-services");
  });

  it("maps all BUSINESS_TYPE_TEMPLATES entries", () => {
    for (const [input, expected] of Object.entries(BUSINESS_TYPE_TEMPLATES)) {
      expect(getTemplateForBusinessType(input)).toBe(expected);
    }
  });
});

describe("applyTemplatePlaceholders", () => {
  it("replaces {{key}} with values", () => {
    const result = applyTemplatePlaceholders("Hello {{name}}", { name: "World" });
    expect(result).toBe("Hello World");
  });

  it("replaces multiple occurrences", () => {
    const result = applyTemplatePlaceholders("{{x}} and {{x}}", { x: "foo" });
    expect(result).toBe("foo and foo");
  });

  it("replaces multiple different keys", () => {
    const result = applyTemplatePlaceholders("{{a}}-{{b}}", { a: "1", b: "2" });
    expect(result).toBe("1-2");
  });

  it("leaves unmatched placeholders intact", () => {
    const result = applyTemplatePlaceholders("{{known}} {{unknown}}", { known: "yes" });
    expect(result).toBe("yes {{unknown}}");
  });

  it("treats placeholder keys as literal strings", () => {
    const result = applyTemplatePlaceholders("{{a.b}} {{axb}}", { "a.b": "literal" });
    expect(result).toBe("literal {{axb}}");
  });

  it("handles empty vars object", () => {
    const result = applyTemplatePlaceholders("{{x}}", {});
    expect(result).toBe("{{x}}");
  });
});

describe("copyDirSync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copydir-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("copies files from source to destination", () => {
    const src = path.join(tmpDir, "src");
    const dest = path.join(tmpDir, "dest");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "a.txt"), "hello");
    fs.writeFileSync(path.join(src, "b.txt"), "world");

    copyDirSync(src, dest);

    expect(fs.readFileSync(path.join(dest, "a.txt"), "utf-8")).toBe("hello");
    expect(fs.readFileSync(path.join(dest, "b.txt"), "utf-8")).toBe("world");
  });

  it("copies nested directories", () => {
    const src = path.join(tmpDir, "src");
    fs.mkdirSync(path.join(src, "sub"), { recursive: true });
    fs.writeFileSync(path.join(src, "sub", "nested.txt"), "deep");
    const dest = path.join(tmpDir, "dest");

    copyDirSync(src, dest);

    expect(fs.readFileSync(path.join(dest, "sub", "nested.txt"), "utf-8")).toBe("deep");
  });

  it("skips node_modules", () => {
    const src = path.join(tmpDir, "src");
    fs.mkdirSync(path.join(src, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(src, "node_modules", "pkg.js"), "module");
    fs.writeFileSync(path.join(src, "app.js"), "app");
    const dest = path.join(tmpDir, "dest");

    copyDirSync(src, dest);

    expect(fs.existsSync(path.join(dest, "app.js"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "node_modules"))).toBe(false);
  });

  it("skips .git", () => {
    const src = path.join(tmpDir, "src");
    fs.mkdirSync(path.join(src, ".git"), { recursive: true });
    fs.writeFileSync(path.join(src, ".git", "HEAD"), "ref");
    fs.writeFileSync(path.join(src, "file.txt"), "content");
    const dest = path.join(tmpDir, "dest");

    copyDirSync(src, dest);

    expect(fs.existsSync(path.join(dest, "file.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dest, ".git"))).toBe(false);
  });
});
