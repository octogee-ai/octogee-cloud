import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProjectPersistenceRouter } from "./project-persistence.js";
import { _setGatewayTokenReviewerForTests, requireGatewayInternalAuth } from "../../middleware/gateway-internal-auth.js";
import { claimedTestUser, installTestUserIdentity } from "../../__tests__/helpers/user-identity.js";

const linuxTest = it.skipIf(process.platform !== "linux");

vi.mock("../../lib/connector-tokens.js", () => ({ readOwnerRuntimeConnectorAccessToken: vi.fn() }));
vi.mock("../../lib/workspace-blob.js", () => ({ storeWorkspaceBlob: vi.fn(async () => { throw new Error("unexpected binary upload in text checkpoint fixture"); }) }));

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (command: string, args: readonly string[], options: import("node:child_process").SpawnOptions) => actual.spawn(command, args, {
    ...options, env: { ...options.env, GIT_SSH_COMMAND: process.env.TEST_GIT_SSH },
  }) };
});

let root: string;
let user: string;
let remoteRoot: string;
let snapshot: Record<string, unknown>;
let broker: ReturnType<typeof vi.fn>;
let assignment: { uid: string; state: string; epoch: number };
let reviewed: { authenticated: true; namespace: string; saName: string; audiences: string[] };
const personas = { workspace: "# Agent\nExact agent persona α\n", demo: "# Project\nExact project persona β\n" };
function git(cwd: string, ...args: string[]): string {
  return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function checkout(name: string): string {
  const dir = name === "workspace" ? user : path.join(user, "projects", name);
  const remote = path.join(remoteRoot, `${name}.git`);
  git(root, "init", "--bare", "--initial-branch=main", remote);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Alice"); git(dir, "config", "user.email", "alice@example.test");
  writeFileSync(path.join(dir, ".gitignore"), "projects/\n");
  writeFileSync(path.join(dir, "IDENTITY.md"), "initial\n");
  git(dir, "add", "."); git(dir, "commit", "-m", "initial");
  git(dir, "push", remote, "main");
  git(dir, "remote", "add", "origin", `git@gitea:alice/${name}.git`);
  git(dir, "config", "branch.main.remote", "origin"); git(dir, "config", "branch.main.merge", "refs/heads/main");
  const metadata = name === "workspace" ? path.join(root, "git-metadata/alice/workspace.git") : path.join(root, `git-metadata/alice/projects/${name}.git`);
  mkdirSync(path.dirname(metadata), { recursive: true }); renameSync(path.join(dir, ".git"), metadata);
  writeFileSync(path.join(dir, ".git"), `gitdir: ${metadata}\n`);
  writeFileSync(`${metadata}.octogee-trusted-v3`, `octogee-customer-git-v3\ngitea:${name}\n`);
  return dir;
}
function app() { const a = express(); a.use(express.json()); a.use("/internal/projects", createProjectPersistenceRouter()); return a; }
function flush(slug = "alice", token = "workload-token") {
  return request(app()).post("/internal/projects/flush").set("x-k8s-sa-token", token).send({ slug });
}
function restored(name: string): Buffer {
  const dir = path.join(root, "restored", name);
  git(root, "clone", path.join(remoteRoot, `${name}.git`), dir);
  return readFileSync(path.join(dir, "IDENTITY.md"));
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "shared-git-checkpoint-"));
  user = path.join(root, "customers/alice"); remoteRoot = path.join(root, "remotes"); mkdirSync(remoteRoot);
  vi.stubEnv("GATEWAY_CLASS", "shared"); vi.stubEnv("GATEWAY_ID", "shared-one");
  vi.stubEnv("CUSTOMERS_DIR", path.join(root, "customers")); vi.stubEnv("INTERNAL_SERVICE_KEY", "");
  vi.stubEnv("K8S_NAMESPACE", "octogee-test"); vi.stubEnv("K8S_SERVICE_ACCOUNT_NAME", "octogee-gw-shared-one");
  vi.stubEnv("FLEET_BROKER_URL", "http://broker.invalid");
  const token = path.join(root, "token"); writeFileSync(token, "workload-token");
  vi.stubEnv("OCTOGEE_GATEWAY_CREDENTIAL_TOKEN_PATH", token);
  vi.stubEnv("OCTOGEE_API_SA_TOKEN_PATH", token);
  reviewed = { authenticated: true, namespace: "octogee-test", saName: "octogee-gw-shared-one", audiences: ["octogee-api"] };
  _setGatewayTokenReviewerForTests(async provided => provided === "workload-token" ? reviewed : { authenticated: false });
  const ssh = path.join(root, "ssh");
  writeFileSync(ssh, `#!/bin/sh\nfor last; do :; done\ncase "$last" in\n` + ["workspace", "demo", "other"].flatMap(name => ["upload", "receive"].map(op =>
    `  "git-${op}-pack 'alice/${name}.git'") exec /usr/bin/git-${op}-pack '${remoteRoot}/${name}.git';;\n`)).join("") + "  *) exit 91;;\nesac\n", { mode: 0o700 });
  vi.stubEnv("TEST_GIT_SSH", ssh);
  snapshot = { uid: "uid-alice", slug: "alice", gatewayId: "shared-one", status: "complete", projects: [{ projectSlug: "demo", giteaRepoName: "demo", provisioningState: "active" }] };
  assignment = { uid: "uid-alice", state: "serving", epoch: 3 };
  broker = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/uid-for-slug")) return Response.json({ uid: body.slug === "alice" ? "uid-alice" : "uid-bob" });
    if (url.endsWith("/user-snapshot")) return Response.json({ user: snapshot });
    if (url.endsWith("/assignment-roster")) return Response.json({ assignments: [assignment] });
    throw new Error(`unexpected network call ${url}`);
  });
  vi.stubGlobal("fetch", broker);
  checkout("workspace"); checkout("demo");
  writeFileSync(path.join(user, "IDENTITY.md"), personas.workspace);
  writeFileSync(path.join(user, "projects/demo/IDENTITY.md"), personas.demo);
});
afterEach(() => { _setGatewayTokenReviewerForTests(null); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

linuxTest("checkpoints exact Shared agent and Gitea project persona bytes for a cold clone", async () => {
  expect((await flush()).status).toBe(200);
  expect(restored("workspace")).toEqual(Buffer.from(personas.workspace));
  expect(restored("demo")).toEqual(Buffer.from(personas.demo));
});

linuxTest("accepts a checkpoint already published in an archived remote and retains unpublished changes", async () => {
  for (const [name, dir] of [["workspace", user], ["demo", path.join(user, "projects/demo")]]) {
    git(dir, "add", "."); git(dir, "commit", "-m", "published snapshot");
    git(dir, "push", path.join(remoteRoot, `${name}.git`), "main");
  }
  const remote = path.join(remoteRoot, "demo.git");
  const published = git(remote, "rev-parse", "refs/heads/main");
  const ssh = process.env.TEST_GIT_SSH!;
  const script = readFileSync(ssh, "utf8");
  writeFileSync(ssh, script.replaceAll("exec /usr/bin/git-receive-pack", "exit 128; exec /usr/bin/git-receive-pack"), { mode: 0o700 });
  expect((await flush()).status).toBe(200);
  writeFileSync(path.join(user, "projects/demo/unpublished.md"), "retain local-only work\n");
  const project = path.join(user, "projects/demo");
  git(project, "add", "."); git(project, "commit", "-m", "unpublished local work");
  expect((await flush()).status).toBe(503);
  expect(git(remote, "rev-parse", "refs/heads/main")).toBe(published);
  expect(readFileSync(path.join(user, "projects/demo/unpublished.md"), "utf8")).toBe("retain local-only work\n");
});

linuxTest.each(["missing", "stale"])("keeps nested project histories out of a %s workspace ignore policy", async policy => {
  const other = checkout("other");
  snapshot.projects = [...snapshot.projects as object[], { projectSlug: "other", giteaRepoName: "other", provisioningState: "active" }];
  const demo = path.join(user, "projects/demo");
  for (const dir of [demo, other]) {
    writeFileSync(path.join(dir, "deleted.md"), "delete this published project file\n");
    git(dir, "add", "."); git(dir, "commit", "-m", "published project baseline");
    git(dir, "push", path.join(remoteRoot, `${path.basename(dir)}.git`), "main");
    rmSync(path.join(dir, "deleted.md"));
    writeFileSync(path.join(dir, "unpublished.md"), `local-only ${path.basename(dir)}\n`);
  }
  const prior = git(demo, "rev-parse", "HEAD");
  git(user, "update-index", "--add", "--cacheinfo", "160000", prior, "projects/retired");
  git(user, "update-index", "--add", "--cacheinfo", "160000", prior, "projects/demo");
  git(user, "commit", "-m", "legacy workspace project gitlinks");
  git(user, "push", path.join(remoteRoot, "workspace.git"), "main");
  if (policy === "missing") rmSync(path.join(user, ".gitignore"));
  else writeFileSync(path.join(user, ".gitignore"), "# legacy user policy\n*.tmp\n");
  mkdirSync(path.join(user, "projects/.octogee-state"));
  writeFileSync(path.join(user, "projects/.octogee-state/runtime.json"), "{\"runtime\":true}\n");
  writeFileSync(path.join(user, "deleted.md"), "workspace deletion\n");
  git(user, "add", "deleted.md"); git(user, "commit", "-m", "workspace deletion baseline");
  rmSync(path.join(user, "deleted.md"));

  expect((await flush()).status).toBe(200);
  const heads = ["workspace", "demo", "other"].map(name => git(path.join(remoteRoot, `${name}.git`), "rev-parse", "main"));
  expect((await flush()).status).toBe(200);
  expect(["workspace", "demo", "other"].map(name => git(path.join(remoteRoot, `${name}.git`), "rev-parse", "main"))).toEqual(heads);
  expect(restored("workspace")).toEqual(Buffer.from(personas.workspace));
  expect(git(path.join(root, "restored/workspace"), "ls-files").split("\n").filter(name => name === "projects" || name.startsWith("projects/"))).toEqual([]);
  expect(existsSync(path.join(root, "restored/workspace/deleted.md"))).toBe(false);
  for (const name of ["demo", "other"]) {
    restored(name);
    expect(readFileSync(path.join(root, `restored/${name}/unpublished.md`), "utf8")).toBe(`local-only ${name}\n`);
    expect(existsSync(path.join(root, `restored/${name}/deleted.md`))).toBe(false);
    expect(readFileSync(path.join(user, `projects/${name}/unpublished.md`), "utf8")).toBe(`local-only ${name}\n`);
  }
  expect(readFileSync(path.join(user, "projects/demo/IDENTITY.md"), "utf8")).toBe(personas.demo);
  expect(existsSync(path.join(user, "projects/.octogee-state/runtime.json"))).toBe(true);
});

linuxTest("still refuses a workspace symlink outside the reserved projects namespace", async () => {
  const outside = path.join(root, "outside.txt"); writeFileSync(outside, "private\n");
  symlinkSync(outside, path.join(user, "escape.txt"));
  const before = git(path.join(remoteRoot, "workspace.git"), "rev-parse", "main");
  expect((await flush()).status).toBe(503);
  expect(git(path.join(remoteRoot, "workspace.git"), "rev-parse", "main")).toBe(before);
  expect(readFileSync(outside, "utf8")).toBe("private\n");
});

linuxTest.each(["directory-to-file", "file-to-directory"])("checkpoints a 40-file %s replacement with the projects boundary", async direction => {
  const entry = path.join(user, "replacement");
  const populate = () => {
    mkdirSync(entry);
    for (let index = 0; index < 40; index++) writeFileSync(path.join(entry, `${index}.md`), `file ${index}\n`);
  };
  if (direction === "directory-to-file") populate();
  else writeFileSync(entry, "old regular file\n");
  git(user, "add", "replacement"); git(user, "commit", "-m", "replacement baseline");
  git(user, "push", path.join(remoteRoot, "workspace.git"), "main");
  rmSync(entry, { recursive: true });
  if (direction === "directory-to-file") writeFileSync(entry, "replacement text\n");
  else populate();
  writeFileSync(path.join(user, ":(glob)*.md"), "literal pathspec name\n");
  writeFileSync(path.join(user, "line\nbreak.md"), "NUL-delimited path\n");

  expect((await flush()).status).toBe(200);
  expect(restored("workspace")).toEqual(Buffer.from(personas.workspace));
  const clone = path.join(root, "restored/workspace");
  if (direction === "directory-to-file") expect(readFileSync(path.join(clone, "replacement"), "utf8")).toBe("replacement text\n");
  else for (let index = 0; index < 40; index++) expect(readFileSync(path.join(clone, "replacement", `${index}.md`), "utf8")).toBe(`file ${index}\n`);
  expect(readFileSync(path.join(clone, ":(glob)*.md"), "utf8")).toBe("literal pathspec name\n");
  expect(readFileSync(path.join(clone, "line\nbreak.md"), "utf8")).toBe("NUL-delimited path\n");
  expect(git(clone, "ls-files").split("\n").some(name => name.startsWith("projects/"))).toBe(false);
});

linuxTest("retains local files on remote failure and pushes the existing commit on retry", async () => {
  const remote = path.join(remoteRoot, "demo.git"); const retained = `${remote}.retained`; renameSync(remote, retained);
  expect((await flush()).status).toBe(503);
  expect(readFileSync(path.join(user, "projects/demo/IDENTITY.md"), "utf8")).toBe(personas.demo);
  renameSync(retained, remote);
  expect((await flush()).status).toBe(200);
  expect(restored("demo")).toEqual(Buffer.from(personas.demo));
});

it("refuses missing authentication, another user and changed assignment before Git writes", async () => {
  const before = git(path.join(remoteRoot, "workspace.git"), "rev-parse", "main");
  expect((await flush("alice", "wrong")).status).toBe(401);
  expect((await flush("bob")).status).toBe(503);
  snapshot.gatewayId = "shared-other";
  expect((await flush()).status).toBe(503);
  expect(git(path.join(remoteRoot, "workspace.git"), "rev-parse", "main")).toBe(before);
});

linuxTest("ignores deferred GitHub workspaces and disabled Gitea checkouts", async () => {
  snapshot.projects = [{ projectSlug: "demo", giteaRepoName: "demo", checkoutEnabled: false }, { projectSlug: "deferred", repoSource: { provider: "github", owner: "alice", repo: "deferred" } }];
  const deferred = path.join(user, "projects/deferred"); mkdirSync(deferred); writeFileSync(path.join(deferred, "AGENTS.md"), "deferred\n");
  const before = git(path.join(remoteRoot, "demo.git"), "rev-parse", "main");
  expect((await flush()).status).toBe(200);
  expect(git(path.join(remoteRoot, "demo.git"), "rev-parse", "main")).toBe(before);
  expect(readFileSync(path.join(deferred, "AGENTS.md"), "utf8")).toBe("deferred\n");
});

it.each(["serving", "quiescing"])("User %s flush never commits disabled Native bootstrap files", async state => {
  vi.stubEnv("GATEWAY_CLASS", "isolated");
  vi.stubEnv("GATEWAY_PROFILE", "isolated");
  vi.stubEnv("GATEWAY_ID", "builder-one");
  vi.stubEnv("K8S_SERVICE_ACCOUNT_NAME", "octogee-gw-builder-one");
  reviewed.saName = "octogee-gw-builder-one";
  snapshot.gatewayId = "builder-one";
  installTestUserIdentity(claimedTestUser("alice", "builder-one"));
  assignment.state = state;
  snapshot.projects = [{ projectSlug: "demo", giteaRepoName: "demo", checkoutEnabled: false }];
  writeFileSync(path.join(user, "projects/demo/AGENTS.md"), "Generated after checkout was turned off\n");
  const before = git(path.join(remoteRoot, "demo.git"), "rev-parse", "main");
  const result = await flush();
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ projects: 0 });
  expect(git(path.join(remoteRoot, "demo.git"), "rev-parse", "main")).toBe(before);
  expect(readFileSync(path.join(user, "projects/demo/AGENTS.md"), "utf8")).toBe("Generated after checkout was turned off\n");
});

it.each(["missing", "migrating", "epoch"])("refuses %s canonical assignment custody despite an unchanged user mirror", async mode => {
  let reads = 0;
  broker.mockImplementation(async (url: string) => {
    if (url.endsWith("/uid-for-slug")) return Response.json({ uid: "uid-alice" });
    if (url.endsWith("/user-snapshot")) return Response.json({ user: snapshot });
    if (++reads === 2 && mode === "epoch") assignment.epoch++;
    return Response.json({ assignments: mode === "missing" ? [] : [{ ...assignment, state: mode === "migrating" ? "migrating" : "serving" }] });
  });
  const before = git(path.join(remoteRoot, "workspace.git"), "rev-parse", "main");
  expect((await flush()).status).toBe(503);
  expect(git(path.join(remoteRoot, "workspace.git"), "rev-parse", "main")).toBe(before);
});

linuxTest("refuses a noncanonical project remote without committing its local persona", async () => {
  const metadata = path.join(root, "git-metadata/alice/projects/demo.git");
  const before = git(metadata, "rev-parse", "HEAD");
  git(metadata, "config", "remote.origin.url", "git@foreign:alice/demo.git");
  expect((await flush()).status).toBe(503);
  expect(git(metadata, "rev-parse", "HEAD")).toBe(before);
  expect(readFileSync(path.join(user, "projects/demo/IDENTITY.md"), "utf8")).toBe(personas.demo);
});

it.each(["foreign-gateway", "api", "namespace", "audience", "missing-own"])("refuses %s workload credentials without Git effects", async reason => {
  if (reason === "foreign-gateway") reviewed.saName = "octogee-gw-other";
  if (reason === "api") reviewed.saName = "octogee-api";
  if (reason === "namespace") reviewed.namespace = "octogee";
  if (reason === "audience") reviewed.audiences = ["other"];
  if (reason === "missing-own") vi.stubEnv("K8S_SERVICE_ACCOUNT_NAME", "");
  const before = git(path.join(remoteRoot, "workspace.git"), "rev-parse", "main");
  expect((await flush()).status).toBe(401);
  expect(broker).not.toHaveBeenCalled();
  expect(git(path.join(remoteRoot, "workspace.git"), "rev-parse", "main")).toBe(before);
});

it("does not enable workload authentication for unrelated Shared internal routes", async () => {
  const a = express(); a.post("/unrelated", requireGatewayInternalAuth, (_req, res) => res.sendStatus(204));
  expect((await request(a).post("/unrelated").set("x-k8s-sa-token", "workload-token")).status).toBe(503);
});
