import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  writes: [] as string[],
  revokeProviderGrant: vi.fn(async () => undefined),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuthenticatedUid: (req: Request, _res: Response, next: NextFunction) => {
    req.uid = "owner";
    next();
  },
  requireActiveAccount: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("@octogee/core/connector-revocation", () => ({
  revokeProviderGrant: h.revokeProviderGrant,
}));

vi.mock("../lib/platform-state.js", () => ({
  platformStateStore: { secrets: {} },
}));

vi.mock("../lib/db.js", () => {
  const doc = (path: string) => ({ path, doc: (id: string) => doc(`${path}/${id}`), collection: (id: string) => doc(`${path}/${id}`) });
  return {
    db: {
      collection: (id: string) => doc(id),
      batch: () => ({
        set: (ref: { path: string }) => h.writes.push(`set ${ref.path}`),
        delete: (ref: { path: string }) => h.writes.push(`delete ${ref.path}`),
        commit: async () => {
          h.writes.push("commit");
        },
      }),
    },
    FieldValue: { serverTimestamp: () => "now" },
    Timestamp: { fromMillis: (ms: number) => ms },
  };
});

const { default: connectRoutes } = await import("./connect.js");
const { NO_CONNECTOR_DISCONNECTED, installConnectorDisconnected } = await import("../lib/connector-disconnect.js");

function app() {
  const target = express();
  target.use(express.json());
  target.use("/api/connect", connectRoutes);
  return target;
}

beforeEach(() => {
  h.writes.length = 0;
  h.revokeProviderGrant.mockClear();
});

afterEach(() => {
  installConnectorDisconnected(NO_CONNECTOR_DISCONNECTED);
});

describe("connector disconnect", () => {
  it("tells the installed hook which connector the user disconnected, after the disconnect commits", async () => {
    const disconnected = vi.fn(async () => {
      h.writes.push("hook");
    });
    installConnectorDisconnected(disconnected);

    await request(app()).post("/api/connect/disconnect").send({ connector: "google" }).expect(200, { ok: true });

    expect(disconnected).toHaveBeenCalledWith("owner", "google");
    expect(h.writes).toEqual([
      "set users/owner/integrations/google",
      "delete users/owner/secrets/google",
      "commit",
      "hook",
    ]);
  });

  it("fails the disconnect when the installed hook fails", async () => {
    installConnectorDisconnected(async () => {
      throw new Error("hook failed");
    });

    const response = await request(app()).post("/api/connect/disconnect").send({ connector: "google" });

    expect(response.status).toBe(500);
  });

  it("disconnects without a product hook", async () => {
    await request(app()).post("/api/connect/disconnect").send({ connector: "google" }).expect(200, { ok: true });

    expect(h.writes).toContain("commit");
  });

  it("does not serve the Google grant directory", async () => {
    await request(app()).get("/api/connect/google/grants").expect(404);
    await request(app()).post("/api/connect/google/grants/member").send({ permissions: [] }).expect(404);
  });
});
