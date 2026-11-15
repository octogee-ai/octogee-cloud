import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EDGE_URL,
  DEFAULT_TOKEN_PATH,
  OCTO_DESK_USAGE,
  OCTO_DESKTOP_STYLE_USAGE,
  parseOctoDeskArgs,
  parseOctoDesktopStyleArgs,
  runDeskCli,
} from "../lib/desk-control.js";

function io(answer: { status: number; body: unknown } | Error, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const fetchImpl = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const readFile = vi.fn(async (path: string) => {
    if (path !== (env.OCTOGEE_API_SA_TOKEN_PATH ?? DEFAULT_TOKEN_PATH)) throw new Error(`ENOENT: ${path}`);
    return "gateway-token\n";
  });
  return {
    opts: { env, fetchImpl, readFile, stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) },
    out, err, fetchImpl,
    call: () => (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0],
  };
}

describe("octo-desk and octo-desktop-style argument parsing", () => {
  it("accepts exactly one note or one style", () => {
    expect(parseOctoDeskArgs(["note", "  Deploying the site.  "])).toEqual({ path: "/desk/note", body: { note: "Deploying the site." } });
    expect(parseOctoDesktopStyleArgs(["familiar"])).toEqual({ path: "/style", body: { style: "familiar" } });
    expect(parseOctoDesktopStyleArgs(["omarchy"])).toEqual({ path: "/style", body: { style: "omarchy" } });
  });

  it("refuses anything else with the usage line", () => {
    for (const args of [[], ["note"], ["note", ""], ["note", "   "], ["note", "a", "b"], ["say", "hi"], ["note", "x".repeat(501)]]) {
      expect(() => parseOctoDeskArgs(args), JSON.stringify(args)).toThrow(OCTO_DESK_USAGE);
    }
    for (const args of [[], ["mac"], ["familiar", "--accent", "#0ea5e9"], ["familiar", "omarchy"], ["status"]]) {
      expect(() => parseOctoDesktopStyleArgs(args), JSON.stringify(args)).toThrow(OCTO_DESKTOP_STYLE_USAGE);
    }
  });
});

describe("runDeskCli", () => {
  it("posts to the in-pod gateway-edge VM route with the gateway's own credential", async () => {
    const h = io({ status: 200, body: { note: "Deploying." } });
    await expect(runDeskCli("octo-desk", ["note", "Deploying."], h.opts)).resolves.toBe(0);
    const [url, init] = h.call();
    expect(url).toBe(`${DEFAULT_EDGE_URL}/internal/computer/desk/note`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", "x-k8s-sa-token": "gateway-token" });
    expect(JSON.parse(String(init.body))).toEqual({ note: "Deploying." });
    expect(h.out).toEqual(["Desk note updated."]);
    expect(h.err).toEqual([]);
  });

  it("honours the platform's edge URL and token path and reports the applied style", async () => {
    const env = { GATEWAY_EDGE_INTERNAL_URL: "http://localhost:3002/", OCTOGEE_API_SA_TOKEN_PATH: "/run/tok" };
    const h = io({ status: 200, body: { style: "omarchy", accent: null } }, env);
    await expect(runDeskCli("octo-desktop-style", ["omarchy"], h.opts)).resolves.toBe(0);
    expect(h.call()[0]).toBe("http://localhost:3002/internal/computer/style");
    expect(h.out).toEqual(["Desktop style set to omarchy."]);
  });

  it("exits 2 with usage on bad arguments without calling anything", async () => {
    const h = io({ status: 200, body: {} });
    await expect(runDeskCli("octo-desk", ["note"], h.opts)).resolves.toBe(2);
    expect(h.err).toEqual([OCTO_DESK_USAGE]);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("explains a workspace without a VM, relays control API errors, and names a dead edge", async () => {
    const none = io({ status: 404, body: { error: "computer_unavailable" } });
    await expect(runDeskCli("octo-desk", ["note", "hi"], none.opts)).resolves.toBe(1);
    expect(none.err).toEqual(["This workspace has no VM, so there is no Desk to change."]);

    const refused = io({ status: 500, body: { error: "octo-desktop-style: could not update shell.json" } });
    await expect(runDeskCli("octo-desktop-style", ["familiar"], refused.opts)).resolves.toBe(1);
    expect(refused.err).toEqual(["octo-desktop-style failed (HTTP 500): octo-desktop-style: could not update shell.json"]);

    const dead = io(new Error("ECONNREFUSED"));
    await expect(runDeskCli("octo-desk", ["note", "hi"], dead.opts)).resolves.toBe(1);
    expect(dead.err).toEqual(["octo-desk could not reach this gateway's edge at http://127.0.0.1:3001: ECONNREFUSED"]);

    const noToken = io({ status: 200, body: {} }, { OCTOGEE_API_SA_TOKEN_PATH: "/missing" });
    noToken.opts.readFile = vi.fn(async () => { throw new Error("ENOENT: /missing"); });
    await expect(runDeskCli("octo-desk", ["note", "hi"], noToken.opts)).resolves.toBe(1);
    expect(noToken.err).toEqual(["octo-desk could not read this gateway's credential at /missing: ENOENT: /missing"]);
  });
});
