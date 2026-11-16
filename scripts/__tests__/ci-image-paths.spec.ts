import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesystemPaths } from "../ci/image-paths.mjs";

describe("image snapshot inventory", () => {
  it("lists hidden files and links literally without following directory aliases, cycles or links outside the image", () => {
    const directory = mkdtempSync(join(tmpdir(), "image-inventory-"));
    const root = join(directory, "image");
    try {
      mkdirSync(join(root, "app"), { recursive: true });
      writeFileSync(join(root, "app/main.js"), "source");
      writeFileSync(join(root, ".hidden\nfile"), "hidden");
      mkdirSync(join(directory, "outside"));
      writeFileSync(join(directory, "outside/private.js"), "outside");
      symlinkSync("app", join(root, "alias"));
      symlinkSync("..", join(root, "app/cycle"));
      symlinkSync(join(directory, "outside"), join(root, "outside"));
      symlinkSync("missing", join(root, "dangling"));
      expect(filesystemPaths(root)).toEqual([".hidden\nfile", "alias", "app/cycle", "app/main.js", "dangling", "outside"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
