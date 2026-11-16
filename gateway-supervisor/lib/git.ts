import { execFileSync } from "child_process";
import { randomUUID } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import {
  log, GIT_API_URL, GIT_SSH_HOST,
  OPENCLAW_DIR, CUSTOMERS_DIR, CUSTOMER_KEYS_DIR,
} from "./config.js";
import {
  workspaceGiteaOrg, workspaceRepoName, projectRepoName, systemConfigRepoName,
} from "./gitea-naming.js";
import { brokeredGitHost } from "./gitea-admin-broker-client.js";
import { recordServiceGitKeyHolder } from "./service-git-key-holder.js";
import { cloneGithubProjectViaBroker } from "./github-project-clone-broker.js";
import { replaceFileAtomically, seedFileAtomically } from "./atomic-file.js";
import { notesWelcomeSeed } from "@octogee/core/templates/project-seeds";

import { acquireWorkspaceMutationLeaseSync } from "@octogee/core/workspace-mutation-lease";
import { findUnsafeGitMetadataEntry, readGitMetadataText } from "@octogee/core/git-metadata";
import type { ProjectRepoSource } from "@octogee/shared/types/project";
import { isValidUsername } from "@octogee/shared/types/identity";
import { ADD_USER_DEADLINE_MS } from "@octogee/shared/types/fleet-controller";

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function execErrStderr(err: unknown): string {
  return execErrStream(err, "stderr");
}

export function execErrStdout(err: unknown): string {
  return execErrStream(err, "stdout");
}

export function execErrCode(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function execErrStream(err: unknown, stream: "stderr" | "stdout"): string {
  if (
    err &&
    typeof err === "object" &&
    stream in err &&
    typeof (err as Record<string, { toString?: () => string } | undefined>)[stream]?.toString ===
      "function"
  ) {
    return (err as Record<string, { toString: () => string }>)[stream].toString().trim();
  }
  return "";
}

export function userSshKeyPath(slug: string): string {
  return path.join(CUSTOMER_KEYS_DIR, slug, "id_ed25519");
}

export interface UserGitRefreshDeps {
  fetchCanonical?: (repoDir: string, gitDir: string) => void;
  repoSource?: ProjectRepoSource | null;
  giteaRepoName?: string;
  githubToken?: string | null;
}

export function setRepoSshCommand(
  repoDir: string,
  slug: string,
  deps: UserGitRefreshDeps = {},
): void {
  const gitDir = externalizeUserGitDir(repoDir, deps);
  if (gitDir) {
    const identity = userGitIdentity(repoDir);
    if (!identity || identity.slug !== slug || identity.metadataDir !== gitDir) {
      throw new Error(`[git] user repository identity does not match ${repoDir}`);
    }
    writeCanonicalGitConfig(gitDir, slug, canonicalUserGitSource(identity, deps));
    return;
  }
  if (path.resolve(repoDir) === path.resolve(OPENCLAW_DIR, "system_config")) {
    const systemGitDir = trustedGitDir(repoDir);
    if (!systemGitDir) throw new Error(`[git] system config repository metadata is missing for ${repoDir}`);
    writeCanonicalGitConfig(systemGitDir, slug, {
      kind: "gitea",
      repoName: systemConfigRepoName(),
      remoteUrl: sshRemoteUrl(workspaceGiteaOrg(slug), systemConfigRepoName()),
    });
    return;
  }
  removePersistedRepoSshCommand(repoDir);
}

const USER_GIT_METADATA_ROOT = path.join(OPENCLAW_DIR, "git-metadata");
const USER_GIT_TRUST_RECEIPT_VERSION = "octogee-customer-git-v3";
const SAFE_GIT_IDENTITY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SAFE_GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const SAFE_GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/u;
const GIT_BINARY = "/usr/bin/git";
const DISABLED_EXECUTABLE = "/bin/false";

interface UserGitIdentity {
  slug: string;
  repoName: string;
  metadataDir: string;
}

type CanonicalUserGitSource =
  | { kind: "gitea"; repoName: string; remoteUrl: string }
  | { kind: "github"; owner: string; repo: string; remoteUrl: string };

function userGitIdentity(repoDir: string): UserGitIdentity | null {
  const relative = path.relative(path.resolve(CUSTOMERS_DIR), path.resolve(repoDir));
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep);
  const slug = parts[0] ?? "";
  if (!SAFE_GIT_IDENTITY_RE.test(slug)) return null;
  if (parts.length === 1) {
    return {
      slug,
      repoName: workspaceRepoName(),
      metadataDir: path.join(USER_GIT_METADATA_ROOT, slug, "workspace.git"),
    };
  }
  const projectSlug = parts[2] ?? "";
  if (parts.length === 3 && parts[1] === "projects" && SAFE_GIT_IDENTITY_RE.test(projectSlug)) {
    return {
      slug,
      repoName: projectRepoName(projectSlug),
      metadataDir: path.join(USER_GIT_METADATA_ROOT, slug, "projects", `${projectSlug}.git`),
    };
  }
  return null;
}

function userGitMetadataDir(repoDir: string): string | null {
  return userGitIdentity(repoDir)?.metadataDir ?? null;
}

function githubSource(repoSource: ProjectRepoSource): CanonicalUserGitSource {
  if (!SAFE_GITHUB_OWNER_RE.test(repoSource.owner) || !SAFE_GITHUB_REPO_RE.test(repoSource.repo)) {
    throw new Error("[git] invalid GitHub repository source");
  }
  return {
    kind: "github",
    owner: repoSource.owner,
    repo: repoSource.repo,
    remoteUrl: githubHttpsRemoteUrl(repoSource.owner, repoSource.repo),
  };
}

function giteaSource(slug: string, repoName: string): CanonicalUserGitSource {
  if (!SAFE_GIT_IDENTITY_RE.test(repoName)) throw new Error("[git] invalid Gitea repository name");
  return {
    kind: "gitea",
    repoName,
    remoteUrl: sshRemoteUrl(workspaceGiteaOrg(slug), repoName),
  };
}

function canonicalUserGitSource(
  identity: UserGitIdentity,
  deps: UserGitRefreshDeps,
): CanonicalUserGitSource {
  if (deps.repoSource?.provider === "github") return githubSource(deps.repoSource);
  if (deps.giteaRepoName) return giteaSource(identity.slug, deps.giteaRepoName);
  return trustedUserGitSource(identity) ?? giteaSource(identity.slug, identity.repoName);
}

function sourceReceiptValue(source: CanonicalUserGitSource): string {
  return source.kind === "github"
    ? `github:${source.owner}/${source.repo}`
    : `gitea:${source.repoName}`;
}

function sourceFromReceipt(
  identity: UserGitIdentity,
  receipt: string,
): CanonicalUserGitSource | null {
  const lines = receipt.split("\n");
  if (lines.length !== 3 || lines[0] !== USER_GIT_TRUST_RECEIPT_VERSION || lines[2] !== "") return null;
  const source = lines[1] ?? "";
  if (source.startsWith("gitea:")) {
    const repoName = source.slice("gitea:".length);
    return SAFE_GIT_IDENTITY_RE.test(repoName) ? giteaSource(identity.slug, repoName) : null;
  }
  if (source.startsWith("github:")) {
    const [owner, repo, extra] = source.slice("github:".length).split("/");
    if (!owner || !repo || extra) return null;
    return githubSource({ provider: "github", owner, repo });
  }
  return null;
}

function writeCanonicalGitConfig(
  gitDir: string,
  slug: string,
  source: CanonicalUserGitSource,
): void {
  const configPath = path.join(gitDir, "config");
  const configTmp = `${configPath}.octogee.tmp`;
  const contents = [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = false",
    "\tlogallrefupdates = true",
    "[user]",
    `\temail = ${slug}@octogee.com`,
    `\tname = Octo (${slug})`,
    '[remote "origin"]',
    `\turl = ${source.remoteUrl}`,
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    '[branch "main"]',
    "\tremote = origin",
    "\tmerge = refs/heads/main",
    "",
  ].join("\n");
  fs.writeFileSync(configTmp, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(configTmp, configPath);
}

function userGitTrustReceipt(target: string): string {
  return `${target}.octogee-trusted-v3`;
}

function userGitRefreshMarker(target: string): string {
  return `${target}.octogee-refresh-required`;
}

function moveQuarantinedGitEntry(source: string, target: string, sourceDevice = fs.lstatSync(source).dev): void {
  if (sourceDevice === fs.statSync(path.dirname(target)).dev) {
    fs.renameSync(source, target);
  } else {
    try {
      fs.lstatSync(target);
      throw new Error("Git quarantine target already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      fs.cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    } catch (error) {
      try { fs.rmSync(target, { recursive: true, force: true }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Git quarantine copy and partial-copy cleanup failed"); }
      throw error;
    }
    fs.rmSync(source, { recursive: true });
  }
}

function quarantineUserGitEntry(source: string, identity: UserGitIdentity): void {
  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.lstatSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const quarantineRoot = path.join(OPENCLAW_DIR, "git-metadata-quarantine", identity.slug);
  fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  const quarantine = path.join(
    quarantineRoot,
    `${path.basename(identity.metadataDir)}-${randomUUID()}`,
  );
  moveQuarantinedGitEntry(source, quarantine, sourceStat.dev);
  const stat = fs.lstatSync(quarantine);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    const stack = [quarantine];
    while (stack.length > 0) {
      const current = stack.pop()!;
      fs.chmodSync(current, 0o700);
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const child = path.join(current, entry.name);
        const childStat = fs.lstatSync(child);
        if (childStat.isSymbolicLink()) continue;
        if (childStat.isDirectory()) stack.push(child);
        else fs.chmodSync(child, 0o600);
      }
    }
  } else {
    fs.chmodSync(quarantine, 0o600);
  }
}

function userGitEnvironmentForRefresh(
  slug: string,
  githubToken?: string | null,
): NodeJS.ProcessEnv {
  return {
    ...sanitizedGitProcessEnvironment(),
    ...githubCloneCredentialEnv(githubToken),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: DISABLED_EXECUTABLE,
    SSH_ASKPASS: DISABLED_EXECUTABLE,
    GIT_EDITOR: DISABLED_EXECUTABLE,
    GIT_SEQUENCE_EDITOR: DISABLED_EXECUTABLE,
    GIT_PAGER: "cat",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_SSH_COMMAND: `/usr/bin/ssh -i "${userSshKeyPath(slug)}" -F /home/node/.ssh/config -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`,
  };
}

function runFreshUserGit(
  repoDir: string,
  gitDir: string,
  slug: string,
  argv: string[],
  githubToken?: string | null,
): string {
  return execFileSync(
    GIT_BINARY,
    [
      ...gitHardeningArgs(),
      ...githubCredentialArgs(githubToken),
      "--git-dir",
      gitDir,
      "--work-tree",
      repoDir,
      ...argv,
    ],
    {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: userGitEnvironmentForRefresh(slug, githubToken),
    },
  ).trim();
}

function initializeFreshUserGit(
  repoDir: string,
  identity: UserGitIdentity,
  deps: UserGitRefreshDeps,
): void {
  const source = canonicalUserGitSource(identity, deps);
  const staging = `${identity.metadataDir}.octogee-new-${randomUUID()}`;
  fs.mkdirSync(path.dirname(identity.metadataDir), { recursive: true, mode: 0o700 });
  try {
    execFileSync(
      GIT_BINARY,
      ["init", "--bare", "--initial-branch=main", staging],
      {
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: userGitEnvironmentForRefresh(identity.slug, deps.githubToken),
      },
    );
    writeCanonicalGitConfig(staging, identity.slug, source);
    if (deps.fetchCanonical) deps.fetchCanonical(repoDir, staging);
    else runFreshUserGit(repoDir, staging, identity.slug, [
      "fetch",
      "--prune",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
    ], deps.githubToken);
    const remoteMain = runFreshUserGit(
      repoDir,
      staging,
      identity.slug,
      ["for-each-ref", "--format=%(objectname)", "refs/remotes/origin/main"],
      deps.githubToken,
    );
    runFreshUserGit(
      repoDir,
      staging,
      identity.slug,
      ["symbolic-ref", "HEAD", "refs/heads/main"],
      deps.githubToken,
    );
    if (remoteMain) {
      runFreshUserGit(
        repoDir,
        staging,
        identity.slug,
        ["update-ref", "refs/heads/main", remoteMain],
        deps.githubToken,
      );
      runFreshUserGit(
        repoDir,
        staging,
        identity.slug,
        ["read-tree", "refs/heads/main"],
        deps.githubToken,
      );
    } else {
      runFreshUserGit(
        repoDir,
        staging,
        identity.slug,
        ["read-tree", "--empty"],
        deps.githubToken,
      );
    }
    fs.renameSync(staging, identity.metadataDir);
    const receipt = userGitTrustReceipt(identity.metadataDir);
    const receiptTmp = `${receipt}.octogee.tmp`;
    fs.writeFileSync(receiptTmp, `${USER_GIT_TRUST_RECEIPT_VERSION}\n${sourceReceiptValue(source)}\n`, { encoding: "utf8", mode: 0o400 });
    fs.renameSync(receiptTmp, receipt);
    fs.rmSync(userGitRefreshMarker(identity.metadataDir), { force: true });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function trustedUserGitSource(identity: UserGitIdentity): CanonicalUserGitSource | null {
  const receipt = userGitTrustReceipt(identity.metadataDir);
  try {
    const targetStat = fs.lstatSync(identity.metadataDir);
    if (!targetStat.isDirectory()) return null;
    const contents = readGitMetadataText(receipt, 1024);
    return contents === null ? null : sourceFromReceipt(identity, contents);
  } catch {
    return null;
  }
}

export function userRepositoryHasCanonicalRemote(repoDir: string): boolean {
  const identity = userGitIdentity(repoDir);
  if (!identity) return false;
  const source = trustedUserGitSource(identity);
  if (!source) return false;
  const localGit = path.join(repoDir, ".git");
  const configPath = path.join(identity.metadataDir, "config");
  try {
    if (findUnsafeGitMetadataEntry(identity.metadataDir, USER_GIT_METADATA_ROOT)) return false;
    const pointer = `gitdir: ${identity.metadataDir}\n`;
    if (readGitMetadataText(localGit, Buffer.byteLength(pointer)) !== pointer) return false;
    if (!fs.lstatSync(configPath).isFile()) return false;
    const remoteUrl = execFileSync(
      GIT_BINARY,
      ["config", "--file", configPath, "--get", "remote.origin.url"],
      {
        cwd: repoDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    ).trim();
    return remoteUrl === source.remoteUrl;
  } catch {
    return false;
  }
}

function currentUserGitPointer(filename: string, pointer: string): boolean {
  return readGitMetadataText(filename, Buffer.byteLength(pointer), { requireReadOnly: true }) === pointer;
}

export function externalizeUserGitDir(
  repoDir: string,
  deps: UserGitRefreshDeps = {},
): string | null {
  const identity = userGitIdentity(repoDir);
  if (!identity) return null;
  fs.mkdirSync(repoDir, { recursive: true, mode: 0o700 });
  const target = identity.metadataDir;
  const localGit = path.join(repoDir, ".git");
  const expectedSource = canonicalUserGitSource(identity, deps);
  const trustedSource = trustedUserGitSource(identity);
  if (trustedSource) {
    const unsafeEntry = findUnsafeGitMetadataEntry(target, USER_GIT_METADATA_ROOT);
    if (unsafeEntry) throw new Error(`[git] unsafe user Git metadata: ${unsafeEntry}`);
  }
  if (!trustedSource || sourceReceiptValue(trustedSource) !== sourceReceiptValue(expectedSource)) {
    const refreshMarker = userGitRefreshMarker(target);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    replaceFileAtomically(refreshMarker, `${USER_GIT_TRUST_RECEIPT_VERSION}\n`, 0o400);
    quarantineUserGitEntry(target, identity);
    quarantineUserGitEntry(userGitTrustReceipt(target), identity);
    quarantineUserGitEntry(localGit, identity);
    initializeFreshUserGit(repoDir, identity, deps);
  }
  fs.rmSync(userGitRefreshMarker(target), { force: true });
  const pointer = `gitdir: ${target}\n`;
  if (currentUserGitPointer(localGit, pointer)) return target;
  publishUserGitPointer(repoDir);
  return target;
}

function publishUserGitPointer(repoDir: string): void {
  const target = userGitMetadataDir(repoDir);
  if (!target) throw new Error(`[git] user Git pointer owner is missing for ${repoDir}`);
  const localGit = path.join(repoDir, ".git");
  const pointer = `gitdir: ${target}\n`;
  replaceFileAtomically(localGit, pointer, 0o444);
}

function trustedGitDir(cwd: string): string | null {
  const userMetadata = userGitMetadataDir(cwd);
  if (userMetadata) return userMetadata;
  const localGit = path.join(cwd, ".git");
  try {
    const stat = fs.lstatSync(localGit);
    return stat.isDirectory() && !stat.isSymbolicLink() ? localGit : null;
  } catch {
    return null;
  }
}

function repositoryMetadataExists(repoDir: string): boolean {
  const userMetadata = userGitMetadataDir(repoDir);
  const candidates = [
    userMetadata,
    ...(userMetadata ? [userGitRefreshMarker(userMetadata)] : []),
    path.join(repoDir, ".git"),
  ]
    .filter((candidate): candidate is string => candidate !== null);
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile())) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function projectCheckoutMatchesSource(
  slug: string,
  projectSlug: string,
  giteaRepoName: string,
  repoSource?: ProjectRepoSource | null,
): boolean {
  const repoDir = path.join(CUSTOMERS_DIR, slug, "projects", projectSlug);
  if (!repositoryMetadataExists(repoDir)) return false;
  const identity = userGitIdentity(repoDir);
  if (!identity) return false;
  const current = trustedUserGitSource(identity);
  if (!current) return false;
  const expected = canonicalUserGitSource(identity, { giteaRepoName, repoSource });
  return sourceReceiptValue(current) === sourceReceiptValue(expected);
}

export function removePersistedRepoSshCommand(repoDir: string): void {
  const gitDir = trustedGitDir(repoDir);
  if (!gitDir) return;
  try {
    execFileSync(
      GIT_BINARY,
      ["config", "--file", path.join(gitDir, "config"), "--unset-all", "core.sshCommand"],
      { cwd: repoDir, stdio: ["ignore", "ignore", "ignore"] },
    );
  } catch (error) {
    if (execErrCode(error) !== 5) {
      log(`⚠ [git] failed to remove persisted core.sshCommand in ${repoDir}`);
    }
  }
}

export function generateUserSshKey(slug: string): string {
  if (!isValidUsername(slug)) throw new Error("Invalid SSH key owner");
  const keyDir = path.join(CUSTOMER_KEYS_DIR, slug);
  const keyPath = path.join(keyDir, "id_ed25519");
  const pubPath = keyPath + ".pub";

  if (fs.existsSync(keyPath)) {
    restrictUserSshKeyModes(keyDir, keyPath, pubPath);
    log(`[git] SSH key already exists for ${slug}`);
    return fs.readFileSync(pubPath, "utf-8").trim();
  }

  const pubKey = generateKeyPair(keyDir, slug);
  log(`[git] SSH keypair generated for ${slug}`);
  return pubKey;
}

function generateKeyPair(keyDir: string, slug: string): string {
  const keyPath = path.join(keyDir, "id_ed25519");
  const pubPath = keyPath + ".pub";
  fs.mkdirSync(keyDir, { recursive: true });
  execFileSync("/usr/bin/ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", `octogee-${slug}@gateway`, "-q"], {
    stdio: "pipe",
  });
  restrictUserSshKeyModes(keyDir, keyPath, pubPath);
  return fs.readFileSync(pubPath, "utf-8").trim();
}

function restrictUserSshKeyModes(keyDir: string, keyPath: string, pubPath: string): void {
  /* eslint-disable sonarjs/file-permissions -- restrictive (private key dir), correct */
  fs.chmodSync(keyDir, 0o700);
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(pubPath, 0o644);
  /* eslint-enable sonarjs/file-permissions */
}

export interface PreparedServiceGitKey {
  publicKey: string;
  registered: () => void;
}

export function prepareServiceGitKey(slug: string, holder: string): PreparedServiceGitKey {
  if (!isValidUsername(slug)) throw new Error("Invalid SSH key owner");
  if (!holder) throw new Error("A service git key needs the holder");
  const keyDir = path.join(CUSTOMER_KEYS_DIR, slug);
  const keyPath = path.join(keyDir, "id_ed25519");
  const registered = () => recordServiceGitKeyHolder(slug, holder);
  if (fs.existsSync(keyPath)) {
    const onDisk = readLocalUserPubKey(slug);
    if (onDisk === null) throw new Error(`[git] ${slug}: a private key is on disk but its public key cannot be read; leaving it in place`);
    restrictUserSshKeyModes(keyDir, keyPath, `${keyPath}.pub`);
    return { publicKey: onDisk, registered };
  }
  if (fs.existsSync(keyDir)) {
    fs.rmSync(keyDir, { recursive: true, force: true });
    log(`[git] ${slug}: the key directory held no private key; replaced it. The registration that follows under this pod's holder replaces whatever it had registered`);
  }
  const publicKey = generateKeyPair(keyDir, slug);
  log(`[git] ${slug}: generated a key for registration through the provisioning service`);
  return { publicKey, registered };
}

export function readLocalUserPubKey(slug: string): string | null {
  const pubPath = path.join(CUSTOMER_KEYS_DIR, slug, "id_ed25519.pub");
  try {
    return fs.readFileSync(pubPath, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export interface LocalUserPubKey {
  slug: string;
  pubKey: string;
}

export function listLocalUserPubKeys(): LocalUserPubKey[] {
  if (!fs.existsSync(CUSTOMER_KEYS_DIR)) return [];
  return fs.readdirSync(CUSTOMER_KEYS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const pubKey = readLocalUserPubKey(entry.name);
      if (pubKey === null) {
        throw new Error(`[git] local SSH public key is missing for ${entry.name}`);
      }
      return { slug: entry.name, pubKey };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function sshRemoteUrl(org: string, repoName: string): string {
  return `git@${GIT_SSH_HOST}:${org}/${repoName}.git`;
}

function githubHttpsRemoteUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

export function gitExec(
  cwd: string,
  argv: string[],
  sshKeyPath?: string,
  githubToken?: string | null,
): string | null {
  try {
    const command = argv[0];
    if (command !== "config" && command !== "init" && command !== "clone") {
      const unsafeConfigKey = unsafeLocalRepositoryConfigKey(cwd);
      if (unsafeConfigKey) {
        log(`⚠ [git] refusing repository with unsafe local config: ${unsafeConfigKey}`);
        return null;
      }
    }
    const env: Record<string, string | undefined> = {
      ...sanitizedGitProcessEnvironment(),
      ...githubCloneCredentialEnv(githubToken),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: DISABLED_EXECUTABLE,
      SSH_ASKPASS: DISABLED_EXECUTABLE,
      GIT_EDITOR: DISABLED_EXECUTABLE,
      GIT_SEQUENCE_EDITOR: DISABLED_EXECUTABLE,
      GIT_PAGER: "cat",
      GIT_PROTOCOL_FROM_USER: "0",
      GIT_OPTIONAL_LOCKS: "0",
    };
    const userIdentity = userGitIdentity(cwd);
    const effectiveSshKeyPath = sshKeyPath ?? (
      userIdentity ? userSshKeyPath(userIdentity.slug) : undefined
    );
    if (effectiveSshKeyPath) {
      env.GIT_SSH_COMMAND = `ssh -i "${effectiveSshKeyPath}" -F /home/node/.ssh/config -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`;
    }
    const gitDir = trustedGitDir(cwd);
    const repositoryArgs = gitDir && !["config", "init", "clone"].includes(command ?? "")
      ? ["--git-dir", gitDir, "--work-tree", cwd]
      : [];
    return execFileSync(GIT_BINARY, [
      ...gitHardeningArgs(),
      ...githubCredentialArgs(githubToken),
      ...repositoryArgs,
      ...argv,
    ], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env,
    }).trim();
  } catch (err: unknown) {
    const detail =
      [execErrStderr(err), execErrStdout(err)].filter(Boolean).join(" | ") || errMessage(err);
    const code = execErrCode(err);
    const safeArgs = argv.join(" ").replace(/x-access-token:[^\s@]+/g, "x-access-token:***");
    const safeDetail = detail.replace(/x-access-token:[^\s@]+/g, "x-access-token:***");
    log(`⚠ [git] exec failed: git ${safeArgs} → code=${code ?? "?"} ${safeDetail}`);
    return null;
  }
}

const GIT_HARDENING_ARGS = [
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "core.hooksPath=/dev/null",
  "-c", "credential.helper=",
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
  "-c", `gpg.program=${DISABLED_EXECUTABLE}`,
  "-c", "protocol.allow=never",
  "-c", "protocol.ssh.allow=always",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.file.allow=never",
  "-c", "protocol.ext.allow=never",
] as const;

function gitHardeningArgs(): string[] {
  return [...GIT_HARDENING_ARGS];
}

const UNSAFE_LOCAL_CONFIG_PREFIXES = [
  "alias.", "credential.", "diff.", "filter.", "http.", "https.",
  "include.", "includeif.", "merge.", "protocol.", "url.",
];
const UNSAFE_LOCAL_CONFIG_KEYS = new Set([
  "core.askpass", "core.editor", "core.fsmonitor", "core.gitproxy",
  "core.hookspath", "core.pager", "core.sshcommand", "core.worktree",
  "extensions.worktreeconfig", "gpg.program", "sequence.editor", "ssh.variant",
]);

function isUnsafeLocalConfigKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return UNSAFE_LOCAL_CONFIG_KEYS.has(normalized)
    || UNSAFE_LOCAL_CONFIG_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function unsafeLocalRepositoryConfigKey(cwd: string): string | null {
  const gitDir = trustedGitDir(cwd);
  if (!gitDir) return null;
  const configPath = path.join(gitDir, "config");
  try {
    if (userGitIdentity(cwd)) {
      const unsafeEntry = findUnsafeGitMetadataEntry(gitDir, USER_GIT_METADATA_ROOT);
      if (unsafeEntry) return `<unsafe-metadata:${unsafeEntry}>`;
    }
    if (!fs.existsSync(configPath)) return null;
    const output = execFileSync(
      GIT_BINARY,
      ["config", "--file", configPath, "--null", "--name-only", "--list"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    return output.split("\0").find(isUnsafeLocalConfigKey) ?? null;
  } catch {
    return "<malformed>";
  }
}

// Workspace + project clones run over the per-user SSH key. The key is
// registered (registerKey) before any clone in the mount flow, so there is
// no admin-token HTTP fallback: a missing key is a loud failure the reconcile
// heals by regenerating + re-registering. Repo existence is checked through the
// admin broker (no admin token on this container).
export interface WorkspaceTreeState {
  tracked: number;
  missing: number;
}

export function workspaceTreeState(repoDir: string): WorkspaceTreeState | null {
  const listed = gitExec(repoDir, ["ls-files", "-z"]);
  if (listed === null) return null;
  const tracked = listed.split("\0").filter((entry) => entry.length > 0);
  let missing = 0;
  for (const entry of tracked) {
    try {
      fs.lstatSync(path.join(repoDir, entry));
    } catch {
      missing += 1;
    }
  }
  return { tracked: tracked.length, missing };
}

function restoreEmptiedWorkspaceTree(dest: string, slug: string): boolean | null {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const state = workspaceTreeState(dest);
  if (state === null) {
    log(`⚠ [git] ${slug} workspace has git metadata that git cannot read — refusing to treat it as cloned`);
    return null;
  }
  if (state.tracked === 0 || state.missing < state.tracked) return false;
  if (gitExec(dest, ["checkout", "--", "."]) === null) {
    log(`⚠ [git] ${slug} workspace tree is empty and could not be restored from its checkout`);
    return null;
  }
  log(`[git] ${slug} workspace tree was empty — restored ${state.tracked} tracked file(s) from the checkout`);
  return true;
}

const WORKSPACE_PROJECTS_ENTRY = "projects";

export async function removePartialWorkspace(slug: string): Promise<void> {
  const dir = path.join(CUSTOMERS_DIR, slug);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name === WORKSPACE_PROJECTS_ENTRY && entry.isDirectory()) continue;
    await fs.promises.rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

function cloneWorkspaceIntoNewDir(dest: string, slug: string, remote: string, sshKey: string): boolean {
  if (gitExec(path.dirname(dest), ["clone", remote, slug], sshKey) !== null) return true;
  log(`⚠ [git] Clone failed for ${slug}`);
  fs.rmSync(dest, { recursive: true, force: true });
  return false;
}

function cloneWorkspaceIntoExistingDir(dest: string, slug: string, remote: string, sshKey: string): boolean {
  const staging = path.join(dest, `.workspace-clone-${randomUUID()}`);
  try {
    if (gitExec(dest, ["clone", remote, path.basename(staging)], sshKey) === null) {
      log(`⚠ [git] Clone failed for ${slug}`);
      return false;
    }
    const entries = fs.readdirSync(staging).filter((entry) => entry !== ".git");
    const collision = entries.find((entry) => fs.existsSync(path.join(dest, entry)));
    if (collision) {
      log(`⚠ [git] Clone for ${slug} would overwrite existing workspace entry ${collision}`);
      return false;
    }
    for (const entry of [...entries, ".git"]) fs.renameSync(path.join(staging, entry), path.join(dest, entry));
    return true;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export async function cloneWorkspaceRepo(slug: string, _repoUrl?: string): Promise<boolean> {
  const dest = path.join(CUSTOMERS_DIR, slug);

  if (repositoryMetadataExists(dest)) {
    if (restoreEmptiedWorkspaceTree(dest, slug) === null) return false;
    setRepoSshCommand(dest, slug);
    return true;
  }

  const org = workspaceGiteaOrg(slug);
  const repoName = workspaceRepoName();
  const sshKey = userSshKeyPath(slug);
  if (!fs.existsSync(sshKey)) {
    log(`⚠ [git] Cannot clone ${slug} — per-user SSH key missing (registered before clone in the mount flow)`);
    return false;
  }

  let exists: boolean;
  try {
    exists = await brokeredGitHost.repoExists({ owner: org, repo: repoName });
  } catch (err: unknown) {
    log(`⚠ [git] Gitea repo-exists check failed for ${org}/${repoName}: ${errMessage(err)}`);
    return false;
  }
  if (!exists) {
    log(`[git] Repo ${org}/${repoName} not found on Gitea — skipping clone`);
    return false;
  }

  const remote = sshRemoteUrl(org, repoName);
  const cloned = fs.existsSync(dest)
    ? cloneWorkspaceIntoExistingDir(dest, slug, remote, sshKey)
    : cloneWorkspaceIntoNewDir(dest, slug, remote, sshKey);
  if (!cloned) return false;

  gitExec(dest, ["config", "user.email", `${slug}@octogee.com`]);
  gitExec(dest, ["config", "user.name", `Octo (${slug})`]);

  setRepoSshCommand(dest, slug);

  log(`[git] ✅ Cloned ${org}/${repoName} → customers/${slug}/`);
  return true;
}

export interface CloneProjectRepoOptions {
  repoSource?: ProjectRepoSource | null;
  refreshRemote?: boolean;
  refreshLeaseDeadlineMs?: number;
  signal?: AbortSignal;
  githubToken?: string | null;
  gitExec?: GitRunner;
  prepareRepository?: typeof setRepoSshCommand;
  acquireMutationLease?: typeof acquireWorkspaceMutationLeaseSync;
}

export async function cloneProjectRepo(
  slug: string,
  projectSlug: string,
  giteaRepoName: string,
  opts: CloneProjectRepoOptions = {},
): Promise<boolean> {
  const dest = path.join(CUSTOMERS_DIR, slug, "projects", projectSlug);

  if (repositoryMetadataExists(dest)) {
    if (!existingProjectGitDir(dest)) {
      return restoreMissingProjectGitMetadata(slug, projectSlug, dest, giteaRepoName, opts);
    }
    if (!projectCheckoutMatchesSource(slug, projectSlug, giteaRepoName, opts.repoSource)) {
      if (githubCloneIsBrokered(opts.repoSource, opts.githubToken)) {
        return switchProjectCheckoutViaBroker(slug, projectSlug, dest, opts.repoSource!, opts);
      }
      return replaceProjectRepoCheckout(slug, projectSlug, dest, giteaRepoName, opts);
    }
    if (!restoreProjectCheckoutTree(dest, slug, {
      repoSource: opts.repoSource,
      giteaRepoName,
      githubToken: opts.githubToken,
    })) return false;
    if (!projectCheckoutMatchesSource(slug, projectSlug, giteaRepoName, opts.repoSource)
      || !userRepositoryHasCanonicalRemote(dest)) return false;
    return refreshProjectCheckout(slug, projectSlug, dest, opts);
  }

  if (opts.repoSource?.provider === "github") {
    return cloneGithubProjectRepo(
      slug,
      projectSlug,
      dest,
      opts.repoSource,
      opts.githubToken,
      opts.gitExec ?? gitExec,
      opts.prepareRepository ?? setRepoSshCommand,
    );
  }
  return cloneGiteaProjectRepo(
    slug,
    projectSlug,
    dest,
    giteaRepoName,
    opts.gitExec ?? gitExec,
    opts.prepareRepository ?? setRepoSshCommand,
  );
}

function restoreProjectCheckoutTree(dest: string, slug: string, deps: UserGitRefreshDeps): boolean {
  const restored = restoreEmptiedWorkspaceTree(dest, `${slug}/${path.basename(dest)}`);
  if (restored === null) return false;
  setRepoSshCommand(dest, slug, deps);
  if (restored) publishUserGitPointer(dest);
  return true;
}

function gitDiffPaths(raw: string): string[] {
  return raw.split("\0").filter((_part, index) => index % 2 === 1);
}

function stageAlreadyCommittedProjectEdits(run: (args: string[]) => string | null): string[] | null {
  const unstaged = run(["diff", "--raw", "-z", "--no-renames"]);
  const staged = run(["diff", "--cached", "--raw", "-z", "--no-renames"]);
  if (unstaged === null || staged === null) return null;
  const stagedPaths = new Set(gitDiffPaths(staged));
  const committedPaths: string[] = [];
  for (const filePath of gitDiffPaths(unstaged)) {
    if (stagedPaths.has(filePath)) continue;
    const upstreamDifference = run([
      "--literal-pathspecs", "diff", "--raw", "-z", "--no-renames", "@{upstream}", "--", filePath,
    ]);
    if (upstreamDifference === null) return null;
    if (upstreamDifference === "") committedPaths.push(filePath);
  }
  if (committedPaths.length > 0
    && run(["--literal-pathspecs", "add", "--update", "--", ...committedPaths]) === null) return null;
  return committedPaths;
}

async function acquireProjectRefreshLease(
  slug: string,
  projectSlug: string,
  dest: string,
  opts: CloneProjectRepoOptions,
): Promise<ReturnType<typeof acquireWorkspaceMutationLeaseSync>> {
  const acquire = () => acquireProjectSourceSwitchLease(
    opts.acquireMutationLease ?? acquireWorkspaceMutationLeaseSync,
    dest,
    slug,
    projectSlug,
  );
  const deadline = opts.refreshLeaseDeadlineMs ?? performance.now() + ADD_USER_DEADLINE_MS;
  opts.signal?.throwIfAborted();
  let lease = acquire();
  while (!lease) {
    opts.signal?.throwIfAborted();
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      return null;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(100, remainingMs)));
    opts.signal?.throwIfAborted();
    if (performance.now() >= deadline) return null;
    lease = acquire();
  }
  return lease;
}

async function refreshProjectCheckout(
  slug: string,
  projectSlug: string,
  dest: string,
  opts: CloneProjectRepoOptions,
): Promise<boolean> {
  if (!opts.refreshRemote) return true;
  const lease = await acquireProjectRefreshLease(slug, projectSlug, dest, opts);
  if (!lease) {
    log(`⚠ [git] Cannot refresh ${slug}/${projectSlug} — project mutation lease is unavailable at the preparation deadline`);
    return false;
  }
  try {
    opts.signal?.throwIfAborted();
    const run = (args: string[]) => (opts.gitExec ?? gitExec)(
      dest, args, userSshKeyPath(slug), opts.githubToken,
    );
    if (run(["fetch", "--no-tags", "origin"]) === null) return false;
    const remoteMain = run(["for-each-ref", "--format=%(objectname)", "refs/remotes/origin/main"]);
    if (remoteMain === null) return false;
    if (!remoteMain) return true;
    const committedPaths = stageAlreadyCommittedProjectEdits(run);
    if (committedPaths === null) return false;
    if (run(["merge", "--ff-only", "--no-edit", "@{upstream}"]) === null) {
      if (committedPaths.length > 0
        && run(["--literal-pathspecs", "restore", "--staged", "--source=HEAD", "--", ...committedPaths]) === null) {
        throw new Error(`[git] Cannot restore ${slug}/${projectSlug} index after refused refresh`);
      }
      log(`⚠ [git] Cannot refresh ${slug}/${projectSlug} without overwriting local project work`);
      return false;
    }
    return true;
  } finally {
    lease.release();
  }
}

function restoreMissingProjectGitMetadata(
  slug: string,
  projectSlug: string,
  dest: string,
  giteaRepoName: string,
  opts: CloneProjectRepoOptions,
): boolean {
  try {
    (opts.prepareRepository ?? setRepoSshCommand)(dest, slug, {
      repoSource: opts.repoSource,
      giteaRepoName,
      githubToken: opts.githubToken,
    });
  } catch (error) {
    log(`⚠ [git] Cannot restore ${slug}/${projectSlug} metadata: ${errMessage(error)}`);
    return false;
  }
  if (
    !projectCheckoutMatchesSource(slug, projectSlug, giteaRepoName, opts.repoSource)
    || !userRepositoryHasCanonicalRemote(dest)
  ) {
    log(`⚠ [git] Cannot restore ${slug}/${projectSlug} metadata — canonical source verification failed`);
    return false;
  }
  log(`[git] ✅ Restored ${slug}/${projectSlug} canonical metadata`);
  return true;
}

function projectCloneStaging(parent: string, projectSlug: string): string {
  const state = path.join(parent, ".octogee-state");
  try {
    fs.mkdirSync(state, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!fs.lstatSync(state).isDirectory()) throw new Error("project state is not a directory");
  return fs.mkdtempSync(path.join(state, `${projectSlug}-clone-`));
}

// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- source switching is a rollback-capable filesystem state machine
async function replaceProjectRepoCheckout(
  slug: string,
  projectSlug: string,
  dest: string,
  giteaRepoName: string,
  opts: CloneProjectRepoOptions,
): Promise<boolean> {
  const runGit = opts.gitExec ?? gitExec;
  const source = opts.repoSource?.provider === "github"
    ? githubSource(opts.repoSource)
    : giteaSource(slug, giteaRepoName);
  const sshKey = source.kind === "gitea" ? userSshKeyPath(slug) : undefined;
  if (source.kind === "gitea") {
    if (!fs.existsSync(sshKey!)) {
      log(`⚠ [git] Cannot switch ${slug}/${projectSlug} — per-user SSH key missing`);
      return false;
    }
    if (!(await brokeredGitHost.repoExists({ owner: workspaceGiteaOrg(slug), repo: giteaRepoName }))) return false;
  }

  const parent = path.dirname(dest);
  const staging = projectCloneStaging(parent, projectSlug);
  const clone = runGit(
    parent,
    ["clone", source.remoteUrl, staging],
    sshKey,
    opts.githubToken,
  );
  if (clone === null) {
    fs.rmSync(staging, { recursive: true, force: true });
    return false;
  }

  const gitDir = existingProjectGitDir(dest);
  if (!gitDir) {
    fs.rmSync(staging, { recursive: true, force: true });
    log(`⚠ [git] Cannot switch ${slug}/${projectSlug} — git metadata is missing`);
    return false;
  }
  let lease: ReturnType<typeof acquireWorkspaceMutationLeaseSync>;
  try {
    lease = acquireProjectSourceSwitchLease(
      opts.acquireMutationLease ?? acquireWorkspaceMutationLeaseSync,
      dest,
      slug,
      projectSlug,
    );
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    log(`⚠ [git] Cannot lease ${slug}/${projectSlug}: ${errMessage(error)}`);
    return false;
  }
  if (!lease) {
    fs.rmSync(staging, { recursive: true, force: true });
    return false;
  }
  const quarantineRoot = path.join(OPENCLAW_DIR, "git-worktree-quarantine", slug);
  const quarantine = path.join(quarantineRoot, `${projectSlug}-${randomUUID()}`);
  const metadataBackupRoot = path.join(
    OPENCLAW_DIR,
    "git-metadata-source-switch-backups",
    slug,
    `${projectSlug}-${randomUUID()}`,
  );
  const identity = userGitIdentity(dest);
  const metadataBackups: Array<{ original: string; backup: string }> = [];
  let previousMoved = false;
  let replacementInstalled = false;
  try {
    fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(metadataBackupRoot, { recursive: true, mode: 0o700 });
    if (identity) {
      for (const original of [
        identity.metadataDir,
        userGitTrustReceipt(identity.metadataDir),
        userGitRefreshMarker(identity.metadataDir),
      ]) {
        if (!fs.existsSync(original)) continue;
        const backup = path.join(metadataBackupRoot, path.basename(original));
        fs.renameSync(original, backup);
        metadataBackups.push({ original, backup });
      }
    }
    moveQuarantinedGitEntry(dest, quarantine);
    previousMoved = true;
    fs.renameSync(staging, dest);
    replacementInstalled = true;
    (opts.prepareRepository ?? setRepoSshCommand)(dest, slug, {
      repoSource: opts.repoSource,
      giteaRepoName,
      githubToken: opts.githubToken,
    });
    if (
      !projectCheckoutMatchesSource(slug, projectSlug, giteaRepoName, opts.repoSource)
      || !userRepositoryHasCanonicalRemote(dest)
    ) {
      throw new Error("replacement repository source was not prepared canonically");
    }
    log(`[git] ✅ Switched ${slug}/${projectSlug} to ${sourceReceiptValue(source)}`);
    return true;
  } catch (error) {
    if (replacementInstalled && fs.existsSync(dest)) {
      try {
        moveQuarantinedGitEntry(dest, path.join(quarantineRoot, `${projectSlug}-failed-${randomUUID()}`));
      } catch (rollbackError) {
        log(`⚠ [git] Failed to quarantine replacement for ${slug}/${projectSlug}: ${errMessage(rollbackError)}`);
      }
    }
    if (identity) {
      for (const current of [
        identity.metadataDir,
        userGitTrustReceipt(identity.metadataDir),
        userGitRefreshMarker(identity.metadataDir),
      ]) {
        try {
          quarantineUserGitEntry(current, identity);
        } catch (rollbackError) {
          log(`⚠ [git] Failed to quarantine replacement metadata for ${slug}/${projectSlug}: ${errMessage(rollbackError)}`);
        }
      }
      for (const { original, backup } of metadataBackups) {
        try {
          // eslint-disable-next-line max-depth -- each rollback artifact is restored independently after a failed source switch
          if (fs.existsSync(backup)) fs.renameSync(backup, original);
        } catch (rollbackError) {
          log(`⚠ [git] Failed to restore prior metadata for ${slug}/${projectSlug}: ${errMessage(rollbackError)}`);
        }
      }
    }
    if (previousMoved && !fs.existsSync(dest) && fs.existsSync(quarantine)) {
      try {
        moveQuarantinedGitEntry(quarantine, dest);
      } catch (rollbackError) {
        log(`⚠ [git] Failed to restore prior checkout for ${slug}/${projectSlug}: ${errMessage(rollbackError)}`);
      }
    }
    log(`⚠ [git] Failed to switch ${slug}/${projectSlug}: ${errMessage(error)}`);
    return false;
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } finally {
      lease.release();
    }
  }
}

function acquireProjectSourceSwitchLease(
  acquire: typeof acquireWorkspaceMutationLeaseSync,
  dest: string,
  slug: string,
  projectSlug: string,
): ReturnType<typeof acquireWorkspaceMutationLeaseSync> {
  const stableGitDir = path.join(
    OPENCLAW_DIR,
    "git-source-switch-locks",
    slug,
    `${projectSlug}.git`,
  );
  fs.mkdirSync(stableGitDir, { recursive: true, mode: 0o700 });
  return acquire({ workspaceDir: dest, gitDir: stableGitDir });
}

function existingProjectGitDir(repoDir: string): string | null {
  const external = userGitMetadataDir(repoDir);
  const candidates = [external, path.join(repoDir, ".git")]
    .filter((candidate): candidate is string => candidate !== null);
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isDirectory() && !stat.isSymbolicLink()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

// eslint-disable-next-line max-params -- clone dependencies remain explicit to preserve credential and metadata boundaries
async function cloneGiteaProjectRepo(
  slug: string,
  projectSlug: string,
  dest: string,
  giteaRepoName: string,
  runGit: GitRunner,
  prepareRepository: typeof setRepoSshCommand,
): Promise<boolean> {
  const org = workspaceGiteaOrg(slug);
  const sshKey = userSshKeyPath(slug);
  if (!fs.existsSync(sshKey)) {
    log(`⚠ [git] Cannot clone ${slug}/${projectSlug} — per-user SSH key missing`);
    return false;
  }

  let exists: boolean;
  try {
    exists = await brokeredGitHost.repoExists({ owner: org, repo: giteaRepoName });
  } catch (err: unknown) {
    log(`⚠ [git] Gitea repo-exists check failed for ${org}/${giteaRepoName}: ${errMessage(err)}`);
    return false;
  }
  if (!exists) {
    log(`[git] Project repo ${org}/${giteaRepoName} not found on Gitea — skipping clone`);
    return false;
  }

  const cloned = checkoutProjectRepo({
    dest,
    projectSlug,
    label: `${slug}/${projectSlug}`,
    remoteUrl: sshRemoteUrl(org, giteaRepoName),
    sshKey,
    runGit,
  });
  if (!cloned) return false;

  setProjectCommitIdentity(dest, slug, runGit);
  prepareRepository(dest, slug, { giteaRepoName });

  log(`[git] ✅ Cloned ${org}/${giteaRepoName} → customers/${slug}/projects/${projectSlug}/`);
  return true;
}

function githubCloneIsBrokered(
  repoSource: ProjectRepoSource | null | undefined,
  githubToken: string | null | undefined,
): boolean {
  return repoSource?.provider === "github" && !githubToken && Boolean(process.env.GATEWAY_EDGE_INTERNAL_URL);
}

function localCloneOriginUrl(gitDir: string): string | null {
  try {
    return execFileSync(
      GIT_BINARY,
      ["config", "--file", path.join(gitDir, "config"), "--get", "remote.origin.url"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null;
  }
}

// The edge broker leaves a plain clone (its own .git directory, no canonical metadata or
// trust receipt), so the next probe would not recognise it as this project's source. Set the
// broker's .git aside, let the externalizer build fresh canonical metadata from it — the
// provisioner holds no GitHub credential, so the canonical remote cannot be fetched here —
// and verify the checkout the same way a direct clone is verified.
async function cloneGithubProjectViaBrokerCanonically(
  slug: string,
  projectSlug: string,
  dest: string,
  repoSource: ProjectRepoSource,
  prepareRepository: typeof setRepoSshCommand,
): Promise<boolean> {
  const label = `${slug}/${projectSlug}`;
  try {
    if (!(await cloneGithubProjectViaBroker(slug, projectSlug))) return false;
  } catch (error) {
    log(`⚠ [git] GitHub project clone broker failed for ${label}: ${errMessage(error)}`);
    return false;
  }
  const localGit = path.join(dest, ".git");
  let localGitStat: fs.Stats;
  try {
    localGitStat = fs.lstatSync(localGit);
  } catch (error) {
    log(`⚠ [git] brokered GitHub checkout for ${label} has no git metadata: ${errMessage(error)}`);
    return false;
  }
  if (!localGitStat.isDirectory() || localGitStat.isSymbolicLink()) {
    if (projectCheckoutMatchesSource(slug, projectSlug, "", repoSource) && userRepositoryHasCanonicalRemote(dest)) {
      return true;
    }
    log(`⚠ [git] brokered GitHub checkout for ${label} carries metadata that does not verify`);
    return false;
  }
  const expectedRemote = githubHttpsRemoteUrl(repoSource.owner, repoSource.repo);
  const actualRemote = localCloneOriginUrl(localGit);
  if (actualRemote !== expectedRemote) {
    log(`⚠ [git] brokered GitHub checkout for ${label} points at ${actualRemote ?? "no remote"}, expected ${expectedRemote}`);
    return false;
  }
  const sideline = path.join(path.dirname(dest), `.${projectSlug}-brokered-git-${randomUUID()}`);
  fs.renameSync(localGit, sideline);
  try {
    prepareRepository(dest, slug, {
      repoSource,
      fetchCanonical: (_worktree, gitDir) => {
        execFileSync(
          GIT_BINARY,
          [
            ...gitHardeningArgs(),
            "-c",
            "protocol.file.allow=always",
            "--git-dir",
            gitDir,
            "fetch",
            "--quiet",
            sideline,
            "+refs/heads/*:refs/remotes/origin/*",
          ],
          { cwd: dest, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: userGitEnvironmentForRefresh(slug) },
        );
      },
    });
  } catch (error) {
    fs.rmSync(localGit, { recursive: true, force: true });
    fs.renameSync(sideline, localGit);
    log(`⚠ [git] brokered GitHub checkout for ${label} could not be prepared canonically: ${errMessage(error)}`);
    return false;
  }
  fs.rmSync(sideline, { recursive: true, force: true });
  if (!projectCheckoutMatchesSource(slug, projectSlug, "", repoSource) || !userRepositoryHasCanonicalRemote(dest)) {
    log(`⚠ [git] brokered GitHub checkout for ${label} did not verify against its canonical source`);
    return false;
  }
  log(`[git] ✅ Cloned ${repoSource.owner}/${repoSource.repo} → customers/${slug}/projects/${projectSlug}/ via the edge broker`);
  return true;
}

async function switchProjectCheckoutViaBroker(
  slug: string,
  projectSlug: string,
  dest: string,
  repoSource: ProjectRepoSource,
  opts: CloneProjectRepoOptions,
): Promise<boolean> {
  const label = `${slug}/${projectSlug}`;
  let lease: ReturnType<typeof acquireWorkspaceMutationLeaseSync>;
  try {
    lease = acquireProjectSourceSwitchLease(
      opts.acquireMutationLease ?? acquireWorkspaceMutationLeaseSync,
      dest,
      slug,
      projectSlug,
    );
  } catch (error) {
    log(`⚠ [git] Cannot lease ${label}: ${errMessage(error)}`);
    return false;
  }
  if (!lease) return false;
  const quarantineRoot = path.join(OPENCLAW_DIR, "git-worktree-quarantine", slug);
  const quarantine = path.join(quarantineRoot, `${projectSlug}-${randomUUID()}`);
  const identity = userGitIdentity(dest);
  try {
    fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    if (identity) {
      for (const entry of [
        identity.metadataDir,
        userGitTrustReceipt(identity.metadataDir),
        userGitRefreshMarker(identity.metadataDir),
      ]) {
        quarantineUserGitEntry(entry, identity);
      }
    }
    moveQuarantinedGitEntry(dest, quarantine);
  } catch (error) {
    log(`⚠ [git] Cannot set aside ${label} before the brokered clone: ${errMessage(error)}`);
    return false;
  } finally {
    lease.release();
  }
  log(`[git] ${label} checkout did not match its GitHub source — set aside at ${quarantine}; cloning via the edge broker`);
  return cloneGithubProjectViaBrokerCanonically(
    slug,
    projectSlug,
    dest,
    repoSource,
    opts.prepareRepository ?? setRepoSshCommand,
  );
}

// eslint-disable-next-line max-params -- clone dependencies remain explicit to preserve credential and metadata boundaries
async function cloneGithubProjectRepo(
  slug: string,
  projectSlug: string,
  dest: string,
  repoSource: ProjectRepoSource,
  githubToken: string | null | undefined,
  runGit: GitRunner,
  prepareRepository: typeof setRepoSshCommand,
): Promise<boolean> {
  if (githubCloneIsBrokered(repoSource, githubToken)) {
    return cloneGithubProjectViaBrokerCanonically(slug, projectSlug, dest, repoSource, prepareRepository);
  }
  const remoteUrl = githubHttpsRemoteUrl(repoSource.owner, repoSource.repo);
  const cloned = checkoutProjectRepo({
    dest,
    projectSlug,
    label: `${slug}/${projectSlug}`,
    remoteUrl,
    githubToken,
    runGit,
    replaceExisting: true,
    quarantineRoot: path.join(OPENCLAW_DIR, "git-worktree-quarantine", slug),
  });
  if (!cloned) return false;

  setProjectCommitIdentity(dest, slug, runGit);
  prepareRepository(dest, slug, { repoSource, githubToken });

  log(
    `[git] ✅ Cloned ${repoSource.owner}/${repoSource.repo} → customers/${slug}/projects/${projectSlug}/`,
  );
  return true;
}

const GITHUB_CLONE_TOKEN_ENV = "OCTOGEE_GITHUB_CLONE_TOKEN";

function sanitizedGitProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (
      key === "GH_TOKEN"
      || key === "GITHUB_TOKEN"
      || key === "GH_ENTERPRISE_TOKEN"
      || key === "GITHUB_ENTERPRISE_TOKEN"
      || key === GITHUB_CLONE_TOKEN_ENV
      || key === "GIT_CONFIG"
      || key === "GIT_CONFIG_COUNT"
      || key === "GIT_CONFIG_PARAMETERS"
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

export function githubCloneCredentialEnv(
  token: string | null | undefined,
): Record<string, string> | undefined {
  if (!token) return undefined;
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_1:
      `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' ` +
      `"$${GITHUB_CLONE_TOKEN_ENV}"; }; f`,
    [GITHUB_CLONE_TOKEN_ENV]: token,
  };
}

function githubCredentialArgs(token: string | null | undefined): string[] {
  if (!token) return [];
  return [
    "-c",
    "credential.https://github.com.helper=!f() { test \"$1\" = get && printf 'username=x-access-token\\npassword=%s\\n' \"$OCTOGEE_GITHUB_CLONE_TOKEN\"; }; f",
  ];
}

function setProjectCommitIdentity(dest: string, slug: string, runGit: GitRunner): void {
  runGit(dest, ["config", "user.email", `${slug}@octogee.com`]);
  runGit(dest, ["config", "user.name", `Octo (${slug})`]);
}

interface ProjectCheckout {
  dest: string;
  projectSlug: string;
  label: string;
  remoteUrl: string;
  sshKey?: string;
  githubToken?: string | null;
  runGit: GitRunner;
  replaceExisting?: boolean;
  quarantineRoot?: string;
}

function checkoutProjectRepo(checkout: ProjectCheckout): boolean {
  const {
    dest,
    projectSlug,
    label,
    remoteUrl,
    sshKey,
    githubToken,
    runGit,
    replaceExisting,
    quarantineRoot,
  } = checkout;
  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true });
  const cloneDir = fs.existsSync(dest)
    ? projectCloneStaging(parent, projectSlug)
    : dest;

  const result = runGit(parent, ["clone", remoteUrl, cloneDir], sshKey, githubToken);
  if (result === null) {
    log(`⚠ [git] Clone failed for ${label}`);
    fs.rmSync(cloneDir, { recursive: true, force: true });
    return false;
  }

  if (cloneDir !== dest) {
    try {
      if (replaceExisting) {
        if (!quarantineRoot) throw new Error("missing project checkout quarantine root");
        const lease = repositoryMetadataExists(dest)
          ? acquireWorkspaceMutationLeaseSync({ workspaceDir: dest })
          : null;
        if (repositoryMetadataExists(dest) && !lease) {
          throw new Error("workspace mutation lease unavailable");
        }
        try {
          fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
          moveQuarantinedGitEntry(dest, path.join(quarantineRoot, `${projectSlug}-${randomUUID()}`));
          fs.renameSync(cloneDir, dest);
        } finally {
          lease?.release();
        }
      } else {
        adoptProjectClone(cloneDir, dest);
      }
    } catch (err) {
      log(`⚠ [git] Failed to adopt clone for ${label}: ${errMessage(err)}`);
      fs.rmSync(cloneDir, { recursive: true, force: true });
      return false;
    }
  }
  return true;
}

function copyMissingCloneTree(source: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const sourcePath = path.join(source, entry.name);
    const destPath = path.join(dest, entry.name);
    const destEntry = fs.lstatSync(destPath, { throwIfNoEntry: false });
    if (!destEntry) {
      fs.cpSync(sourcePath, destPath, { recursive: true, preserveTimestamps: true });
      continue;
    }
    if (destEntry.isSymbolicLink()) {
      throw new Error(`cannot adopt checkout over symbolic link: ${destPath}`);
    }
    if (!destEntry.isDirectory() && !destEntry.isFile()) {
      throw new Error(`cannot adopt checkout over special filesystem entry: ${destPath}`);
    }
    if (entry.isDirectory() && destEntry.isDirectory()) {
      copyMissingCloneTree(sourcePath, destPath);
    }
  }
}

export function adoptProjectClone(cloneDir: string, dest: string): void {
  copyMissingCloneTree(cloneDir, dest);
  fs.renameSync(path.join(cloneDir, ".git"), path.join(dest, ".git"));
  fs.rmSync(cloneDir, { recursive: true, force: true });
}

interface InitWorkspaceRepoDeps {
  ensureWorkspaceRepo: ((slug: string) => Promise<void>) | null;
  prepareRepository: (repoDir: string, slug: string) => void;
  workspaceRemoteUrl?: (slug: string) => string;
}

function runWorkspaceBootstrapGit(
  defaultAgentDir: string,
  gitDir: string,
  slug: string,
  argv: string[],
): string | null {
  try {
    return execFileSync(GIT_BINARY, [
      ...gitHardeningArgs(),
      "-c",
      "protocol.file.allow=always",
      "--git-dir",
      gitDir,
      "--work-tree",
      defaultAgentDir,
      ...argv,
    ], {
      cwd: defaultAgentDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: userGitEnvironmentForRefresh(slug),
    }).trim();
  } catch (err: unknown) {
    const detail =
      [execErrStderr(err), execErrStdout(err)].filter(Boolean).join(" | ") || errMessage(err);
    log(`⚠ [git] workspace bootstrap failed: git ${argv.join(" ")} → ${detail}`);
    return null;
  }
}

function pushWorkspaceBootstrap(
  defaultAgentDir: string,
  slug: string,
  originUrl: string,
): boolean {
  if (!SAFE_GIT_IDENTITY_RE.test(slug)) return false;
  const bootstrapRoot = path.join(OPENCLAW_DIR, "git-bootstrap");
  fs.mkdirSync(bootstrapRoot, { recursive: true, mode: 0o700 });
  const stagingRoot = fs.mkdtempSync(path.join(bootstrapRoot, `${slug}-`));
  const gitDir = path.join(stagingRoot, "workspace.git");
  try {
    execFileSync(GIT_BINARY, ["init", "--bare", "--initial-branch=main", gitDir], {
      cwd: defaultAgentDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: userGitEnvironmentForRefresh(slug),
    });
    const run = (argv: string[]) => runWorkspaceBootstrapGit(defaultAgentDir, gitDir, slug, argv);
    if (run(["config", "user.email", `${slug}@octogee.com`]) === null) return false;
    if (run(["config", "user.name", `Octo (${slug})`]) === null) return false;
    if (run(["remote", "add", "origin", originUrl]) === null) return false;
    const remoteMain = run(["ls-remote", "--heads", "origin", "refs/heads/main"]);
    if (remoteMain === null) return false;
    if (remoteMain !== "") {
      log(`[git] ${slug} canonical workspace already has main`);
      return true;
    }
    if (run(["add", "-A", "--", ".", ":(exclude).git"]) === null) return false;
    if (run(["commit", "--allow-empty", "-m", "initial workspace skeleton"]) === null) {
      return false;
    }
    if (run(["push", "origin", "HEAD:refs/heads/main"]) === null) return false;
    log(`[git] ${slug} initial push: OK`);
    return true;
  } catch (err: unknown) {
    log(`⚠ [git] workspace bootstrap initialization failed for ${slug}: ${errMessage(err)}`);
    return false;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function invalidateWorkspaceGitProjection(defaultAgentDir: string): void {
  const identity = userGitIdentity(defaultAgentDir);
  if (!identity) return;
  quarantineUserGitEntry(identity.metadataDir, identity);
  quarantineUserGitEntry(userGitTrustReceipt(identity.metadataDir), identity);
  quarantineUserGitEntry(userGitRefreshMarker(identity.metadataDir), identity);
  quarantineUserGitEntry(path.join(defaultAgentDir, ".git"), identity);
}

export async function initWorkspaceRepo(
  defaultAgentDir: string,
  slug: string,
  deps: InitWorkspaceRepoDeps = {
    ensureWorkspaceRepo: (workspaceSlug) => brokeredGitHost.ensureRepo(workspaceSlug, { kind: "workspace" }),
    prepareRepository: setRepoSshCommand,
  },
): Promise<string | null> {
  const org = workspaceGiteaOrg(slug);
  const repoName = workspaceRepoName();

  replaceFileAtomically(path.join(defaultAgentDir, ".gitignore"), workspaceGitignore(), 0o644);

  const welcome = notesWelcomeSeed("this workspace");
  const welcomeDest = path.join(defaultAgentDir, welcome.relPath);
  fs.mkdirSync(path.dirname(welcomeDest), { recursive: true });
  seedFileAtomically(welcomeDest, welcome.content, 0o644);

  try {
    await deps.ensureWorkspaceRepo?.(slug);
  } catch (err) {
    log(`⚠ [git] Failed to create repo ${org}/${repoName}: ${errMessage(err)}`);
    return null;
  }

  const originUrl = deps.workspaceRemoteUrl?.(slug) ?? sshRemoteUrl(org, repoName);
  log(`[git] Initializing repo in ${defaultAgentDir}`);
  if (!pushWorkspaceBootstrap(defaultAgentDir, slug, originUrl)) {
    log(`⚠ [git] initial workspace push failed for ${slug} — aborting repo setup`);
    return null;
  }
  invalidateWorkspaceGitProjection(defaultAgentDir);
  deps.prepareRepository(defaultAgentDir, slug);

  const gitHost = new URL(GIT_API_URL).origin;
  const repoUrlDisplay = `${gitHost}/${org}/${repoName}`;
  log(`[git] ✅ Workspace repo ready: ${repoUrlDisplay}`);
  return repoUrlDisplay;
}

export function workspaceGitignore(): string {
  return [
    "# Octogee workspace — track user-visible files, exclude system/build artifacts",
    "",
    "# System files (provisioner-managed, not user-visible)",
    "PROJECTS.md",
    "HEARTBEAT.md",
    "crew-webhooks.json",
    "_pending_*.json",
    ".byot-managed",
    ".system/",
    // openclaw's own state — `.openclaw/` is the current directory form, and
    // the root-level file is the pre-2026.7.2 one. Committing either lets a
    // mount's clone restore state openclaw has already migrated away, which
    // 2026.7.2 rejects outright ("Legacy workspace setup state requires
    // migration") on every agent turn.
    ".openclaw/",
    "openclaw-workspace-state.json",
    ".ssh/",
    "",
    "# Blob cache (provisioner-managed, synced from GCS)",
    ".blobs/",
    "",
    "# Inbound media (ephemeral, 7-day retention)",
    "media/",
    "",
    "# Project repos are their own Gitea clones — committed via their own",
    "# commit path (octogee_project_commit), never swept by workspace commits",
    "projects/",
    "",
    "# Blob manifest — server-side state in GCS beside the blobs it indexes",
    ".files/",
    "",
    "# Build artifacts",
    "node_modules/",
    "",
    "# User-visible files are tracked:",
    "# AGENTS.md, TOOLS.md, SOUL.md, USER.md, MEMORY.md, memory/*",
  ].join("\n") + "\n";
}

function projectGitignore(): string {
  return [
    "# Build artifacts",
    "node_modules/",
    ".astro/",
    "dist/",
    "",
    "# OS files",
    ".DS_Store",
  ].join("\n") + "\n";
}

export async function initProjectRepo(
  projectDir: string,
  slug: string,
  projectName: string,
  committerName = "Octogee",
  committerEmail = "octo@octogee.com",
): Promise<string | null> {
  const org = workspaceGiteaOrg(slug);
  const repoName = projectRepoName(projectName);
  const sshKey = userSshKeyPath(slug);
  const keyArg = fs.existsSync(sshKey) ? sshKey : undefined;

  fs.writeFileSync(path.join(projectDir, ".gitignore"), projectGitignore(), "utf-8");

  log(`[git] Initializing project repo: ${slug}/${projectName}`);
  gitExec(projectDir, ["init", "-b", "main"]);
  gitExec(projectDir, ["config", "user.email", committerEmail]);
  gitExec(projectDir, ["config", "user.name", committerName]);

  setRepoSshCommand(projectDir, slug);
  gitExec(projectDir, ["add", "-A"]);
  const commitResult = gitExec(projectDir, ["commit", "-m", `initial: ${projectName} project created`]);
  if (commitResult === null) {
    log(`⚠ [git] Failed to create initial commit for project ${slug}/${projectName}`);
    return null;
  }

  try {
    await brokeredGitHost.ensureRepo(slug, { kind: "project", projectSlug: projectName });
  } catch (err) {
    log(`⚠ [git] Failed to create project repo ${org}/${repoName}: ${errMessage(err)}`);
    return null;
  }

  const originUrl = sshRemoteUrl(org, repoName);
  gitExec(projectDir, ["remote", "set-url", "origin", originUrl]);
  const pushResult = gitExec(projectDir, ["push", "-u", "origin", "main"], keyArg);
  log(`[git] project push: ${pushResult !== null ? "OK" : "FAILED"}`);

  if (pushResult === null) {
    log(`⚠ [git] Failed to push project ${slug}/${projectName}`);
    return null;
  }

  const gitHost = new URL(GIT_API_URL).origin;
  const repoUrlDisplay = `${gitHost}/${org}/${repoName}`;
  log(`[git] ✅ Project repo created: ${repoUrlDisplay}`);
  return repoUrlDisplay;
}

export function pushInitialSkeleton(
  defaultAgentDir: string,
  slug: string,
  sshKeyPath?: string,
): void {
  if (gitExec(defaultAgentDir, ["status", "--porcelain"])) {
    gitExec(defaultAgentDir, ["add", "-A"]);
    if (gitExec(defaultAgentDir, ["commit", "-m", "initial workspace skeleton"]) === null) {
      log(`⚠ [git] ${slug} initial commit failed — sync will retry`);
    }
  }
  if (gitExec(defaultAgentDir, ["push", "-u", "origin", "main"], sshKeyPath) === null) {
    log(`⚠ [git] ${slug} initial push failed — sync will retry`);
  } else {
    log(`[git] ${slug} initial push: OK`);
  }
}

export async function commitAndPush(repoDir: string, message: string): Promise<boolean> {
  const relPath = path.relative(CUSTOMERS_DIR, repoDir);
  const slug = relPath.split(path.sep)[0];
  const sshKey = userSshKeyPath(slug);
  const keyArg = fs.existsSync(sshKey) ? sshKey : undefined;

  const status = gitExec(repoDir, ["status", "--porcelain"]);
  if (!status) {
    log(`[git] commitAndPush: nothing to commit in ${repoDir}`);
    return true;
  }
  gitExec(repoDir, ["add", "-A"]);
  const commitResult = gitExec(repoDir, ["commit", "-m", message]);
  if (commitResult === null) {
    log(`⚠ [git] commitAndPush: commit failed in ${repoDir}`);
    return false;
  }
  const pushResult = gitExec(repoDir, ["push", "origin", "main"], keyArg);
  if (pushResult === null) {
    log(`⚠ [git] commitAndPush: push failed in ${repoDir}`);
    return false;
  }
  log(`[git] commitAndPush: OK in ${repoDir}`);
  return true;
}

export function listOnDiskUserSlugs(): string[] {
  if (!fs.existsSync(CUSTOMERS_DIR)) return [];
  return fs.readdirSync(CUSTOMERS_DIR).filter((d) => {
    try {
      return fs.statSync(path.join(CUSTOMERS_DIR, d)).isDirectory();
    } catch {
      return false;
    }
  });
}

type GitRunner = typeof gitExec;
