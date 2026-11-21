import { beforeEach, expect, it, vi } from "vitest";

const gitea = vi.hoisted(() => ({
  createProjectGiteaRepo: vi.fn(async () => true),
  giteaWriteFile: vi.fn(async () => undefined),
  giteaWriteFiles: vi.fn(async () => undefined),
  giteaWriteFilesIfAllAbsent: vi.fn(async () => undefined),
  giteaDeleteVerifiedRepo: vi.fn(async () => undefined),
}));

vi.mock("@octogee/core/git-host/gitea-client", () => gitea);
vi.mock("../lib/board-welcome.js", () => ({ seedBoardWelcomeIssue: async () => undefined }));

const { ensureProjectGiteaRepo } = await import("../routes/projects/provisioning.js");

const INPUT = {
  workspaceId: "mira",
  slug: "orbit",
  name: "Orbit",
  tagline: "Ship it",
  projectType: null,
  visibility: "private",
  recipe: "vite-static" as const,
};

function seededStarter(): Array<{ path: string; content: string | Buffer }> {
  const starterCalls = gitea.giteaWriteFilesIfAllAbsent.mock.calls as unknown as Array<
    [string, string, Array<{ path: string; content: string | Buffer }>, string]
  >;
  expect(starterCalls).toHaveLength(1);
  expect(starterCalls[0][3]).toBe("auto: seed project starter");
  return starterCalls[0][2];
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("seeds the product's starter files in place of the recipe seed, only where none exist", async () => {
  await ensureProjectGiteaRepo({
    ...INPUT,
    starterFiles: [
      { path: "package.json", content: "{\"name\":\"orbit\"}\n" },
      { path: "assets/icon.png", content: Buffer.from([0x89, 0x50]).toString("base64"), encoding: "base64" },
    ],
  });

  expect(seededStarter()).toEqual([
    { path: "package.json", content: "{\"name\":\"orbit\"}\n" },
    { path: "assets/icon.png", content: Buffer.from([0x89, 0x50]) },
  ]);
  expect(gitea.giteaWriteFiles).toHaveBeenCalledWith(
    "mira",
    "orbit",
    expect.arrayContaining([expect.objectContaining({ path: "runbook/how-we-build.md" })]),
    "auto: seed project playbook",
  );
});

it("seeds the recipe starter when the product supplies no starter files", async () => {
  await ensureProjectGiteaRepo(INPUT);

  const paths = seededStarter().map((file) => file.path);
  expect(paths).toEqual(expect.arrayContaining(["package.json", "package-lock.json"]));
  expect(seededStarter().find((file) => file.path === "package.json")?.content).toContain("\"name\": \"orbit\"");
});

it("seeds no starter for a recipe without one", async () => {
  await ensureProjectGiteaRepo({ ...INPUT, recipe: "static-site" });

  expect(seededStarter()).toEqual([]);
});

it.each(["README.md", "runbook/how-we-build.md"])(
  "refuses starter files that include %s, which the platform seeds itself, before touching the repository",
  async (path) => {
    await expect(ensureProjectGiteaRepo({
      ...INPUT,
      starterFiles: [
        { path: "package.json", content: "{}\n" },
        { path, content: "# Mine\n" },
      ],
    })).rejects.toThrow(`starter files must not include ${path}`);

    expect(gitea.createProjectGiteaRepo).not.toHaveBeenCalled();
    expect(gitea.giteaWriteFilesIfAllAbsent).not.toHaveBeenCalled();
  },
);
