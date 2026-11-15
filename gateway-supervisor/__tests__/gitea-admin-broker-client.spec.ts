import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { internalFetch } from "../lib/internal-fetch.js";
import { brokeredGitHost as broker } from "../lib/gitea-admin-broker-client.js";

vi.mock("../lib/internal-fetch.js", () => ({ internalFetch: vi.fn() }));

const mockFetch = vi.mocked(internalFetch);
const DEFAULT_BASE = "http://127.0.0.1:3001";

function reply(status: number, body: unknown = {}): Response {
  const noBody = status === 204;
  return new Response(noBody ? null : JSON.stringify(body), { status });
}

function lastCall(): { url: string; method: string; body: unknown } {
  const [url, init] = mockFetch.mock.calls.at(-1)!;
  return {
    url: String(url),
    method: (init?.method ?? "GET") as string,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  };
}

describe("brokeredGitHost → Gitea admin broker", () => {
  beforeEach(() => {
    delete process.env.GATEWAY_EDGE_INTERNAL_URL;
    delete process.env.GITEA_ADMIN_BROKER_URL;
    mockFetch.mockReset();
  });
  afterEach(() => {
    delete process.env.GATEWAY_EDGE_INTERNAL_URL;
    delete process.env.GITEA_ADMIN_BROKER_URL;
  });

  it("registerKey POSTs slug + pubKey to the local sidecar", async () => {
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.registerKey("acme", "ssh-ed25519 AAA");
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/ensure-user`,
      method: "POST",
      body: { slug: "acme", pubKey: "ssh-ed25519 AAA" },
    });
  });

  it("releaseKey POSTs the retiring pod's exact public key", async () => {
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.releaseKey("acme", "ssh-ed25519 OLD predecessor");
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/release-user-key`,
      method: "POST",
      body: { slug: "acme", pubKey: "ssh-ed25519 OLD predecessor" },
    });
  });

  it("fails loud when the sidecar returns a non-2xx (no silent success)", async () => {
    mockFetch.mockResolvedValueOnce(reply(502, { error: "gitea down" }));
    await expect(broker.registerKey("acme", "k")).rejects.toThrow(/502/);
  });

  it("listKeys GETs and returns every active pod key", async () => {
    mockFetch.mockResolvedValueOnce(reply(200, { pubKeys: ["ssh-ed25519 OLD", "ssh-ed25519 WANT"] }));
    expect(await broker.listKeys("acme")).toEqual([
      "ssh-ed25519 OLD",
      "ssh-ed25519 WANT",
    ]);
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/user-pubkeys?slug=acme`,
      method: "GET",
    });
  });

  it("listKeys passes through an empty list", async () => {
    mockFetch.mockResolvedValueOnce(reply(200, { pubKeys: [] }));
    expect(await broker.listKeys("acme")).toEqual([]);
  });

  it("ensureOwner POSTs slug", async () => {
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.ensureOwner("acme");
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/ensure-org`,
      method: "POST",
      body: { slug: "acme" },
    });
  });

  it("ensureRepo workspace POSTs slug to the workspace route", async () => {
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.ensureRepo("acme", { kind: "workspace" });
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/ensure-workspace-repo`,
      method: "POST",
      body: { slug: "acme" },
    });
  });

  it("ensureRepo system-config POSTs slug to the system config route", async () => {
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.ensureRepo("acme", { kind: "system-config" });
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/ensure-system-config-repo`,
      method: "POST",
      body: { slug: "acme" },
    });
  });

  it("ensureRepo project POSTs slug + projectName to the project route", async () => {
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.ensureRepo("acme", { kind: "project", projectSlug: "mygame" });
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/ensure-project-repo`,
      method: "POST",
      body: { slug: "acme", projectName: "mygame" },
    });
  });

  it("ensureRepo project-agents POSTs slug to the agent repo route", async () => {
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.ensureRepo("acme", { kind: "project-coaches" });
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/ensure-project-coach-repo`,
      method: "POST",
      body: { slug: "acme" },
    });
  });

  it("repoExists GETs and returns the boolean", async () => {
    mockFetch.mockResolvedValueOnce(reply(200, { exists: false }));
    expect(await broker.repoExists({ owner: "acme", repo: "workspace" })).toBe(false);
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/repo-exists?org=acme&repo=workspace`,
      method: "GET",
    });
  });

  it("archiveRepo POSTs org + repo", async () => {
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.archiveRepo({ owner: "acme", repo: "workspace" });
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/archive-repo`,
      method: "POST",
      body: { org: "acme", repo: "workspace" },
    });
  });

  it("honors GATEWAY_EDGE_INTERNAL_URL override", async () => {
    process.env.GATEWAY_EDGE_INTERNAL_URL = "http://localhost:9999";
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.ensureRepo("acme", { kind: "workspace" });
    expect(lastCall().url).toBe("http://localhost:9999/internal/gitea/ensure-workspace-repo");
  });

  it("prefers GITEA_ADMIN_BROKER_URL over the legacy local sidecar URL", async () => {
    process.env.GATEWAY_EDGE_INTERNAL_URL = "http://localhost:9999";
    process.env.GITEA_ADMIN_BROKER_URL = "http://octogee-api.shared-test.svc.cluster.local:3001";
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.ensureRepo("acme", { kind: "workspace" });
    expect(lastCall().url).toBe(
      "http://octogee-api.shared-test.svc.cluster.local:3001/internal/gitea/ensure-workspace-repo",
    );
  });
});
