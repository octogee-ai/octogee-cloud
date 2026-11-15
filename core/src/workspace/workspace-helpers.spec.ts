import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../git-host/github', () => ({
  githubContentsApi: vi.fn(async () => [{ name: 'README.md' }]),
}));
vi.mock('../git-host/gitea-client', () => ({
  giteaApiAsUser: vi.fn(async () => [{ name: 'README.md' }]),
}));

import {
  isTargetDirectoryEntryReadable,
  isTargetDirectoryReadable,
  isTargetPathReadable,
  repoContentsApi,
  isTargetPathWritable,
} from './route-helpers.js';
import { githubContentsApi } from '../git-host/github.js';
import { giteaApiAsUser } from '../git-host/gitea-client.js';
import type { FileTarget } from './fileTarget.js';

describe('repoContentsApi — identity source per provider', () => {
  beforeEach(() => {
    vi.mocked(githubContentsApi).mockClear();
    vi.mocked(giteaApiAsUser).mockClear();
  });

  const githubTarget: FileTarget = {
    slug: 'alice',
    projectSlug: 'octo',
    provider: 'github',
    org: 'octogee-ai',
    repoName: 'octogee',
    gcsPrefix: 'customers/alice/projects/octo',
    githubToken: 'gho_owner_token',
    brokered: true,
  };

  it("github targets use the target's caller-bound token, never a gitea sudo", async () => {
    await repoContentsApi(githubTarget, 'docs/INDEX.md');
    expect(githubContentsApi).toHaveBeenCalledWith('octogee-ai', 'octogee', 'docs/INDEX.md', 'gho_owner_token', undefined);
    expect(giteaApiAsUser).not.toHaveBeenCalled();
  });

  it('gitea targets impersonate the workspace user via Sudo (no per-user token)', async () => {
    const target: FileTarget = {
      slug: 'alice',
      projectSlug: null,
      provider: 'gitea',
      org: 'alice',
      repoName: 'workspace',
      gcsPrefix: 'customers/alice',
      sudoUser: 'ws-alice',
      brokered: false,
    };
    await repoContentsApi(target, 'notes.md');
    expect(giteaApiAsUser).toHaveBeenCalledWith('ws-alice', 'alice', 'workspace/contents/notes.md', 'GET', undefined);
    expect(githubContentsApi).not.toHaveBeenCalled();
  });
});

describe('isTargetPathWritable — brokered targets allowlisted, owners unrestricted', () => {
  const base: Omit<FileTarget, 'brokered' | 'provider'> = {
    slug: 'alice',
    projectSlug: null,
    org: 'alice',
    repoName: 'workspace',
    gcsPrefix: 'customers/alice',
    sudoUser: 'ws-alice',
    canvasFile: 'README.md',
  };

  it('unrestricted (owner / project collaborator) can write anywhere', () => {
    const t: FileTarget = { ...base, provider: 'gitea', brokered: false };
    expect(isTargetPathWritable(t, 'src/index.ts')).toBe(true);
    expect(isTargetPathWritable(t, 'notes/x.md')).toBe(true);
  });

  it('brokered (workspace member) is capped to notes/* + the canvas home', () => {
    const t: FileTarget = { ...base, provider: 'gitea', brokered: true };
    expect(isTargetPathWritable(t, 'notes/x.md')).toBe(true);
    expect(isTargetPathWritable(t, 'README.md')).toBe(true);
    expect(isTargetPathWritable(t, 'src/index.ts')).toBe(false);
    expect(isTargetPathWritable(t, 'notes/sub/x.md')).toBe(false);
  });
});

describe('workspace member brokered reads', () => {
  const target: FileTarget = {
    slug: 'alice',
    projectSlug: null,
    provider: 'gitea',
    org: 'alice',
    repoName: 'workspace',
    gcsPrefix: 'customers/alice',
    sudoUser: 'ws-alice',
    brokered: true,
    workspaceMemberBrokered: true,
    canvasFile: 'docs/home.md',
  };

  it('allows notes and the configured canvas while denying other owner files', () => {
    expect(isTargetPathReadable(target, 'notes/idea.md')).toBe(true);
    expect(isTargetPathReadable(target, 'docs/home.md')).toBe(true);
    expect(isTargetPathReadable(target, '.octogee/canvas.json')).toBe(true);
    expect(isTargetPathReadable(target, 'docs/plan.md')).toBe(false);
    expect(isTargetPathReadable(target, 'src/index.ts')).toBe(false);
  });

  it('allows only directories needed to reach readable files', () => {
    expect(isTargetDirectoryReadable(target, '')).toBe(true);
    expect(isTargetDirectoryReadable(target, 'notes')).toBe(true);
    expect(isTargetDirectoryReadable(target, 'docs')).toBe(true);
    expect(isTargetDirectoryReadable(target, 'src')).toBe(false);
    expect(isTargetDirectoryEntryReadable(target, 'docs', 'dir')).toBe(true);
    expect(isTargetDirectoryEntryReadable(target, 'src', 'dir')).toBe(false);
  });
});
