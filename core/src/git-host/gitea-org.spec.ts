import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const OLD_ENV = { ...process.env };

function res(status: number, body: unknown = {}): Response {
  const noBody = status === 204 || status === 304;
  return new Response(noBody ? null : JSON.stringify(body), { status });
}

describe("gateway-edge gitea client — per-workspace org", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.GITEA_URL = "http://gitea.test:3000";
    process.env.GITEA_TOKEN = "admin-tok";
    process.env.K8S_NAMESPACE = "octogee";
    delete process.env.GITEA_ORG;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...OLD_ENV };
  });

  it("giteaApi targets /repos/{org}/{path} — org is an explicit arg, not GITEA_ORG", async () => {
    fetchMock.mockResolvedValueOnce(res(200, { ok: true }));
    const { giteaApi } = await import("./gitea-client.js");
    await giteaApi("acme", "workspace/contents/README.md");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://gitea.test:3000/api/v1/repos/acme/workspace/contents/README.md",
    );
  });

  it("giteaApiAs threads the caller token and the workspace org", async () => {
    fetchMock.mockResolvedValueOnce(res(200, {}));
    const { giteaApiAs } = await import("./gitea-client.js");
    await giteaApiAs("cust-tok", "alice", "my-game/contents/x");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gitea.test:3000/api/v1/repos/alice/my-game/contents/x");
    expect((init.headers as Record<string, string>).Authorization).toBe("token cust-tok");
  });

  it("sends a repository endpoint and its query to the configured Gitea API", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const { giteaApi } = await import("./gitea-client.js");
    await giteaApi("alice", "my-game/contents/a file.md?ref=feature%2Fdocs");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://gitea.test:3000/api/v1/repos/alice/my-game/contents/a%20file.md?ref=feature%2Fdocs",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("rejects paths outside the selected repository before sending credentials", async () => {
    const { giteaApi } = await import("./gitea-client.js");
    await expect(giteaApi("alice", "my-game/contents/%2e%2e/readme.md")).rejects.toThrow(/Invalid Gitea API path/);
    await expect(giteaApi("alice/other", "my-game")).rejects.toThrow(/Invalid Gitea name/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("encodes file names separately from API query parameters and blocks admin redirects", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const { giteaWriteFile } = await import("./gitea-client.js");
    await giteaWriteFile("alice", "my-game", "docs/What?#.md", "draft", "seed");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://gitea.test:3000/api/v1/repos/alice/my-game/contents/docs/What%3F%23.md",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("createProjectGiteaRepo posts to /orgs/{org}/repos", async () => {
    fetchMock.mockResolvedValueOnce(res(201, {}));
    const { createProjectGiteaRepo } = await import("./gitea-client.js");
    await expect(createProjectGiteaRepo("alice", "my-game", "desc", true)).resolves.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://gitea.test:3000/api/v1/orgs/alice/repos",
    );
  });

  it("quietly accepts a create conflict only after verifying the existing repo binding and configuration", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock
      .mockResolvedValueOnce(res(409, { message: "already exists" }))
      .mockResolvedValueOnce(res(200, {
        name: "my-game",
        owner: { login: "alice" },
        private: true,
        default_branch: "main",
      }));
    const { createProjectGiteaRepo } = await import("./gitea-client.js");
    await expect(createProjectGiteaRepo("alice", "my-game", "desc", true)).resolves.toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://gitea.test:3000/api/v1/orgs/alice/repos",
      "http://gitea.test:3000/api/v1/repos/alice/my-game",
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it.each([
    ["owner", { name: "my-game", owner: { login: "victim" }, private: true, default_branch: "main" }],
    ["privacy", { name: "my-game", owner: { login: "alice" }, private: false, default_branch: "main" }],
    ["default branch", { name: "my-game", owner: { login: "alice" }, private: true, default_branch: "master" }],
  ])("rejects a create conflict when the existing repo has mismatched %s", async (_label, existing) => {
    fetchMock
      .mockResolvedValueOnce(res(409, { message: "already exists" }))
      .mockResolvedValueOnce(res(200, existing));
    const { createProjectGiteaRepo } = await import("./gitea-client.js");
    await expect(createProjectGiteaRepo("alice", "my-game", "desc", true)).rejects.toThrow(
      /binding mismatch|configuration mismatch/,
    );
  });

  it("rejects a create conflict when no expected repo can be read back", async () => {
    fetchMock
      .mockResolvedValueOnce(res(409, { message: "conflict" }))
      .mockResolvedValueOnce(res(404));
    const { createProjectGiteaRepo } = await import("./gitea-client.js");
    await expect(createProjectGiteaRepo("alice", "my-game", "desc", true)).rejects.toThrow(
      /conflict without existing repo/,
    );
  });

  it("giteaDeleteRepo deletes {org}/{repo}", async () => {
    fetchMock.mockResolvedValueOnce(res(204));
    const { giteaDeleteRepo } = await import("./gitea-client.js");
    await giteaDeleteRepo("alice", "my-game");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gitea.test:3000/api/v1/repos/alice/my-game");
    expect(init.method).toBe("DELETE");
  });

  it("giteaDeleteVerifiedRepo checks the tenant binding before deletion and confirms absence after", async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { name: "my-game", owner: { login: "alice" } }))
      .mockResolvedValueOnce(res(204))
      .mockResolvedValueOnce(res(404));

    const { giteaDeleteVerifiedRepo } = await import("./gitea-client.js");
    await giteaDeleteVerifiedRepo("alice", "my-game");

    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "DELETE", "GET"]);
  });

  it("giteaDeleteVerifiedRepo refuses a repo that is not bound to the expected tenant", async () => {
    fetchMock.mockResolvedValueOnce(res(200, { name: "my-game", owner: { login: "victim" } }));

    const { giteaDeleteVerifiedRepo } = await import("./gitea-client.js");
    await expect(giteaDeleteVerifiedRepo("alice", "my-game")).rejects.toThrow(/binding mismatch/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not export a GITEA_ORG constant (no shared-org fallback)", async () => {
    const mod = await import("./gitea-client.js");
    expect("GITEA_ORG" in mod).toBe(false);
  });

  it("giteaWriteFiles probes each path, logs preserved files, and batch-creates only absent ones", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(res(200, { path: "README.md" }))
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(201, {}));

    const { giteaWriteFiles } = await import("./gitea-client.js");
    await giteaWriteFiles(
      "alice",
      "my-game",
      [
        { path: "README.md", content: "# already here" },
        { path: "DECISIONS.md", content: "# Decisions\n" },
        { path: "runbook/how-we-build.md", content: "# How\n" },
      ],
      "auto: seed project playbook",
    );

    expect(log).toHaveBeenCalledWith(expect.stringContaining('"path":"README.md"'));
    log.mockRestore();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://gitea.test:3000/api/v1/repos/alice/my-game/contents/README.md",
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "http://gitea.test:3000/api/v1/repos/alice/my-game/contents/runbook/how-we-build.md",
    );

    const [url, init] = fetchMock.mock.calls[3];
    expect(url).toBe("http://gitea.test:3000/api/v1/repos/alice/my-game/contents");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(body.message).toBe("auto: seed project playbook");
    expect(body.branch).toBe("main");
    expect(body.files).toEqual([
      {
        operation: "create",
        path: "DECISIONS.md",
        content: Buffer.from("# Decisions\n", "utf-8").toString("base64"),
      },
      {
        operation: "create",
        path: "runbook/how-we-build.md",
        content: Buffer.from("# How\n", "utf-8").toString("base64"),
      },
    ]);
  });

  it("giteaWriteFiles issues no commit when every file already exists (retry is a no-op)", async () => {
    // A fresh Response per call: one instance cannot have its body read twice.
    fetchMock.mockImplementation(() => Promise.resolve(res(200, { path: "x" })));

    const { giteaWriteFiles } = await import("./gitea-client.js");
    await giteaWriteFiles(
      "alice",
      "my-game",
      [
        { path: "DECISIONS.md", content: "a" },
        { path: "notes/welcome.md", content: "b" },
      ],
      "auto: seed project playbook",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.method).toBe("GET");
    }
  });

  it("keeps a seed group all-or-none when an existing package file is present", async () => {
    fetchMock
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(200, { path: "package-lock.json" }));

    const { giteaWriteFilesIfAllAbsent } = await import("./gitea-client.js");
    await giteaWriteFilesIfAllAbsent(
      "alice",
      "my-game",
      [
        { path: "package.json", content: "new manifest" },
        { path: "package-lock.json", content: "new lock" },
      ],
      "auto: seed project starter",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.method).toBe("GET");
    }
  });

  it("batch-creates an all-absent seed group with its binary archive intact", async () => {
    const archive = Buffer.from([0x1f, 0x8b, 0x00, 0xff]);
    fetchMock
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(201, {}));

    const { giteaWriteFilesIfAllAbsent } = await import("./gitea-client.js");
    await giteaWriteFilesIfAllAbsent(
      "alice",
      "my-game",
      [
        { path: "package.json", content: "new manifest" },
        { path: "package-lock.json", content: "new lock" },
        { path: "vendor/picomatch.tgz", content: archive },
      ],
      "auto: seed project starter",
    );

    const [, init] = fetchMock.mock.calls[3];
    const body = JSON.parse(init.body as string);
    expect(body.files).toEqual([
      {
        operation: "create",
        path: "package.json",
        content: Buffer.from("new manifest", "utf-8").toString("base64"),
      },
      {
        operation: "create",
        path: "package-lock.json",
        content: Buffer.from("new lock", "utf-8").toString("base64"),
      },
      { operation: "create", path: "vendor/picomatch.tgz", content: archive.toString("base64") },
    ]);
  });

  it("giteaWriteFiles throws when the batch commit is rejected — seeds are not best-effort", async () => {
    fetchMock
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(422, { message: "already exists" }));

    const { giteaWriteFiles } = await import("./gitea-client.js");
    await expect(
      giteaWriteFiles("alice", "my-game", [{ path: "DECISIONS.md", content: "a" }], "auto: seed"),
    ).rejects.toThrow(/422/);
  });
});
