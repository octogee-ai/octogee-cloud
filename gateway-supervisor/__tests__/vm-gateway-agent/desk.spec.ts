import { describe, expect, it, vi } from "vitest";
import { characterSvg } from "@octogee/shared/types/agent-characters";
import { fetchDesk, syncDesk, type DeskDeps } from "../../lib/vm-gateway-agent/desk";
import type { HomeScope } from "../../lib/vm-gateway-agent/home-checkpoint";

const SCOPE: HomeScope = {
  slug: "bob",
  dataDir: "/srv/octogee/volumes/data",
  marker: "/srv/octogee/home-checkpoint.marker",
  desktopDir: "/srv/octogee/desktop-home",
  restorePending: "/srv/octogee/home-restore.pending",
  hostToolInventory: true,
};
const DESK_JSON = "/srv/octogee/desktop-home/.config/octogee/desk.json";
const DESK_SVG = "/srv/octogee/desktop-home/.config/octogee/desk.svg";
const STYLE_FILE = "/srv/octogee/desktop-home/.config/omarchy/octogee-desktop-style";
const THEME_FILE = "/srv/octogee/desktop-home/.local/state/omarchy/current/theme.name";
const COLORS_FILE = "/srv/octogee/desktop-home/.config/omarchy/themes/octogee/colors.toml";
const OCEAN = { style: "kit", color: "#0ea5e9" } as const;
const CORAL = { style: "octo", color: "#e74e3c" } as const;

type Route = (init: RequestInit) => { status: number; body: unknown };

function fake(files: Record<string, string> = {}, routes: Record<string, Route> = {}) {
  const store = new Map(Object.entries(files));
  const written: Array<{ path: string; mode: number }> = [];
  const chowns: string[] = [];
  const dirs: string[] = [];
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    fetches.push({ url: String(url), init: init ?? {} });
    const route = routes[String(url).replace(/^https?:\/\/[^/]+/, "")];
    if (!route) return new Response("", { status: 200 });
    const r = route(init ?? {});
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const deps: DeskDeps = {
    gatewayId: "b-x",
    apiUrl: "http://10.128.9.9:3001",
    metadata: { identityToken: async (aud) => `id-${aud}` },
    fetchImpl,
    fs: {
      readFile: async (path) => store.get(path) ?? null,
      writeFile: async (path, content, mode) => { store.set(path, content); written.push({ path, mode }); },
      mkdir: async (path) => { dirs.push(path); },
      chown: async (path) => { chowns.push(path); },
    },
    log: vi.fn(),
  };
  return { deps, store, written, chowns, dirs, fetches, routes, log: deps.log as ReturnType<typeof vi.fn> };
}

const desk = (look: { style: string; color: string } = OCEAN, timeZone: string | null = null) => ({ builderName: "Bob Builder", agentName: "Scout", look, timeZone });

describe("fetchDesk", () => {
  it("asks the broker for the configured user bootstrap and returns its desk identity", async () => {
    const h = fake({}, { "/internal/fleet/configured-builder-bootstrap": () => ({ status: 200, body: { bootstrap: { coachToken: "x", desk: desk() } } }) });
    await expect(fetchDesk(h.deps, "bob")).resolves.toEqual(desk());
    const [{ url, init }] = h.fetches;
    expect(url).toBe("http://10.128.9.9:3001/internal/fleet/configured-builder-bootstrap");
    expect(JSON.parse(String(init.body))).toEqual({ gatewayId: "b-x", slug: "bob", revisionId: "b-x" });
    expect(init.headers).toMatchObject({ "x-k8s-sa-token": "id-octogee-api", "x-octogee-gateway-credential-token": "id-octogee-api-gateway-credentials" });
  });

  it("returns null while the user is not configured yet, and refuses a payload without a valid desk", async () => {
    const absent = fake({}, { "/internal/fleet/configured-builder-bootstrap": () => ({ status: 404, body: { error: "configured_builder_bootstrap_unavailable" } }) });
    await expect(fetchDesk(absent.deps, "bob")).resolves.toBeNull();
    const malformed = fake({}, { "/internal/fleet/configured-builder-bootstrap": () => ({ status: 200, body: { bootstrap: { desk: { builderName: "Bob", agentName: "S", look: { style: "dragon", color: "red" } } } } }) });
    await expect(fetchDesk(malformed.deps, "bob")).rejects.toThrow(/desk identity/);
    const badZone = fake({}, { "/internal/fleet/configured-builder-bootstrap": () => ({ status: 200, body: { bootstrap: { desk: desk(OCEAN, "../etc") } } }) });
    await expect(fetchDesk(badZone.deps, "bob")).rejects.toThrow(/desk identity/);
    const failed = fake({}, { "/internal/fleet/configured-builder-bootstrap": () => ({ status: 500, body: { error: "boom" } }) });
    await expect(fetchDesk(failed.deps, "bob")).rejects.toThrow(/HTTP 500/);
  });
});

describe("syncDesk", () => {
  it("writes desk.json and the character drawing into the user's home on first sight", async () => {
    const h = fake();
    await expect(syncDesk(h.deps, SCOPE, desk())).resolves.toEqual({ written: true });
    expect(JSON.parse(h.store.get(DESK_JSON)!)).toEqual({ builderName: "Bob Builder", agentName: "Scout", look: OCEAN, timeZone: null });
    expect(h.store.get(DESK_SVG)).toBe(characterSvg(OCEAN));
    expect(h.dirs).toEqual(["/srv/octogee/desktop-home/.config/octogee"]);
    expect(h.chowns).toEqual(["/srv/octogee/desktop-home/.config/octogee", DESK_JSON, DESK_SVG]);
    expect(h.written.map((w) => w.mode)).toEqual([0o644, 0o644]);
    expect(h.fetches).toEqual([]);
  });

  it("keeps the stored note, rewrites nothing while the identity is unchanged, and refreshes a missing drawing", async () => {
    const h = fake({ [DESK_JSON]: JSON.stringify({ builderName: "Bob Builder", agentName: "Scout", look: OCEAN, note: "Back at 3.", timeZone: null }), [DESK_SVG]: "<svg/>" });
    await expect(syncDesk(h.deps, SCOPE, desk())).resolves.toEqual({ written: false });
    expect(h.written).toEqual([]);
    h.store.delete(DESK_SVG);
    await expect(syncDesk(h.deps, SCOPE, desk())).resolves.toEqual({ written: true });
    expect(JSON.parse(h.store.get(DESK_JSON)!)).toEqual({ builderName: "Bob Builder", agentName: "Scout", look: OCEAN, note: "Back at 3.", timeZone: null });
    expect(h.store.get(DESK_SVG)).toBe(characterSvg(OCEAN));
  });

  it("keeps a note the control API wrote before the identity arrived", async () => {
    const h = fake({ [DESK_JSON]: JSON.stringify({ note: "Hello" }) });
    await syncDesk(h.deps, SCOPE, desk());
    expect(JSON.parse(h.store.get(DESK_JSON)!)).toEqual({ builderName: "Bob Builder", agentName: "Scout", look: OCEAN, note: "Hello", timeZone: null });
  });

  it("re-accents the octogee theme on a look change only while the recorded style is Familiar and the theme is still octogee", async () => {
    const familiar = { [STYLE_FILE]: "familiar\n", [THEME_FILE]: "octogee\n", [COLORS_FILE]: 'mode = "light"\naccent = "#e74e3c"\n' };
    const h = fake({ ...familiar, [DESK_JSON]: JSON.stringify(desk(CORAL)), [DESK_SVG]: "<svg/>" }, { "/style": () => ({ status: 200, body: { style: "familiar", accent: "#0ea5e9" } }) });
    await syncDesk(h.deps, SCOPE, desk());
    expect(h.fetches).toHaveLength(1);
    expect(h.fetches[0].url).toBe("http://127.0.0.1:7777/style");
    expect(h.fetches[0].init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(h.fetches[0].init.body))).toEqual({ style: "familiar", accent: "#0ea5e9" });
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("accent refreshed to #0ea5e9"));

    for (const [label, files] of [
      ["stock Omarchy recorded", { ...familiar, [STYLE_FILE]: "omarchy\n" }],
      ["a theme the user picked", { ...familiar, [THEME_FILE]: "nord\n" }],
      ["no recorded style", { [THEME_FILE]: "octogee\n" }],
    ] as const) {
      const quiet = fake({ ...files, [DESK_JSON]: JSON.stringify(desk(CORAL)), [DESK_SVG]: "<svg/>" });
      await syncDesk(quiet.deps, SCOPE, desk());
      expect(quiet.fetches, label).toEqual([]);
      expect(quiet.log, label).toHaveBeenCalledWith(expect.stringContaining("accent left alone"));
    }
  });

  it("does not touch the theme when its accent already matches the look, and surfaces a failed accent refresh", async () => {
    const files = { [STYLE_FILE]: "familiar\n", [THEME_FILE]: "octogee\n", [DESK_JSON]: JSON.stringify(desk(CORAL)), [DESK_SVG]: "<svg/>" };
    const matching = fake({ ...files, [COLORS_FILE]: 'accent = "#0ea5e9"\n' });
    await syncDesk(matching.deps, SCOPE, desk());
    expect(matching.fetches).toEqual([]);

    const failing = fake({ ...files, [COLORS_FILE]: 'accent = "#e74e3c"\n' }, { "/style": () => ({ status: 500, body: { error: "octo-desktop-style failed" } }) });
    await expect(syncDesk(failing.deps, SCOPE, desk())).rejects.toThrow(/accent refresh: HTTP 500.*octo-desktop-style failed/);
    expect(JSON.parse(failing.store.get(DESK_JSON)!).look).toEqual(OCEAN);
  });
  it("retries a transient accent refresh failure on the next converge even though desk.json is already current", async () => {
    const files = { [STYLE_FILE]: "familiar\n", [THEME_FILE]: "octogee\n", [COLORS_FILE]: 'accent = "#e74e3c"\n', [DESK_JSON]: JSON.stringify(desk(CORAL)), [DESK_SVG]: "<svg/>" };
    let styleStatus = 500;
    const h = fake(files, { "/style": () => ({ status: styleStatus, body: styleStatus === 200 ? { style: "familiar", accent: "#0ea5e9" } : { error: "busy" } }) });
    await expect(syncDesk(h.deps, SCOPE, desk())).rejects.toThrow(/accent refresh: HTTP 500/);
    expect(h.written).toHaveLength(2);
    styleStatus = 200;
    await expect(syncDesk(h.deps, SCOPE, desk())).resolves.toEqual({ written: false });
    expect(h.fetches.map((f) => f.url)).toEqual(["http://127.0.0.1:7777/style", "http://127.0.0.1:7777/style"]);
    expect(h.written).toHaveLength(2);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("accent refreshed to #0ea5e9"));
  });

  it("sets the VM's system time zone from the user's zone, idempotently, and surfaces failures", async () => {
    let installed = "Etc/UTC";
    const timezone: Route = (init) => {
      if (init.method === "POST") { installed = (JSON.parse(String(init.body)) as { timeZone: string }).timeZone; return { status: 200, body: { timeZone: installed } }; }
      return { status: 200, body: { timeZone: installed } };
    };
    const h = fake({}, { "/timezone": timezone });
    await syncDesk(h.deps, SCOPE, desk(OCEAN, "America/Chicago"));
    expect(JSON.parse(h.store.get(DESK_JSON)!).timeZone).toBe("America/Chicago");
    expect(h.fetches.map((f) => `${f.init.method} ${f.url}`)).toEqual(["GET http://127.0.0.1:7777/timezone", "POST http://127.0.0.1:7777/timezone"]);
    expect(h.fetches[1].init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(h.fetches[1].init.body))).toEqual({ timeZone: "America/Chicago" });
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("VM time zone set to America/Chicago (was Etc/UTC)"));

    await syncDesk(h.deps, SCOPE, desk(OCEAN, "America/Chicago"));
    expect(h.fetches).toHaveLength(3);
    expect(h.fetches[2].init.method).toBe("GET");

    const noZone = fake();
    await syncDesk(noZone.deps, SCOPE, desk(OCEAN, null));
    expect(noZone.fetches).toEqual([]);

    const failing = fake({}, { "/timezone": (init) => (init.method === "POST" ? { status: 500, body: { error: "timedatectl failed" } } : { status: 200, body: { timeZone: "Etc/UTC" } }) });
    await expect(syncDesk(failing.deps, SCOPE, desk(OCEAN, "America/Chicago"))).rejects.toThrow(/time zone set: HTTP 500.*timedatectl failed/);
  });

  it("rewrites desk.json when only the time zone changed", async () => {
    const h = fake({ [DESK_JSON]: JSON.stringify({ ...desk(OCEAN, "Etc/UTC"), note: "Hi" }), [DESK_SVG]: "<svg/>" }, { "/timezone": () => ({ status: 200, body: { timeZone: "Europe/Berlin" } }) });
    await expect(syncDesk(h.deps, SCOPE, desk(OCEAN, "Europe/Berlin"))).resolves.toEqual({ written: true });
    expect(JSON.parse(h.store.get(DESK_JSON)!)).toEqual({ ...desk(OCEAN, "Europe/Berlin"), note: "Hi" });
  });
});
