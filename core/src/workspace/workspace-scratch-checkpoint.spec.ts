import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ ssh: "" }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((command: string, args: string[], options: Parameters<typeof actual.spawn>[2]) =>
      actual.spawn(command, args, {
        ...options, env: { ...options?.env, GIT_SSH_COMMAND: transport.ssh },
      })) as typeof actual.spawn,
  };
});
import { commitAndPushWorkspace, gitStatus } from "./workspace-git.js";
import { divertWorktreeBinaries, type DivertBinariesDeps } from "./binary-diversion.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("/usr/bin/git", args, {
    cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}

const CHECKOUTS = {
  project: { parts: ["alice", "projects", "orbit"], metadata: ["alice", "projects", "orbit.git"], repo: "orbit", projectSlug: "orbit" },
  workspace: { parts: ["alice"], metadata: ["alice", "workspace.git"], repo: "workspace", projectSlug: null },
} as const;
type CheckoutKind = keyof typeof CHECKOUTS;

let root: string;
let gitfile: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) {
    await fs.chmod(gitfile, 0o644).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function checkout(kind: CheckoutKind) {
  const layout = CHECKOUTS[kind];
  root = await fs.mkdtemp(path.join(os.tmpdir(), "scratch-checkpoint-"));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "customers", ...layout.parts);
  const metadata = path.join(root, "git-metadata", ...layout.metadata);
  git(root, ["init", "--bare", "--initial-branch=main", remote]);
  await fs.mkdir(path.dirname(repo), { recursive: true });
  git(root, ["clone", remote, repo]);
  await fs.writeFile(path.join(repo, ".gitignore"), "node_modules/\ndist/\n");
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(repo, ["remote", "set-url", "origin", `git@gitea:alice/${layout.repo}.git`]);
  await fs.mkdir(path.dirname(metadata), { recursive: true });
  await fs.rename(path.join(repo, ".git"), metadata);
  await fs.rm(path.join(metadata, "info"), { recursive: true, force: true });
  await fs.writeFile(`${metadata}.octogee-trusted-v3`, `octogee-customer-git-v3\ngitea:${layout.repo}\n`);
  gitfile = path.join(repo, ".git");
  await fs.writeFile(gitfile, `gitdir: ${metadata}\n`);
  await fs.chmod(gitfile, 0o444);
  transport.ssh = path.join(root, "ssh");
  await fs.writeFile(transport.ssh, `#!/bin/sh\ncase "$2" in *receive-pack*) exec /usr/bin/git-receive-pack '${remote}';; *) exec /usr/bin/git-upload-pack '${remote}';; esac\n`);
  await fs.chmod(transport.ssh, 0o755);
  vi.stubEnv("CUSTOMERS_DIR", path.join(root, "customers"));
  const target = { slug: "alice", projectSlug: layout.projectSlug, gcsPrefix: path.posix.join("customers", ...layout.parts) };
  return { repo, remote, metadata, target };
}

async function expectScratchLeftOut(kind: CheckoutKind, retainLocalFiles: boolean) {
  const { repo, remote, metadata, target } = await checkout(kind);
  const compileCache = path.join(repo, ".openclaw", "tmp", "node-compile-cache", "v26.13.0-x64", "3f9a1c");
  await fs.mkdir(path.dirname(compileCache), { recursive: true });
  await fs.writeFile(compileCache, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  await fs.writeFile(path.join(repo, ".openclaw", "tmp", "notes.txt"), "scratch\n");
  await fs.writeFile(path.join(repo, ".openclaw", "worktree-setup.sh"), "#!/bin/sh\nnpm ci\n");
  await fs.writeFile(path.join(repo, "README.md"), "authored\n");
  const storeWorkspaceBlob = vi.fn(async () => { throw new Error("scratch must not be stored"); });
  const deps = { gitStatus, storeWorkspaceBlob } as unknown as DivertBinariesDeps;

  const saved = await commitAndPushWorkspace(repo, {
    message: "autosave", author: { name: "Octogee", email: "autosave@example.com" },
    beforeCommit: async () => {
      const result = await divertWorktreeBinaries(repo, target, deps, { retainLocalFiles });
      expect(result).toEqual({ diverted: [], failures: [], failedPaths: [] });
      return { ok: true };
    },
  });

  expect(saved).toMatchObject({ ok: true, result: { committed: true, pushed: true } });
  expect(storeWorkspaceBlob).not.toHaveBeenCalled();
  expect(git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n").sort())
    .toEqual([".gitignore", ".openclaw/worktree-setup.sh", "README.md"]);
  expect(existsSync(compileCache)).toBe(true);
  expect(existsSync(path.join(metadata, "info"))).toBe(false);
}

describe("OpenClaw workspace scratch", () => {
  const linuxTest = it.skipIf(process.platform !== "linux");

  linuxTest("is neither diverted nor committed when a project checkout is saved", () =>
    expectScratchLeftOut("project", true));

  linuxTest("is neither diverted nor committed when the user workspace is saved", () =>
    expectScratchLeftOut("workspace", false));

  it("stops tracking scratch a checkout committed earlier while keeping the files", async () => {
    const { repo, remote } = await checkout("project");
    const scratch = path.join(repo, ".openclaw", "tmp", "build.log");
    await fs.mkdir(path.dirname(scratch), { recursive: true });
    await fs.writeFile(scratch, "old\n");
    git(repo, ["add", "."]);
    git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "scratch"]);
    await fs.writeFile(scratch, "new\n");

    const saved = await commitAndPushWorkspace(repo, {
      message: "autosave", author: { name: "Octogee", email: "autosave@example.com" },
    });

    expect(saved).toMatchObject({ ok: true, result: { committed: true, pushed: true } });
    expect(git(remote, ["ls-tree", "-r", "--name-only", "main"])).toBe(".gitignore");
    expect(await fs.readFile(scratch, "utf8")).toBe("new\n");
  });
});
