import { afterEach, describe, it, expect } from 'vitest';
import { buildOAuthRedirect, sanitizeReturnUrl } from '../lib/redirect-validation.js';

const BASE = 'https://app.octogee.com';

describe('buildOAuthRedirect — query params land BEFORE the fragment', () => {
  it('keeps a #connections deep-link working after the OAuth callback', () => {
    const out = buildOAuthRedirect('/@me/account#connections', BASE, {
      github_connected: 'true',
      github_account: 'chris-e',
    });
    expect(out).toBe(
      'https://app.octogee.com/@me/account?github_connected=true&github_account=chris-e#connections',
    );
  });

  it('appends normally when there is no fragment', () => {
    expect(buildOAuthRedirect('/dashboard', BASE, { connect_error: 'cancelled' })).toBe(
      'https://app.octogee.com/dashboard?connect_error=cancelled',
    );
  });

  it('uses & when the path already carries a query, still before the fragment', () => {
    expect(buildOAuthRedirect('/p?tab=files#x', BASE, { ok: '1' })).toBe(
      'https://app.octogee.com/p?tab=files&ok=1#x',
    );
  });

  it('returns the bare URL when there are no params', () => {
    expect(buildOAuthRedirect('/@me/account#connections', BASE, {})).toBe(
      'https://app.octogee.com/@me/account#connections',
    );
  });
});

describe('sanitizeReturnUrl — existing contract pins', () => {
  it('keeps relative paths and rejects protocol-relative ones', () => {
    expect(sanitizeReturnUrl('/w/me/files')).toBe('/w/me/files');
    expect(sanitizeReturnUrl('//evil.com/x')).toBe('/dashboard');
  });

  it.each([
    'https://evil.com/phish',
    'https://app-octogee-build-week.web.app/dashboard',
    'https://octogee-build-week.web.app/dashboard',
  ])('rejects offsite absolute URL %s', (url) => {
    expect(sanitizeReturnUrl(url)).toBe('/dashboard');
  });

  it('rejects backslash-prefixed protocol-relative bypasses', () => {
    expect(sanitizeReturnUrl('/\\evil.com')).toBe('/dashboard');
    expect(sanitizeReturnUrl('/\\\\evil.com')).toBe('/dashboard');
  });

});

describe('sanitizeReturnUrl — localhost is gated out of production builds', () => {
  const ORIGINAL_LOCAL = process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS;
  afterEach(() => {
    if (ORIGINAL_LOCAL === undefined) delete process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS;
    else process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS = ORIGINAL_LOCAL;
  });

  it('rejects an absolute localhost returnUrl when the flag is unset (production)', () => {
    delete process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS;
    expect(sanitizeReturnUrl('http://localhost:4322/@me/account')).toBe('/dashboard');
  });

  it('accepts an absolute localhost returnUrl only when OCTOGEE_ALLOW_LOCAL_ORIGINS=true', () => {
    process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS = 'true';
    expect(sanitizeReturnUrl('http://localhost:4322/@me/account')).toBe(
      'http://localhost:4322/@me/account',
    );
  });

  it('still accepts the public app hosts regardless of the flag', () => {
    delete process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS;
    expect(sanitizeReturnUrl('https://octogee.com/dashboard')).toBe(
      'https://octogee.com/dashboard',
    );
  });
});
