import { describe, expect, it } from 'vitest';
import { isOversizeFile } from './github.js';

describe('isOversizeFile', () => {
  it('flags a GitHub file whose content GitHub omitted (encoding "none", >1MB)', () => {
    expect(isOversizeFile({ encoding: 'none' })).toBe(true);
  });

  it('does not flag an inline base64 file', () => {
    expect(isOversizeFile({ encoding: 'base64' })).toBe(false);
  });

  it('does not flag a response without an encoding field (the Gitea path)', () => {
    expect(isOversizeFile({})).toBe(false);
  });
});
