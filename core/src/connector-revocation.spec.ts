import { describe, expect, it, vi } from "vitest";

import {
  revokeAllConnectorGrantsForUser,
  revokeProviderGrant,
  type ConnectorRevocationDeps,
  type ConnectorRevocationTarget,
} from "./connector-revocation.js";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";

const google: ConnectorRevocationTarget = {
  connectorId: "google",
  revocationUrl: "https://oauth2.googleapis.com/revoke",
};

function depsFor(
  secrets: Record<string, unknown>,
  fetchImpl: NonNullable<ConnectorRevocationDeps["fetchImpl"]>,
) {
  const warnings: string[] = [];
  return {
    warnings,
    secrets: createDocumentFixtureStore(Object.fromEntries(Object.entries(secrets).map(([key, row]) => {
      const [uid, connectorId] = key.split("/");
      return [`users/${uid}/secrets/${connectorId}`, row as Record<string, unknown>];
    }))).secrets,
    decryptSecret: async (ciphertext: string) => ciphertext.replace("enc:", "plain:"),
    logger: { warn: (message: string) => warnings.push(message) },
    fetchImpl,
  } satisfies ConnectorRevocationDeps & { warnings: string[] };
}

describe("revokeProviderGrant", () => {
  it("revokes one refresh token and does not make a second request with the access token", async () => {
    const posted: string[] = [];
    const deps = depsFor(
      {
        "u1/google": {
          tokens: {
            encryptedRefreshToken: "enc:refresh",
            encryptedAccessToken: "enc:access",
          },
        },
      },
      vi.fn(async (_url, init) => {
        posted.push(new URLSearchParams(init?.body as string).get("token") ?? "");
        return { ok: true, status: 200 } as Response;
      }),
    );

    await revokeProviderGrant("u1", google, deps);

    expect(posted).toEqual(["plain:refresh"]);
    expect(deps.warnings).toEqual([]);
  });

  it("falls back to the access token when no refresh token is stored", async () => {
    const posted: string[] = [];
    const deps = depsFor(
      { "u1/google": { tokens: { encryptedAccessToken: "enc:access" } } },
      vi.fn(async (_url, init) => {
        posted.push(new URLSearchParams(init?.body as string).get("token") ?? "");
        return { ok: true, status: 200 } as Response;
      }),
    );

    await revokeProviderGrant("u1", google, deps);

    expect(posted).toEqual(["plain:access"]);
  });

  it("adds a deadline to the provider request", async () => {
    let signal: AbortSignal | null | undefined;
    const deps = depsFor(
      { "u1/google": { tokens: { encryptedRefreshToken: "enc:refresh" } } },
      vi.fn(async (_url, init) => {
        signal = init?.signal;
        return { ok: true, status: 200 } as Response;
      }),
    );

    await revokeProviderGrant("u1", google, deps);

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("logs and resolves when reading the stored grant fails", async () => {
    const warnings: string[] = [];
    const deps = {
      secrets: { get: async () => { throw new Error("firestore unavailable"); } },
      decryptSecret: vi.fn(async () => "plain"),
      logger: { warn: (message: string) => warnings.push(message) },
      fetchImpl: vi.fn(async () => ({ ok: true, status: 200 }) as Response),
    } satisfies ConnectorRevocationDeps;

    await expect(revokeProviderGrant("u1", google, deps)).resolves.toBeUndefined();

    expect(warnings.join(" ")).toContain("firestore unavailable");
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to revoke with a malformed stored grant and logs why", async () => {
    const deps = depsFor(
      { "u1/google": { tokens: { encryptedRefreshToken: 42, encryptedAccessToken: "enc:access" } } },
      vi.fn(async () => ({ ok: true, status: 200 }) as Response),
    );

    await expect(revokeProviderGrant("u1", google, deps)).resolves.toBeUndefined();

    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.warnings.join(" ")).toContain("tokens.encryptedRefreshToken");
  });

  it("refuses to treat a Mattermost token as a connector grant", async () => {
    const deps = depsFor(
      { "u1/mattermost": { personalToken: "mm-token" } },
      vi.fn(async () => ({ ok: true, status: 200 }) as Response),
    );

    await revokeProviderGrant("u1", { connectorId: "mattermost", revocationUrl: "https://mm.example/revoke" }, deps);

    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.warnings.join(" ")).toContain("is not a connector grant");
  });

  it("logs provider failures without throwing", async () => {
    const deps = depsFor(
      { "u1/google": { tokens: { encryptedRefreshToken: "enc:refresh" } } },
      vi.fn(async () => ({ ok: false, status: 400 }) as Response),
    );

    await expect(revokeProviderGrant("u1", google, deps)).resolves.toBeUndefined();

    expect(deps.warnings.join(" ")).toContain("returned 400");
  });
});

describe("revokeAllConnectorGrantsForUser", () => {
  it("continues to later providers after one grant cannot be read", async () => {
    const posted: string[] = [];
    const warnings: string[] = [];
    const microsoft = createDocumentFixtureStore({
      "users/u1/secrets/microsoft": { tokens: { encryptedRefreshToken: "enc:microsoft" } },
    }).secrets;
    const deps = {
      secrets: {
        get: async (uid: string, connectorId: string) => {
          if (connectorId === "google") throw new Error("google read failed");
          return microsoft.get(uid, connectorId);
        },
      },
      decryptSecret: async (ciphertext: string) => ciphertext.replace("enc:", "plain:"),
      logger: { warn: (message: string) => warnings.push(message) },
      fetchImpl: vi.fn(async (url: string | URL | Request) => {
        posted.push(String(url));
        return { ok: true, status: 200 } as Response;
      }),
    } satisfies ConnectorRevocationDeps;

    await revokeAllConnectorGrantsForUser(
      "u1",
      [google, { connectorId: "microsoft", revocationUrl: "https://login.example/revoke" }],
      deps,
    );

    expect(posted).toEqual(["https://login.example/revoke"]);
    expect(warnings.join(" ")).toContain("google read failed");
  });
});
