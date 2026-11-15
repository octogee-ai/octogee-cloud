import { describe, expect, it } from "vitest";

import { giteaNaming } from "@octogee/core/git-host";
import { gatewayKeyOwnerId, gatewayKeyTitle, giteaUsername, systemConfigRepoName, workspaceRepoName } from "@octogee/core/gitea-naming";
import { placeholderEmail } from "@octogee/core/placeholder-email";
import { PROJECT_AGENT_REPO } from "@octogee/shared/types/project";

import { createGiteaGitHostAdapter } from "./git-host-gitea.js";
import { FakeGiteaApi } from "./gitea-api.fake.js";
import { HostError } from "./host-error.js";

const signal = () => new AbortController().signal;
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGatewayKeyOne gateway";
const OTHER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGatewayKeyTwo gateway";

function setup() {
  const api = new FakeGiteaApi();
  const logs: string[] = [];
  const host = createGiteaGitHostAdapter({
    apiBaseUrl: api.apiBaseUrl,
    adminToken: "git-admin-token",
    fetch: api.fetch,
    log: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
  });
  return { api, host, logs };
}

describe("Gitea git host adapter", () => {
  it("creates the user's account, owner, team membership and repositories under the legacy names", async () => {
    const { api, host } = setup();
    const { owner } = await host.ensureOwner({ slug: "lin" }, signal());
    expect(owner).toBe(giteaNaming.owner("lin"));
    expect(api.accounts.get(giteaUsername("lin"))).toEqual({ email: placeholderEmail("lin"), visibility: "private" });
    expect(api.organizations.has("lin")).toBe(true);
    expect([...api.teams.values()]).toEqual([{ org: "lin", name: "builders", members: new Set([giteaUsername("lin")]) }]);

    const workspace = await host.ensureRepository({ owner, kind: "workspace" }, signal());
    const agents = await host.ensureRepository({ owner, kind: "project-coaches" }, signal());
    const systemConfig = await host.ensureRepository({ owner, kind: "system-config" }, signal());
    expect(workspace).toEqual({
      cloneUrl: `https://git.invalid/lin/${workspaceRepoName()}.git`,
      sshUrl: `ssh://git@git.invalid/lin/${workspaceRepoName()}.git`,
    });
    expect(agents.cloneUrl).toBe(`https://git.invalid/lin/${PROJECT_AGENT_REPO}.git`);
    expect(systemConfig.cloneUrl).toBe(`https://git.invalid/lin/${systemConfigRepoName()}.git`);
    expect([...api.repositories.keys()].sort()).toEqual(
      [`lin/${workspaceRepoName()}`, `lin/${PROJECT_AGENT_REPO}`, `lin/${systemConfigRepoName()}`].sort(),
    );
    expect(api.repositories.get(`lin/${workspaceRepoName()}`)).toEqual({ private: true, description: "Octogee workspace for lin" });
  });

  it("confirms existing resources on a second attempt without creating any", async () => {
    const { api, host } = setup();
    const { owner } = await host.ensureOwner({ slug: "lin" }, signal());
    await host.ensureRepository({ owner, kind: "workspace" }, signal());
    api.requests.length = 0;

    await host.ensureOwner({ slug: "lin", knownOwner: owner }, signal());
    await host.ensureRepository({ owner, kind: "workspace" }, signal());

    expect(api.count("POST", /^\/admin\/users$/)).toBe(0);
    expect(api.count("POST", /^\/orgs\/[^/]+\/repos$/)).toBe(0);
    expect(api.repositories.size).toBe(1);
  });

  it("settles concurrent creates of the same owner and repository when the git host answers each race loser with a 500", async () => {
    const { api, host } = setup();
    api.racingDuplicateCreates = 2;

    const owners = await Promise.all([1, 2].map(() => host.ensureOwner({ slug: "lin" }, signal())));
    expect(owners).toEqual([{ owner: "lin" }, { owner: "lin" }]);
    expect(api.accounts.size).toBe(1);
    expect(api.organizations.size).toBe(1);
    expect(api.count("POST", /^\/admin\/users$/)).toBe(2);
    expect(api.count("POST", /^\/orgs$/)).toBeGreaterThanOrEqual(2);

    api.racingDuplicateCreates = 1;
    const repositories = await Promise.all([1, 2].map(() => host.ensureRepository({ owner: "lin", kind: "workspace" }, signal())));
    expect(repositories[0]).toEqual(repositories[1]);
    expect(api.repositories.size).toBe(1);
    expect(api.count("POST", /^\/orgs\/lin\/repos$/)).toBe(2);
    expect(api.racingDuplicateCreates).toBe(0);
  });

  it.each([
    [503, "transient"],
    [429, "transient"],
    [403, "terminal"],
  ] as const)("classes a %i on account create as %s", async (status, kind) => {
    const { api, host } = setup();
    api.fail("POST", /^\/admin\/users$/, status);
    const error = await host.ensureOwner({ slug: "lin" }, signal()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostError);
    expect(error).toMatchObject({ kind });
  });

  it("classes a failure inside the owner sequence by the git host's status", async () => {
    const { api, host } = setup();
    api.fail("PUT", /^\/teams\/\d+\/members\//, 502, 2);
    await expect(host.ensureOwner({ slug: "lin" }, signal())).rejects.toMatchObject({ kind: "transient" });
    api.fail("PUT", /^\/teams\/\d+\/members\//, 403, 2);
    await expect(host.ensureOwner({ slug: "lin" }, signal())).rejects.toMatchObject({ kind: "terminal" });
  });

  it("classes an unreachable git host as transient", async () => {
    const { api, host } = setup();
    api.fail("GET", /^\/repos\//, 0);
    await expect(host.ensureRepository({ owner: "lin", kind: "workspace" }, signal())).rejects.toMatchObject({ kind: "transient" });
  });

  it("fails the repository step terminally when the owner does not exist", async () => {
    const { host } = setup();
    await expect(host.ensureRepository({ owner: "lin", kind: "workspace" }, signal())).rejects.toMatchObject({ kind: "terminal" });
  });

  it("authorizes a gateway's key once and lists it with its holder", async () => {
    const { api, host } = setup();
    await host.ensureOwner({ slug: "lin" }, signal());
    await host.registerKey({ owner: "lin", publicKey: KEY, holder: "gw-1" }, signal());
    await host.registerKey({ owner: "lin", publicKey: KEY, holder: "gw-1" }, signal());
    expect(api.keys.get(giteaUsername("lin"))).toEqual([expect.objectContaining({ key: KEY, title: gatewayKeyTitle("gw-1") })]);
    await expect(host.listKeys({ owner: "lin", holders: ["gw-1"] }, signal())).resolves.toEqual([{ publicKey: KEY, holder: "gw-1" }]);
    await expect(host.listKeys({ owner: "lin", holders: [] }, signal())).resolves.toEqual([{ publicKey: KEY, holder: null }]);
  });

  it("lists a key the legacy path registered with a holder it does not know as unheld, and ignores unmanaged keys", async () => {
    const { api, host } = setup();
    await host.ensureOwner({ slug: "lin" }, signal());
    api.addKey(giteaUsername("lin"), gatewayKeyTitle(gatewayKeyOwnerId("gw-1", "pod-a")), KEY);
    api.addKey(giteaUsername("lin"), "laptop", OTHER_KEY);
    await expect(host.listKeys({ owner: "lin", holders: ["gw-1"] }, signal())).resolves.toEqual([{ publicKey: KEY, holder: null }]);
  });

  it("moves a key to a new holder and releases it", async () => {
    const { api, host } = setup();
    await host.ensureOwner({ slug: "lin" }, signal());
    await host.registerKey({ owner: "lin", publicKey: KEY, holder: "gw-1" }, signal());
    await host.registerKey({ owner: "lin", publicKey: KEY, holder: "gw-2" }, signal());
    await expect(host.listKeys({ owner: "lin", holders: ["gw-1", "gw-2"] }, signal())).resolves.toEqual([{ publicKey: KEY, holder: "gw-2" }]);
    await host.releaseKey({ owner: "lin", publicKey: KEY, holder: "gw-2" }, signal());
    expect(api.keys.get(giteaUsername("lin"))).toEqual([]);
  });

  it("returns an empty key list for an owner whose account does not exist yet", async () => {
    const { host } = setup();
    await expect(host.listKeys({ owner: "lin", holders: ["gw-1"] }, signal())).resolves.toEqual([]);
  });

  it("classes a failed key registration by the git host's status and never logs the admin token", async () => {
    const { api, host, logs } = setup();
    await host.ensureOwner({ slug: "lin" }, signal());
    api.fail("POST", /^\/admin\/users\/[^/]+\/keys$/, 500);
    await expect(host.registerKey({ owner: "lin", publicKey: KEY, holder: "gw-1" }, signal())).rejects.toMatchObject({ kind: "transient" });
    expect(JSON.stringify(logs)).not.toContain("git-admin-token");
  });
});
