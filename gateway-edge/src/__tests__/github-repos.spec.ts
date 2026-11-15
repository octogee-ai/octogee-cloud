import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  documents: new Map<string, Record<string, unknown>>(),
  readConnectorAccessToken: vi.fn(),
}));

vi.mock("@octogee/core/identity/platform-state-store", async (importOriginal) => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return {
    ...(await importOriginal<typeof import("@octogee/core/identity/platform-state-store")>()),
    platformStateStore: createDocumentFixtureStore(h.documents),
  };
});

vi.mock("@octogee/core/connectors/connector-tokens", () => ({
  readConnectorAccessToken: h.readConnectorAccessToken,
}));

const { platformStateStore } = await import("@octogee/core/identity/platform-state-store");
const { installBearerUids } = await import("./helpers/user-bearer.js");
const { createApp } = await import("../index.js");

const UID = "gh-repos-uid";
const AUTHORIZATION = `Bearer token-${UID}`;

installBearerUids(
  async (token) => {
    if (token !== `token-${UID}`) throw new Error("unknown bearer");
    return UID;
  },
  () => ({ accountLifecycle: { status: "active" } }),
);

async function seed(role: "user" | "admin"): Promise<void> {
  await platformStateStore.users.records.create({ uid: UID, createdAt: 1 });
  await platformStateStore.users.records.patch(UID, { role });
}

beforeEach(() => {
  h.documents.clear();
  h.readConnectorAccessToken.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Guards the canary against the mount it actually rides: the picker calls the
// cluster path /api/workspace/github/repos (octogee-api holds the Firestore
// credentials and the connector token authority; a gateway edge holds neither).
// A 403/422 here (not 404) proves the route is mounted; an unmounted route would
// 404 the picker.
describe("GET /workspace/github/repos — mounted + caller's own connection", () => {
  it("403s a non-admin (route reachable, not 404)", async () => {
    await seed("user");
    const r = await request(createApp())
      .get("/api/workspace/github/repos")
      .set("Authorization", AUTHORIZATION);
    expect(r.status, r.text).toBe(403);
  });

  it("422 github_not_connected for an admin without a github connection", async () => {
    await seed("admin");
    const r = await request(createApp())
      .get("/api/workspace/github/repos")
      .set("Authorization", AUTHORIZATION);
    expect(r.status, r.text).toBe(422);
    expect(r.body.reason).toBe("github_not_connected");
  });

  it("lists repos with the caller's own brokered token", async () => {
    await seed("admin");
    h.readConnectorAccessToken.mockResolvedValue("gho_callers_own_token");

    const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);
    let seenAuth: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      url: string | URL,
      init?: RequestInit,
    ) => {
      const u = String(url);
      if (u.includes("127.0.0.1") || u.includes("localhost")) return realFetch(u, init);
      expect(u).toContain("api.github.com/user/repos");
      seenAuth = ((init?.headers ?? {}) as Record<string, string>).Authorization;
      return new Response(
        JSON.stringify([
          {
            name: "octogee",
            full_name: "octogee-ai/octogee",
            private: true,
            description: "Eight arms. One dream.",
            updated_at: "2026-06-01T00:00:00Z",
            default_branch: "main",
            owner: { login: "octogee-ai" },
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch);

    const r = await request(createApp())
      .get("/api/workspace/github/repos")
      .set("Authorization", AUTHORIZATION);

    expect(r.status, r.text).toBe(200);
    expect(h.readConnectorAccessToken).toHaveBeenCalledWith(UID, "github");
    expect(seenAuth).toBe("Bearer gho_callers_own_token");
    expect(r.body.repos).toEqual([
      {
        owner: "octogee-ai",
        repo: "octogee",
        fullName: "octogee-ai/octogee",
        private: true,
        description: "Eight arms. One dream.",
        updatedAt: "2026-06-01T00:00:00Z",
        defaultBranch: "main",
      },
    ]);
  });
});
