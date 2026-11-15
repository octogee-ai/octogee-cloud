import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflareConnector } from "./cloudflare.js";
import { geminiConnector } from "./gemini.js";
import { netlifyConnector } from "./netlify.js";
import { npmConnector } from "./npm.js";
import { vercelConnector } from "./vercel.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("token connector identity probes", () => {
  it("verifies Cloudflare tokens and redacts the token id in the account label", async () => {
    fetchMock.mockResolvedValue(json({ success: true, result: { id: "token-abcdef", status: "active" } }));

    const identity = await cloudflareConnector.fetchIdentity("cf-token");
    expect(identity.accountLabel).toMatch(/^token .+abcdef$/);

    expect(fetchMock).toHaveBeenCalledWith("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { Authorization: "Bearer cf-token" },
    });
  });

  it("rejects inactive Cloudflare tokens and failed identity responses", async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, result: { status: "disabled" } }));
    await expect(cloudflareConnector.fetchIdentity("cf-token")).rejects.toThrow("Cloudflare token is not active: disabled");

    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 403 }));
    await expect(cloudflareConnector.fetchIdentity("cf-token")).rejects.toThrow("Cloudflare token verify failed: 403");
  });

  it("uses Netlify email first and falls back to full name", async () => {
    fetchMock.mockResolvedValueOnce(json({ email: "ada@example.test", full_name: "Ada" }));
    await expect(netlifyConnector.fetchIdentity("netlify-token")).resolves.toEqual({ accountLabel: "ada@example.test" });

    fetchMock.mockResolvedValueOnce(json({ full_name: "Ada Lovelace" }));
    await expect(netlifyConnector.fetchIdentity("netlify-token")).resolves.toEqual({ accountLabel: "Ada Lovelace" });
  });

  it("requires Netlify identity responses to identify an account", async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    await expect(netlifyConnector.fetchIdentity("netlify-token")).rejects.toThrow("Netlify identity response has no email or name");

    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 401 }));
    await expect(netlifyConnector.fetchIdentity("netlify-token")).rejects.toThrow("Netlify identity check failed: 401");
  });

  it("uses Vercel username first and falls back to email", async () => {
    fetchMock.mockResolvedValueOnce(json({ user: { username: "ada", email: "ada@example.test" } }));
    await expect(vercelConnector.fetchIdentity("vercel-token")).resolves.toEqual({ accountLabel: "ada" });

    fetchMock.mockResolvedValueOnce(json({ user: { email: "ada@example.test" } }));
    await expect(vercelConnector.fetchIdentity("vercel-token")).resolves.toEqual({ accountLabel: "ada@example.test" });
  });

  it("requires Vercel identity responses to identify an account", async () => {
    fetchMock.mockResolvedValueOnce(json({ user: {} }));
    await expect(vercelConnector.fetchIdentity("vercel-token")).rejects.toThrow("Vercel identity response has no username or email");

    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 500 }));
    await expect(vercelConnector.fetchIdentity("vercel-token")).rejects.toThrow("Vercel identity check failed: 500");
  });

  it("verifies Gemini keys by listing available models", async () => {
    fetchMock.mockResolvedValue(json({ models: [{ name: "models/gemini-pro" }] }));

    await expect(geminiConnector.fetchIdentity("gemini-key")).resolves.toEqual({ accountLabel: "AI Studio key" });
    expect(fetchMock).toHaveBeenCalledWith("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": "gemini-key" },
    });
  });

  it("rejects Gemini keys when the API returns no models or an error", async () => {
    fetchMock.mockResolvedValueOnce(json({ models: [] }));
    await expect(geminiConnector.fetchIdentity("gemini-key")).rejects.toThrow("Gemini key check returned no models");

    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 403 }));
    await expect(geminiConnector.fetchIdentity("gemini-key")).rejects.toThrow("Gemini key check failed: 403");
  });

  it("uses npm whoami to identify registry tokens", async () => {
    fetchMock.mockResolvedValue(json({ username: "octogee" }));

    await expect(npmConnector.fetchIdentity("npm-token")).resolves.toEqual({ accountLabel: "octogee" });
    expect(fetchMock).toHaveBeenCalledWith("https://registry.npmjs.org/-/whoami", {
      headers: { Authorization: "Bearer npm-token" },
    });
  });

  it("rejects npm tokens with failed or anonymous whoami responses", async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    await expect(npmConnector.fetchIdentity("npm-token")).rejects.toThrow("npm whoami returned no username");

    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 401 }));
    await expect(npmConnector.fetchIdentity("npm-token")).rejects.toThrow("npm identity check failed: 401");
  });
});
