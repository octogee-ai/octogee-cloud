import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
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
import { commitAndPushWorkspace } from "./workspace-git.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("/usr/bin/git", args, {
    cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}

const sha = "a".repeat(64);
function manifest(uploadedAt: string) {
  return { "avatar.png": {
    type: "blob", gcsPath: `customers/alice/projects/orbit/.objects/${sha}`,
    sha256: sha, size: 7384, mimeType: "image/png", uploadedAt,
  } };
}
const remoteManifest = manifest("2026-10-12T20:07:21.744Z");
const localManifest = manifest("2026-10-12T23:01:51.876Z");
let root: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(local: unknown, extraConflict = false, localContext = true) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-rebase-"));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const repo = path.join(root, "customers", "alice", "projects", "orbit");
  const metadata = path.join(root, "git-metadata", "alice", "projects", "orbit.git");
  await fs.mkdir(seed);
  git(root, ["init", "--bare", "--initial-branch=main", remote]);
  git(seed, ["init", "--initial-branch=main"]);
  git(seed, ["config", "user.name", "Test"]);
  git(seed, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(seed, "README.md"), "base\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "base"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  await fs.mkdir(path.dirname(repo), { recursive: true });
  git(root, ["clone", remote, repo]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  await fs.mkdir(path.join(seed, ".files"));
  await fs.mkdir(path.join(repo, ".files"));
  await fs.writeFile(path.join(seed, ".files/manifest.json"), JSON.stringify(remoteManifest));
  await fs.writeFile(path.join(repo, ".files/manifest.json"), JSON.stringify(local));
  if (localContext) await fs.writeFile(path.join(repo, "local-context.md"), "retained local context\n");
  if (extraConflict) {
    await fs.writeFile(path.join(seed, "README.md"), "remote authored content\n");
    await fs.writeFile(path.join(repo, "README.md"), "local authored content\n");
  }
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "published asset"]);
  await fs.writeFile(path.join(seed, "remote-proof.md"), "remote proof\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "remote proof"]);
  git(seed, ["push", "origin", "main"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "local duplicate upload"]);
  const localHead = git(repo, ["rev-parse", "HEAD"]);
  const remoteHead = git(remote, ["rev-parse", "main"]);
  git(repo, ["remote", "set-url", "origin", "git@gitea:alice/orbit.git"]);
  await fs.mkdir(path.dirname(metadata), { recursive: true });
  await fs.rename(path.join(repo, ".git"), metadata);
  await fs.writeFile(`${metadata}.octogee-trusted-v3`, "octogee-customer-git-v3\ngitea:orbit\n");
  await fs.writeFile(path.join(repo, ".git"), `gitdir: ${metadata}\n`);
  transport.ssh = path.join(root, "ssh");
  await fs.writeFile(transport.ssh, `#!/bin/sh\ncase "$2" in *receive-pack*) exec /usr/bin/git-receive-pack '${remote}';; *) exec /usr/bin/git-upload-pack '${remote}';; esac\n`);
  await fs.chmod(transport.ssh, 0o755);
  vi.stubEnv("CUSTOMERS_DIR", path.join(root, "customers"));
  return { repo, remote, localHead, remoteHead };
}

async function save(repo: string) {
  return commitAndPushWorkspace(repo, {
    message: "autosave", author: { name: "Octogee", email: "autosave@example.com" },
  });
}

describe("immutable asset upload timestamp rebase", () => {
  it("keeps the published timestamp and both sides' nonconflicting context", async () => {
    const { repo, remote, localHead } = await fixture(localManifest);
    expect(await save(repo)).toEqual({
      ok: true, result: { committed: false, pushed: true, nothingToCommit: true },
    });
    expect(JSON.parse(git(remote, ["show", "main:.files/manifest.json"]))).toEqual(remoteManifest);
    expect(git(remote, ["show", "main:local-context.md"])).toBe("retained local context");
    expect(git(remote, ["show", "main:remote-proof.md"])).toBe("remote proof");
    expect(git(repo, ["cat-file", "-t", localHead])).toBe("commit");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });

  it("skips only the redundant replay when the manifest is the entire local change", async () => {
    const { repo, remote, localHead, remoteHead } = await fixture(localManifest, false, false);
    expect(await save(repo)).toEqual({
      ok: true, result: { committed: false, pushed: true, nothingToCommit: true },
    });
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(remoteHead);
    expect(git(remote, ["rev-parse", "main"])).toBe(remoteHead);
    expect(JSON.parse(git(remote, ["show", "main:.files/manifest.json"]))).toEqual(remoteManifest);
    expect(git(repo, ["cat-file", "-t", localHead])).toBe("commit");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });

  it.each([
    ["changed asset identity", { "avatar.png": { ...localManifest["avatar.png"], size: 7385 } }, false],
    ["invalid timestamp", manifest("not-a-timestamp"), false],
    ["unknown schema field", { "avatar.png": { ...localManifest["avatar.png"], future: true } }, false],
    ["authored content conflict", localManifest, true],
  ])("aborts and retains local work for %s", async (_name, local, conflict) => {
    const { repo, remote, localHead, remoteHead } = await fixture(local, conflict);
    expect(await save(repo)).toMatchObject({ ok: true, result: { pushed: false, pushError: "git failed (status 1)" } });
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(localHead);
    expect(git(remote, ["rev-parse", "main"])).toBe(remoteHead);
    expect(JSON.parse(await fs.readFile(path.join(repo, ".files/manifest.json"), "utf8"))).toEqual(local);
    expect(await fs.readFile(path.join(repo, "local-context.md"), "utf8")).toBe("retained local context\n");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });
});
