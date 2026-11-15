import type { GitRepositoryOutput, GitRepositoryRole } from "@octogee/shared/types/provisioning-service";

export type GitRepositoryKind = GitRepositoryRole | "system-config";

export interface AuthorizedGitKey {
  publicKey: string;
  holder: string | null;
}

export interface GitHost {
  ensureOwner(input: { slug: string; knownOwner?: string }, signal: AbortSignal): Promise<{ owner: string }>;
  ensureRepository(input: { owner: string; kind: GitRepositoryKind }, signal: AbortSignal): Promise<GitRepositoryOutput>;
  listKeys(input: { owner: string }, signal: AbortSignal): Promise<AuthorizedGitKey[]>;
  registerKey(input: { owner: string; publicKey: string; holder: string }, signal: AbortSignal): Promise<void>;
  releaseKey(input: { owner: string; publicKey: string; holder: string }, signal: AbortSignal): Promise<void>;
}
