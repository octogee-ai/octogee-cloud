import { beforeEach, describe, expect, it, vi } from "vitest";

import { internalFetch } from "../lib/internal-fetch.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";
import { createSharedAutosave } from "../entrypoints/provisioner.js";
import { createPreStopAllUsersFileFlush } from "../entrypoints/prestop-flush.js";

vi.mock("../lib/internal-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/internal-fetch.js")>()),
  internalFetch: vi.fn(),
}));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const previousApiUser = (slug: string) => ({
  uid: `uid-${slug}`,
  slug,
  tier: "personal",
  selectedTier: "personal",
  gatewayId: "walter",
  status: "complete",
  channels: [],
  projects: [],
});

const gatewayCredentialHeaders = async () => ({ "x-octogee-gateway-credential-token": "credential-token" });
const client = () => createFleetBrokerClient("walter", "walter-r9", { gatewayCredentialHeaders });

describe("roster reads that only need slugs, against an API that predates the plan input bag", () => {
  beforeEach(() => {
    vi.mocked(internalFetch).mockReset();
    vi.mocked(internalFetch).mockImplementation(async () =>
      jsonResponse({ users: [previousApiUser("alice"), previousApiUser("bob")] }));
    delete process.env.FLEET_BROKER_URL;
    process.env.OCTOGEE_API_URL = "http://broker";
  });

  it("still refuses that roster on the mount and ensure path", async () => {
    await expect(client().assignedUsers()).rejects.toThrow(/planInputs/);
  });

  it("reads the provisioned users' slugs from it", async () => {
    await expect(client().provisionedUserSlugs()).resolves.toEqual(["alice", "bob"]);
    expect(internalFetch).toHaveBeenCalledWith(
      "http://broker/internal/fleet/assigned-users",
      expect.objectContaining({ body: JSON.stringify({ gatewayId: "walter", revisionId: "walter-r9", completeOnly: true }) }),
    );
  });

  it("keeps the shared project autosave saving every user", async () => {
    const persist = vi.fn(async () => undefined);
    const log = vi.fn();

    await createSharedAutosave(client(), persist, log)();

    expect(persist.mock.calls).toEqual([["alice"], ["bob"]]);
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps the shared shutdown flush flushing every user", async () => {
    const flushAllUserFiles = vi.fn(async () => undefined);
    const persistSharedUserFiles = vi.fn(async () => undefined);

    await createPreStopAllUsersFileFlush("shared", client(), { flushAllUserFiles, persistSharedUserFiles })();

    expect(flushAllUserFiles).toHaveBeenCalledExactlyOnceWith({ slugs: ["alice", "bob"], persistProjects: persistSharedUserFiles });
  });
});

describe("the slug-only roster read", () => {
  beforeEach(() => {
    vi.mocked(internalFetch).mockReset();
    process.env.OCTOGEE_API_URL = "http://broker";
  });

  it.each([
    ["an entry without a slug", { users: [{ uid: "uid-alice" }] }],
    ["an entry with an empty slug", { users: [{ uid: "uid-alice", slug: "" }] }],
    ["an entry that is not an object", { users: ["alice"] }],
    ["no user list", { assigned: [] }],
  ])("refuses a roster with %s", async (_label, body) => {
    vi.mocked(internalFetch).mockResolvedValueOnce(jsonResponse(body));

    await expect(client().provisionedUserSlugs()).rejects.toThrow(/assigned-user roster/);
  });

  it("does not ask for the roster on a gateway that flushes only what is on disk", async () => {
    const flushAllUserFiles = vi.fn(async () => undefined);

    await createPreStopAllUsersFileFlush("standard", client(), { flushAllUserFiles, persistSharedUserFiles: vi.fn() })();

    expect(flushAllUserFiles).toHaveBeenCalledExactlyOnceWith({});
    expect(internalFetch).not.toHaveBeenCalled();
  });
});
