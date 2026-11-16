export type GitHostKind = "managed" | "connected";

export type GitRepoRole =
  | { kind: "workspace" }
  | { kind: "system-config" }
  | { kind: "project-coaches" }
  | { kind: "project"; projectSlug: string };

export interface GitRepoRef {
  owner: string;
  repo: string;
}

export interface GitHostNaming {
  owner(workspaceSlug: string): string;
  repo(role: GitRepoRole): string;
}

export interface GitHostProvisioning {
  ensureOwner(workspaceSlug: string): Promise<void>;
  ensureRepo(workspaceSlug: string, role: GitRepoRole): Promise<void>;
  repoExists(ref: GitRepoRef): Promise<boolean>;
  archiveRepo(ref: GitRepoRef): Promise<void>;
  restoreRepo(ref: GitRepoRef): Promise<void>;
  deleteRepo(ref: GitRepoRef): Promise<void>;
}

export type GitKeySweepMode = "dry-run" | "enforce";

export interface GitKeyHolders {
  owners: ReadonlySet<string>;
}

export interface GitKeySweepInput {
  readLiveKeyHolders: () => Promise<GitKeyHolders>;
  mode: GitKeySweepMode;
  maxCallsPerTick: number;
  minCallIntervalMs: number;
  graceMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

export interface GitKeyCensus {
  username: string;
  managed: number;
  live: number;
  legacy: number;
  young: number;
  stale: number;
  deleted: number;
  legacyStale: number;
  legacyDeleted: number;
}

export interface GitKeySweepPass {
  usernames: string[];
  next: number;
  totals: Omit<GitKeyCensus, "username">;
}

export interface GitKeySweepState {
  pass: GitKeySweepPass | null;
  lastCallAt: number | null;
}

export interface GitKeySweepResult {
  users: GitKeyCensus[];
  passCompleted: boolean;
  calls: number;
}

export interface GitHostSshKeys {
  registerKey(workspaceSlug: string, publicKey: string, holder?: string): Promise<void>;
  registerKeyUnlessHeld(workspaceSlug: string, publicKey: string, holder: string): Promise<void>;
  holdsKey(workspaceSlug: string, publicKey: string, holder: string, signal?: AbortSignal): Promise<boolean>;
  listKeys(workspaceSlug: string): Promise<string[]>;
  releaseKey(workspaceSlug: string, publicKey: string, holder?: string): Promise<void>;
  sweepKeys(input: GitKeySweepInput, state: GitKeySweepState): Promise<GitKeySweepResult>;
}

export interface GitHostErasure {
  eraseOwner(workspaceSlug: string, repos: readonly string[]): Promise<void>;
}

export interface GitHostSignIn {
  setUserPassword(workspaceSlug: string, password: string): Promise<string>;
  blockSignIn(workspaceSlug: string): Promise<void>;
}

export interface ManagedGitHost extends GitHostProvisioning, GitHostSshKeys, GitHostErasure, GitHostSignIn {
  readonly kind: "managed";
  readonly provider: string;
  readonly naming: GitHostNaming;
}

export type GitCredentialProfile = "read" | "write" | "full";

export interface GitSessionFiles {
  gitconfig: string;
  ghHostsYml?: string;
  expiresAt: number;
}

export interface ConnectedGitHost extends GitHostProvisioning {
  readonly kind: "connected";
  readonly provider: string;
  readonly naming: GitHostNaming;
  issueCredentials(ref: GitRepoRef, profile: GitCredentialProfile): Promise<GitSessionFiles>;
}

export type GitHost = ManagedGitHost | ConnectedGitHost;

export function createGitKeySweepState(): GitKeySweepState {
  return { pass: null, lastCallAt: null };
}
