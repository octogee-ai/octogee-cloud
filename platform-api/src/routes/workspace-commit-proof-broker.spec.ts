import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import {
  WORKSPACE_COMMIT_PROOF_PATH,
  workspaceCommitProofSignature,
} from "../lib/workspace-commit-proof.js";
import { createWorkspaceCommitProofBrokerRoutes } from "./workspace-commit-proof-broker.js";

const NOW = Date.now();
const target = { agentId: "octogee-acme-coach", slug: "acme", project: null };


function app(store: PlatformStateStore, bound = true): Express {
  const server = express();
  server.use(express.json());
  if (bound) {
    server.use((req, _res, next) => {
      req.boundTenant = { kind: "gateway", gatewayId: "shared-b" };
      next();
    });
  }
  server.use("/internal/workspace-commit", createWorkspaceCommitProofBrokerRoutes({ store }));
  return server;
}

function requestBody(
  body: Record<string, unknown> = target,
  claimedTarget = target,
): Record<string, unknown> {
  const serialized = JSON.stringify(body);
  const timestamp = String(NOW);
  return {
    gatewayId: "shared-b",
    target: claimedTarget,
    proof: {
      timestamp,
      signature: workspaceCommitProofSignature(
        "acme-coach-pat",
        timestamp,
        WORKSPACE_COMMIT_PROOF_PATH,
        serialized,
      ),
      body: serialized,
    },
  };
}

const records = {
  "workspaces/acme": { id: "acme", ownerUid: "owner-acme" },
  "users/owner-acme/secrets/coachMattermost": { personalToken: "acme-coach-pat" },
};

describe("workspace commit proof broker", () => {
  it("returns no secret when a sidecar-authenticated gateway presents a valid proof", async () => {
    const res = await request(app(createDocumentFixtureStore(records)))
      .post("/internal/workspace-commit/verify-proof")
      .send(requestBody())
      .expect(204);

    expect(res.text).toBe("");
  });

  it("rejects an unbound gateway, mismatched claimed target, and invalid proof", async () => {
    const unbound = await request(app(createDocumentFixtureStore(records), false))
      .post("/internal/workspace-commit/verify-proof")
      .send(requestBody())
      .expect(403);
    expect(unbound.body).toEqual({ error: "forbidden" });

    const mismatched = await request(app(createDocumentFixtureStore(records)))
      .post("/internal/workspace-commit/verify-proof")
      .send(requestBody(target, { ...target, slug: "victim" }))
      .expect(400);
    expect(mismatched.body).toEqual({ error: "invalid_proof" });

    const invalid = requestBody();
    (invalid.proof as Record<string, unknown>).signature = "0".repeat(64);
    const rejected = await request(app(createDocumentFixtureStore(records)))
      .post("/internal/workspace-commit/verify-proof")
      .send(invalid)
      .expect(403);
    expect(rejected.body).toEqual({ error: "forbidden" });
  });

  it("reports a retryable error when the trusted datastore lookup fails", async () => {
    const unavailable = createDocumentFixtureStore(records);
    vi.spyOn(unavailable.workspaces.records, "get").mockRejectedValue(new Error("Firestore unavailable"));

    const response = await request(app(unavailable))
      .post("/internal/workspace-commit/verify-proof")
      .send(requestBody())
      .expect(503);
    expect(response.body).toEqual({ error: "proof_unavailable" });
  });
});
