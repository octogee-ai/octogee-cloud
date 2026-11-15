import { describe, expect, it } from "vitest";
import { characterSvg } from "@octogee/shared/types/agent-characters";
import { MalformedDeskFileError, parseDeskIdentity, writeDeskIdentity, type DeskIdentityFs } from "../lib/desk-identity.js";

const OCEAN = { style: "kit", color: "#0ea5e9" } as const;
const DESK = { builderName: "Bob Builder", agentName: "Scout", look: OCEAN, timeZone: "America/Chicago" };
const JSON_PATH = "/home/octo/.config/octogee/desk.json";
const SVG_PATH = "/home/octo/.config/octogee/desk.svg";

function fakeFs(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files));
  const written: Array<{ path: string; mode: number }> = [];
  const dirs: string[] = [];
  const renames: Array<[string, string]> = [];
  const fs: DeskIdentityFs = {
    readFile: async (path) => store.get(path) ?? null,
    writeFile: async (path, content, mode) => { store.set(path, content); written.push({ path, mode }); },
    mkdir: async (path) => { dirs.push(path); },
    rename: async (from, to) => { store.set(to, store.get(from)!); store.delete(from); renames.push([from, to]); },
  };
  return { fs, store, written, dirs, renames };
}

describe("parseDeskIdentity", () => {
  it("accepts the broker's desk shape and rejects an unknown look or time zone", () => {
    expect(parseDeskIdentity(DESK)).toEqual(DESK);
    expect(parseDeskIdentity({ ...DESK, timeZone: undefined })).toEqual({ ...DESK, timeZone: null });
    expect(parseDeskIdentity({ ...DESK, look: { style: "dragon", color: "red" } })).toBeNull();
    expect(parseDeskIdentity({ ...DESK, timeZone: "../etc" })).toBeNull();
    expect(parseDeskIdentity({ ...DESK, builderName: 7 })).toBeNull();
    expect(parseDeskIdentity(null)).toBeNull();
  });
});

describe("writeDeskIdentity", () => {
  it("writes desk.json and the character drawing under the desktop home through pending files renamed into place", async () => {
    const h = fakeFs();
    await expect(writeDeskIdentity(h.fs, "/home/octo", DESK, () => 7)).resolves.toEqual({ written: true });
    expect(h.dirs).toEqual(["/home/octo/.config/octogee"]);
    expect(JSON.parse(h.store.get(JSON_PATH)!)).toEqual(DESK);
    expect(h.store.get(SVG_PATH)).toBe(characterSvg(OCEAN));
    expect(h.written).toEqual([{ path: `${JSON_PATH}.7.pending`, mode: 0o644 }, { path: `${SVG_PATH}.7.pending`, mode: 0o644 }]);
    expect(h.renames).toEqual([[`${JSON_PATH}.7.pending`, JSON_PATH], [`${SVG_PATH}.7.pending`, SVG_PATH]]);
    expect([...h.store.keys()].sort()).toEqual([JSON_PATH, SVG_PATH]);
  });

  it("keeps the user's note, leaves an unchanged identity alone, and repairs a missing or stale drawing", async () => {
    const h = fakeFs({ [JSON_PATH]: JSON.stringify({ ...DESK, note: "Back at 3." }), [SVG_PATH]: characterSvg(OCEAN) });
    await expect(writeDeskIdentity(h.fs, "/home/octo", DESK)).resolves.toEqual({ written: false });
    expect(h.written).toEqual([]);
    h.store.delete(SVG_PATH);
    await expect(writeDeskIdentity(h.fs, "/home/octo", DESK)).resolves.toEqual({ written: true });
    expect(JSON.parse(h.store.get(JSON_PATH)!)).toEqual({ ...DESK, note: "Back at 3." });
    expect(h.store.get(SVG_PATH)).toBe(characterSvg(OCEAN));
    h.store.set(SVG_PATH, characterSvg({ style: "octo", color: "#e74e3c" }));
    await expect(writeDeskIdentity(h.fs, "/home/octo", DESK)).resolves.toEqual({ written: true });
    expect(h.store.get(SVG_PATH)).toBe(characterSvg(OCEAN));
  });

  it("moves a malformed desk.json aside and reports it instead of overwriting the stored note", async () => {
    for (const malformed of ['{"note": "Back at', "[1, 2]", "null"]) {
      const h = fakeFs({ [JSON_PATH]: malformed });
      const error = await writeDeskIdentity(h.fs, "/home/octo", DESK, () => 1700000000000).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MalformedDeskFileError);
      expect(h.renames).toEqual([[JSON_PATH, `${JSON_PATH}.malformed-1700000000000`]]);
      expect(h.store.get(`${JSON_PATH}.malformed-1700000000000`)).toBe(malformed);
      expect(h.store.has(JSON_PATH)).toBe(false);
      expect(h.written).toEqual([]);
    }
  });

  it("replaces the identity when the look changes but keeps a note written before it arrived", async () => {
    const h = fakeFs({ [JSON_PATH]: JSON.stringify({ note: "Hello" }) });
    await writeDeskIdentity(h.fs, "/home/octo", DESK);
    expect(JSON.parse(h.store.get(JSON_PATH)!)).toEqual({ ...DESK, note: "Hello" });
    const coral = { ...DESK, look: { style: "octo", color: "#e74e3c" } as const };
    await expect(writeDeskIdentity(h.fs, "/home/octo", coral)).resolves.toEqual({ written: true });
    expect(h.store.get(SVG_PATH)).toBe(characterSvg(coral.look));
  });
});
