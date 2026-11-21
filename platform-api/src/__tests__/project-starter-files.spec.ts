import { afterEach, describe, expect, it } from "vitest";
import {
  installProjectStarterFiles,
  isValidProjectStarter,
  PLATFORM_RECIPE_STARTER_FILES,
  PROJECT_STARTER_FILES_MAX_BYTES,
  PROJECT_STARTER_FILES_MAX_COUNT,
  projectStarterFilesProblem,
  requestProjectStarterFiles,
  type ProjectStarterFilesRequest,
} from "../lib/project-starter-files.js";

const REQUEST: ProjectStarterFilesRequest = {
  uid: "owner-1",
  workspaceId: "mira",
  projectSlug: "orbit",
  projectType: null,
  recipe: "vite-static",
  starter: "phone",
};

afterEach(() => {
  installProjectStarterFiles(PLATFORM_RECIPE_STARTER_FILES);
});

describe("projectStarterFilesProblem", () => {
  it("accepts nested relative paths, dotfiles and base64 content", () => {
    expect(projectStarterFilesProblem([
      { path: ".gitignore", content: "node_modules/\n" },
      { path: "src/services/config.ts", content: "export {};\n" },
      { path: "assets/icon.png", content: "iVBORw0KGgo=", encoding: "base64" },
    ])).toBeNull();
  });

  it.each([
    ["an absolute path", "/etc/passwd", /relative/],
    ["a parent segment", "src/../../escape", /'\.\.'/],
    ["a current-directory segment", "./package.json", /'\.'/],
    ["an empty segment", "src//main.ts", /relative/],
    ["a trailing slash", "src/", /relative/],
    ["a .git directory", ".git/hooks/pre-commit", /\.git/],
    ["a nested .git directory", "vendor/.GIT/config", /\.git/],
    ["a backslash", "src\\main.ts", /relative/],
    ["a space", "my file.txt", /relative/],
    ["a newline", "a\nb", /relative/],
    ["an overlong path", `${"a/".repeat(150)}b`, /1-200/],
  ])("refuses %s", (_case, path, message) => {
    expect(projectStarterFilesProblem([{ path, content: "x" }])).toMatch(message);
  });

  it("refuses a file listed twice", () => {
    expect(projectStarterFilesProblem([
      { path: "a.txt", content: "x" },
      { path: "a.txt", content: "y" },
    ])).toMatch(/listed twice/);
  });

  it("refuses unknown fields, non-text content and an unknown encoding", () => {
    expect(projectStarterFilesProblem([{ path: "a.txt", content: "x", mode: "755" }])).toMatch(/unknown field mode/);
    expect(projectStarterFilesProblem([{ path: "a.txt", content: 1 }])).toMatch(/content must be text/);
    expect(projectStarterFilesProblem([{ path: "a.txt", content: "x", encoding: "hex" }])).toMatch(/encoding/);
    expect(projectStarterFilesProblem([{ path: "a.bin", content: "not base64!", encoding: "base64" }]))
      .toMatch(/not base64/);
  });

  it("caps the number of files", () => {
    const files = Array.from({ length: PROJECT_STARTER_FILES_MAX_COUNT + 1 }, (_, index) => ({
      path: `f${index}.txt`,
      content: "x",
    }));

    expect(projectStarterFilesProblem(files.slice(0, PROJECT_STARTER_FILES_MAX_COUNT))).toBeNull();
    expect(projectStarterFilesProblem(files)).toMatch(/at most 200/);
  });

  it("caps the total decoded bytes", () => {
    const half = "x".repeat(PROJECT_STARTER_FILES_MAX_BYTES / 2);

    expect(projectStarterFilesProblem([{ path: "a.txt", content: half }, { path: "b.txt", content: half }])).toBeNull();
    expect(projectStarterFilesProblem([
      { path: "a.txt", content: half },
      { path: "b.txt", content: `${half}x` },
    ])).toMatch(/total at most/);
  });

  it("refuses anything that is not a list", () => {
    expect(projectStarterFilesProblem({ path: "a.txt", content: "x" })).toMatch(/must be a list/);
    expect(projectStarterFilesProblem([null])).toMatch(/must be an object/);
  });
});

describe("isValidProjectStarter", () => {
  it("accepts a short lowercase name and refuses anything else", () => {
    expect(isValidProjectStarter("phone")).toBe(true);
    expect(isValidProjectStarter("web-2")).toBe(true);
    expect(isValidProjectStarter("")).toBe(false);
    expect(isValidProjectStarter("-x")).toBe(false);
    expect(isValidProjectStarter("Phone")).toBe(false);
    expect(isValidProjectStarter("../x")).toBe(false);
    expect(isValidProjectStarter("a".repeat(65))).toBe(false);
    expect(isValidProjectStarter(3)).toBe(false);
  });
});

describe("requestProjectStarterFiles", () => {
  it("leaves the platform recipe seed in place without a product provider", async () => {
    await expect(requestProjectStarterFiles(REQUEST)).resolves.toEqual({ ok: true, files: null });
  });

  it("returns the product's files for the request", async () => {
    const files = [{ path: "package.json", content: "{}\n" }];
    const requests: ProjectStarterFilesRequest[] = [];
    installProjectStarterFiles(async (request) => {
      requests.push(request);
      return files;
    });

    await expect(requestProjectStarterFiles(REQUEST)).resolves.toEqual({ ok: true, files });
    expect(requests).toEqual([REQUEST]);
  });

  it("reports a provider that throws", async () => {
    installProjectStarterFiles(async () => {
      throw new Error("templates missing");
    });

    await expect(requestProjectStarterFiles(REQUEST)).resolves.toEqual({
      ok: false,
      error: "starter files could not be prepared: templates missing",
    });
  });

  it("reports provider files that break the path rules", async () => {
    installProjectStarterFiles(async () => [{ path: "../escape", content: "x" }]);

    await expect(requestProjectStarterFiles(REQUEST)).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/^starter files are invalid: starter file \.\.\/escape/),
    });
  });
});
