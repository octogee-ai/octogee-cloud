import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomeFs } from "../../lib/vm-gateway-agent/home-fs.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), rename: vi.fn(), statfs: vi.fn() }));
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let root: string;
afterEach(async () => { if (root) { await rm(root, { recursive: true, force: true }); } vi.resetAllMocks(); });

it("reports the bytes an unprivileged writer can still use on the home disk, not the root reserve", async () => {
  vi.mocked(statfs).mockResolvedValue({ type: 0, bsize: 4096, blocks: 100, bfree: 7, bavail: 3, files: 10, ffree: 5 });
  expect(await createHomeFs("/srv/octogee").freeBytes("/srv/octogee")).toBe(3 * 4096);
  expect(statfs).toHaveBeenCalledWith("/srv/octogee");
});

it.each(["installation", "rollback", "concurrent-target"])("preserves newer local files when directory restore fails during %s", async (failure) => {
  root = await mkdtemp(join(tmpdir(), "home-restore-rollback-"));
  const source = join(root, "source"), target = join(root, "target");
  await mkdir(source); await mkdir(target);
  await writeFile(join(source, "file"), "old checkpoint");
  await writeFile(join(target, "file"), "newer local state");
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(from).endsWith("/stage")) {
      if (failure === "concurrent-target") { await mkdir(target); await writeFile(join(target, "concurrent"), "preserve concurrent work"); }
      throw new Error("injected installation failure");
    }
    if (failure === "rollback" && String(from).endsWith("/backup")) throw new Error("injected rollback failure");
    await actual.rename(from, to);
  });
  await expect(createHomeFs(root).replaceDirectory(source, target)).rejects.toThrow(failure === "installation" ? /installation failure/ : /backup retained/);
  const temporary = (await readdir(root)).filter(name => name.startsWith(".octogee-restore-"));
  if (failure === "installation") {
    expect(await readFile(join(target, "file"), "utf8")).toBe("newer local state");
    expect(temporary).toEqual([]);
  } else {
    expect(temporary).toHaveLength(1);
    expect(await readFile(join(root, temporary[0], "backup/file"), "utf8")).toBe("newer local state");
    if (failure === "concurrent-target") expect(await readFile(join(target, "concurrent"), "utf8")).toBe("preserve concurrent work");
  }
});
