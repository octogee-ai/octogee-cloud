import { describe, expect, it } from 'vitest';
import {
  githubContentsUrl,
  githubHeaders,
  githubReposUrl,
  toRepoSummary,
  isValidGithubRepoSource,
  parseGithubRepoUrl,
} from './github.js';

describe('githubContentsUrl', () => {
  it('builds the contents URL for a file path', () => {
    expect(githubContentsUrl('octogee-ai', 'octogee', 'README.md')).toBe(
      'https://api.github.com/repos/octogee-ai/octogee/contents/README.md',
    );
  });

  it('builds the root contents URL when path is empty', () => {
    expect(githubContentsUrl('octogee-ai', 'octogee', '')).toBe(
      'https://api.github.com/repos/octogee-ai/octogee/contents',
    );
  });

  it('builds a nested directory URL', () => {
    expect(githubContentsUrl('octogee-ai', 'octogee', 'app/src')).toBe(
      'https://api.github.com/repos/octogee-ai/octogee/contents/app/src',
    );
  });

  it('rejects an invalid owner', () => {
    expect(() => githubContentsUrl('bad owner!', 'octogee', '')).toThrow(/Invalid GitHub owner/);
  });

  it('rejects an invalid repo', () => {
    expect(() => githubContentsUrl('octogee-ai', 'bad repo!', '')).toThrow(/Invalid GitHub repo/);
  });
});

describe('githubHeaders', () => {
  it('includes Bearer auth + Accept + User-Agent when a token is present', () => {
    expect(githubHeaders('tok123')).toEqual({
      Authorization: 'Bearer tok123',
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'octogee-workspace',
    });
  });

  it('omits Authorization for an anonymous (public-repo) request', () => {
    expect(githubHeaders(undefined)).toEqual({
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'octogee-workspace',
    });
  });
});

describe('githubReposUrl', () => {
  it('requests owned + collaborator + org repos, one full page', () => {
    const url = githubReposUrl();
    expect(url).toContain('https://api.github.com/user/repos');
    expect(url).toContain('per_page=100');
    expect(url).toContain('affiliation=owner,collaborator,organization_member');
  });
});

describe('toRepoSummary', () => {
  it('maps the GitHub repo shape to a picker summary', () => {
    expect(
      toRepoSummary({
        name: 'octogee',
        full_name: 'octogee-ai/octogee',
        private: true,
        description: 'the thing',
        updated_at: '2026-06-10T00:00:00Z',
        default_branch: 'main',
        size: 42,
        owner: { login: 'octogee-ai' },
      }),
    ).toEqual({
      owner: 'octogee-ai',
      repo: 'octogee',
      fullName: 'octogee-ai/octogee',
      private: true,
      description: 'the thing',
      updatedAt: '2026-06-10T00:00:00Z',
      defaultBranch: 'main',
      sizeKiB: 42,
    });
  });
});

describe('isValidGithubRepoSource', () => {
  it('accepts a well-formed github repoSource', () => {
    expect(isValidGithubRepoSource({ provider: 'github', owner: 'octogee-ai', repo: 'octogee' })).toBe(true);
  });

  it('rejects a non-github provider', () => {
    expect(isValidGithubRepoSource({ provider: 'gitlab', owner: 'octogee-ai', repo: 'octogee' })).toBe(false);
  });

  it('rejects an invalid owner', () => {
    expect(isValidGithubRepoSource({ provider: 'github', owner: 'bad owner!', repo: 'octogee' })).toBe(false);
  });

  it('rejects a missing repo', () => {
    expect(isValidGithubRepoSource({ provider: 'github', owner: 'octogee-ai' })).toBe(false);
  });

  it('rejects null and non-objects', () => {
    expect(isValidGithubRepoSource(null)).toBe(false);
    expect(isValidGithubRepoSource('octogee-ai/octogee')).toBe(false);
  });
});

describe('parseGithubRepoUrl', () => {
  const expected = { provider: 'github', owner: 'octogee-ai', repo: 'octogee' };

  it('parses a canonical https repo URL', () => {
    expect(parseGithubRepoUrl('https://github.com/octogee-ai/octogee')).toEqual(expected);
  });

  it('parses without a protocol', () => {
    expect(parseGithubRepoUrl('github.com/octogee-ai/octogee')).toEqual(expected);
  });

  it('parses http, www, trailing slash, and a .git suffix', () => {
    expect(parseGithubRepoUrl('http://github.com/octogee-ai/octogee')).toEqual(expected);
    expect(parseGithubRepoUrl('https://www.github.com/octogee-ai/octogee')).toEqual(expected);
    expect(parseGithubRepoUrl('https://github.com/octogee-ai/octogee/')).toEqual(expected);
    expect(parseGithubRepoUrl('https://github.com/octogee-ai/octogee.git')).toEqual(expected);
    expect(parseGithubRepoUrl('  https://github.com/octogee-ai/octogee.git/  ')).toEqual(expected);
  });

  it('rejects hosts that are not github.com', () => {
    expect(parseGithubRepoUrl('https://gitlab.com/octogee-ai/octogee')).toBeNull();
    expect(parseGithubRepoUrl('https://github.com.evil.example/octogee-ai/octogee')).toBeNull();
    expect(parseGithubRepoUrl('https://evilgithub.com/octogee-ai/octogee')).toBeNull();
    expect(parseGithubRepoUrl('https://raw.githubusercontent.com/octogee-ai/octogee')).toBeNull();
  });

  it('rejects a URL without a repo segment', () => {
    expect(parseGithubRepoUrl('https://github.com/octogee-ai')).toBeNull();
    expect(parseGithubRepoUrl('https://github.com/octogee-ai/')).toBeNull();
    expect(parseGithubRepoUrl('https://github.com/')).toBeNull();
    expect(parseGithubRepoUrl('https://github.com/octogee-ai/.git')).toBeNull();
  });

  it('rejects extra path segments', () => {
    expect(parseGithubRepoUrl('https://github.com/octogee-ai/octogee/tree/main')).toBeNull();
    expect(parseGithubRepoUrl('https://github.com/octogee-ai/octogee/blob/main/README.md')).toBeNull();
  });

  it('rejects owners and repos the repoSource shape would reject', () => {
    expect(parseGithubRepoUrl('https://github.com/bad%20owner/octogee')).toBeNull();
    expect(parseGithubRepoUrl(`https://github.com/${'a'.repeat(40)}/octogee`)).toBeNull();
  });

  it('rejects non-strings, blanks, and bare owner/repo pairs', () => {
    expect(parseGithubRepoUrl(null)).toBeNull();
    expect(parseGithubRepoUrl(42)).toBeNull();
    expect(parseGithubRepoUrl({ provider: 'github', owner: 'octogee-ai', repo: 'octogee' })).toBeNull();
    expect(parseGithubRepoUrl('   ')).toBeNull();
    expect(parseGithubRepoUrl('octogee-ai/octogee')).toBeNull();
    expect(parseGithubRepoUrl('not a url at all')).toBeNull();
  });
});
