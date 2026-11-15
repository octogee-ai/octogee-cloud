import { afterEach, describe, expect, it, vi } from "vitest";

import { internalFetch } from "../lib/internal-fetch.js";
import { cloneGithubProjectViaBroker } from "../lib/github-project-clone-broker.js";

vi.mock("../lib/internal-fetch.js", () => ({ internalFetch: vi.fn() }));

afterEach(() => {
  vi.mocked(internalFetch).mockReset();
  delete process.env.GATEWAY_EDGE_INTERNAL_URL;
});

describe("GitHub project clone sidecar client", () => {
  it("binds the clone request to the caller's user and project", async () => {
    process.env.GATEWAY_EDGE_INTERNAL_URL = "http://127.0.0.1:3001";
    vi.mocked(internalFetch).mockResolvedValue(new Response(JSON.stringify({ status: "cloned" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));

    await expect(cloneGithubProjectViaBroker("alice", "octo")).resolves.toBe(true);
    expect(internalFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/internal/connectors/github/clone",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ builderSlug: "alice", projectSlug: "octo" }),
      }),
    );
  });

  it("keeps a broker reauthorization response observable to the caller", async () => {
    vi.mocked(internalFetch).mockResolvedValue(new Response(
      JSON.stringify({ error: "reauth_required" }),
      { status: 409, headers: { "content-type": "application/json" } },
    ));

    await expect(cloneGithubProjectViaBroker("alice", "octo"))
      .rejects.toThrow(/409.*reauth_required/);
  });
});
