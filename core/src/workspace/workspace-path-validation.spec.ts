import { describe, expect, it } from 'vitest';
import {
  giteaSudoUser,
  pathHasReservedOrHiddenSegment,
  validateWorkspacePath,
} from './route-helpers.js';
import type { FileTarget } from './fileTarget.js';

describe('validateWorkspacePath', () => {
  it('accepts a normal nested path', () => {
    expect(validateWorkspacePath('docs/notes.md')).toBeNull();
    expect(validateWorkspacePath('NOTES.md')).toBeNull();
    expect(validateWorkspacePath('builds/site/src/index.tsx')).toBeNull();
    expect(validateWorkspacePath('AGENTS.md')).toBeNull();
    expect(validateWorkspacePath('TOOLS.md')).toBeNull();
  });

  it('rejects parent traversal', () => {
    expect(validateWorkspacePath('../etc/passwd')).toMatch(/traversal/i);
    expect(validateWorkspacePath('foo/../bar')).toMatch(/traversal/i);
    expect(validateWorkspacePath('foo/../../bar')).toMatch(/traversal/i);
  });

  it('rejects absolute paths', () => {
    expect(validateWorkspacePath('/etc/passwd')).toMatch(/absolute/i);
  });

  it('rejects backslashes (Windows traversal)', () => {
    expect(validateWorkspacePath('foo\\bar')).toMatch(/backslash/i);
  });

  it('rejects HIDDEN reserved names anywhere in the path', () => {
    expect(validateWorkspacePath('node_modules/foo')).toMatch(/reserved/i);
    expect(validateWorkspacePath('HEARTBEAT.md')).toMatch(/reserved/i);
  });

  it('rejects hidden segments (starting with dot)', () => {
    expect(validateWorkspacePath('.gitignore')).not.toBeNull();
    expect(validateWorkspacePath('.git/config')).not.toBeNull();
    expect(validateWorkspacePath('subdir/.git/config')).not.toBeNull();
    expect(validateWorkspacePath('subdir/.env')).toMatch(/hidden/i);
  });

  it('rejects null bytes', () => {
    expect(validateWorkspacePath('foo\0bar')).toMatch(/null/i);
  });

  it('rejects empty', () => {
    expect(validateWorkspacePath('')).toMatch(/required|empty/i);
  });

  it('rejects double slash', () => {
    expect(validateWorkspacePath('foo//bar')).toMatch(/double/i);
  });

  it('rejects trailing slash (empty segment)', () => {
    expect(validateWorkspacePath('foo/bar/')).toMatch(/empty/i);
  });

  it('rejects leading slash (handled by absolute check)', () => {
    expect(validateWorkspacePath('/foo')).toMatch(/absolute/i);
  });
});

describe('pathHasReservedOrHiddenSegment', () => {
  it('returns null for normal paths', () => {
    expect(pathHasReservedOrHiddenSegment('docs/notes.md')).toBeNull();
    expect(pathHasReservedOrHiddenSegment('NOTES.md')).toBeNull();
    expect(pathHasReservedOrHiddenSegment('AGENTS.md')).toBeNull();
    expect(pathHasReservedOrHiddenSegment('TOOLS.md')).toBeNull();
  });

  it('flags HIDDEN reserved names', () => {
    expect(pathHasReservedOrHiddenSegment('HEARTBEAT.md')).toMatch(/reserved/i);
    expect(pathHasReservedOrHiddenSegment('subdir/node_modules/foo')).toMatch(/reserved/i);
  });

  it('flags hidden segments', () => {
    expect(pathHasReservedOrHiddenSegment('subdir/.env')).toMatch(/hidden/i);
  });

  it('flags empty segments', () => {
    expect(pathHasReservedOrHiddenSegment('foo//bar')).toMatch(/empty/i);
    expect(pathHasReservedOrHiddenSegment('foo/bar/')).toMatch(/empty/i);
  });
});

describe('giteaSudoUser — fail loud if a gitea target has no impersonation identity', () => {
  const base: FileTarget = {
    slug: 'alice',
    projectSlug: null,
    provider: 'gitea',
    org: 'alice',
    repoName: 'workspace',
    gcsPrefix: 'customers/alice',
    sudoUser: 'ws-alice',
  };

  it('returns the impersonation user when set', () => {
    expect(giteaSudoUser(base)).toBe('ws-alice');
  });

  it('throws (never silently acts as raw admin) when sudoUser is missing', () => {
    const { sudoUser: _omit, ...noSudo } = base;
    expect(() => giteaSudoUser(noSudo as FileTarget)).toThrowError(/sudoUser/i);
  });
});
