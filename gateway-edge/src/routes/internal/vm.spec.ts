import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setGatewayTokenReviewerForTests } from "../../middleware/gateway-internal-auth.js";
import { createInternalVmRouter, resolveVmControlUrl } from "./vm.js";

let tokenDir: string | null = null;

function configureIsolatedGatewayAuth() {
  tokenDir = mkdtempSync(join(tmpdir(), "octogee-computer-auth-"));
  const tokenPath = join(tokenDir, "token");
  writeFileSync(tokenPath, "projected-token\n");
  delete process.env.INTERNAL_SERVICE_KEY;
  process.env.GATEWAY_CLASS = "isolated";
  process.env.GATEWAY_PROFILE = "isolated";
  process.env.GATEWAY_ID = "walter";
  process.env.K8S_NAMESPACE = "octogee-test";
  process.env.K8S_SERVICE_ACCOUNT_NAME = "octogee-gw-walter";
  process.env.OCTOGEE_API_SA_TOKEN_PATH = tokenPath;
  _setGatewayTokenReviewerForTests(vi.fn(async (jwt: string) =>
    jwt === "valid-ksa-token"
      ? { authenticated: true as const, namespace: "octogee-test", saName: "octogee-gw-walter", audiences: ["octogee-api"] }
      : { authenticated: false as const },
  ));
}

function app(controlUrl: string | null, fetchImpl: typeof fetch) {
  const a = express();
  a.use(express.json());
  a.use("/internal/computer", createInternalVmRouter({ controlUrl, fetchImpl }));
  return a;
}

function upstream(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("resolveVmControlUrl", () => {
  it("is null on a pod without a VM and a bare loopback origin on a VM", () => {
    expect(resolveVmControlUrl({})).toBeNull();
    expect(resolveVmControlUrl({ GATEWAY_COMPUTER_CONTROL_URL: " " })).toBeNull();
    expect(resolveVmControlUrl({ GATEWAY_COMPUTER_CONTROL_URL: "http://127.0.0.1:7777" })).toBe("http://127.0.0.1:7777");
    expect(resolveVmControlUrl({ GATEWAY_COMPUTER_CONTROL_URL: "http://127.0.0.1:7777/" })).toBe("http://127.0.0.1:7777");
  });

  it("refuses anything that is not a plain http loopback origin", () => {
    for (const bad of ["https://127.0.0.1:7777", "http://10.0.0.5:7777", "http://127.0.0.1:7777/desk", "http://127.0.0.1:7777?x=1", "not a url"]) {
      expect(() => resolveVmControlUrl({ GATEWAY_COMPUTER_CONTROL_URL: bad }), bad).toThrow();
    }
  });
});

describe("internal VM routes", () => {
  beforeEach(() => { configureIsolatedGatewayAuth(); });
  afterEach(() => {
    _setGatewayTokenReviewerForTests(null);
    for (const key of ["GATEWAY_CLASS", "GATEWAY_PROFILE", "GATEWAY_ID", "K8S_NAMESPACE", "K8S_SERVICE_ACCOUNT_NAME", "OCTOGEE_API_SA_TOKEN_PATH"]) delete process.env[key];
    if (tokenDir) rmSync(tokenDir, { recursive: true, force: true });
    tokenDir = null;
  });

  it("requires the gateway's own service-account identity before touching the desktop", async () => {
    const fetchImpl = upstream(200, { style: "familiar", accent: null });
    const a = app("http://127.0.0.1:7777", fetchImpl);
    expect((await request(a).post("/internal/computer/style").send({ style: "familiar" })).status).toBe(401);
    expect((await request(a).post("/internal/computer/desk/note").set("x-k8s-sa-token", "stolen").send({ note: "hi" })).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers computer_unavailable on a gateway without a VM", async () => {
    const fetchImpl = upstream(200, {});
    const res = await request(app(null, fetchImpl)).post("/internal/computer/style").set("x-k8s-sa-token", "valid-ksa-token").send({ style: "familiar" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "computer_unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards a validated style change to the control API and relays its answer", async () => {
    const fetchImpl = upstream(200, { style: "familiar", accent: "#0ea5e9" });
    const res = await request(app("http://127.0.0.1:7777", fetchImpl))
      .post("/internal/computer/style").set("x-k8s-sa-token", "valid-ksa-token").send({ style: "familiar", accent: "#0ea5e9", extra: "ignored" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ style: "familiar", accent: "#0ea5e9" });
    expect(res.headers["cache-control"]).toBe("no-store");
    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0];
    expect(url).toBe("http://127.0.0.1:7777/style");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ style: "familiar", accent: "#0ea5e9" });
  });

  it("forwards a validated note and relays an upstream rejection as is", async () => {
    const ok = upstream(200, { note: "Deploying." });
    const res = await request(app("http://127.0.0.1:7777", ok)).post("/internal/computer/desk/note").set("x-k8s-sa-token", "valid-ksa-token").send({ note: "  Deploying.  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ note: "Deploying." });
    const [, noteInit] = (ok as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0];
    expect(noteInit.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(noteInit.body))).toEqual({ note: "Deploying." });

    const rejected = upstream(500, { error: "octo-desktop-style failed" });
    const failed = await request(app("http://127.0.0.1:7777", rejected)).post("/internal/computer/style").set("x-k8s-sa-token", "valid-ksa-token").send({ style: "omarchy" });
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "octo-desktop-style failed" });
  });

  it("rejects malformed bodies before the control API sees them", async () => {
    const fetchImpl = upstream(200, {});
    const a = app("http://127.0.0.1:7777", fetchImpl);
    const cases: Array<[string, unknown]> = [
      ["/internal/computer/style", { style: "mac" }],
      ["/internal/computer/style", { style: "omarchy", accent: "#0ea5e9" }],
      ["/internal/computer/style", { style: "familiar", accent: "blue" }],
      ["/internal/computer/style", { style: "familiar", accent: "#0EA5E9" }],
      ["/internal/computer/style", []],
      ["/internal/computer/desk/note", { note: "" }],
      ["/internal/computer/desk/note", { note: "x".repeat(501) }],
      ["/internal/computer/desk/note", { note: 7 }],
      ["/internal/computer/desk/note", "text"],
    ];
    for (const [path, body] of cases) {
      const res = await request(a).post(path).set("x-k8s-sa-token", "valid-ksa-token").send(body as object);
      expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      expect(res.body.error, path).toMatch(/^invalid_/u);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers computer_unreachable when the desktop control API is down", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const res = await request(app("http://127.0.0.1:7777", fetchImpl)).post("/internal/computer/desk/note").set("x-k8s-sa-token", "valid-ksa-token").send({ note: "hi" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "computer_unreachable" });
  });
});
