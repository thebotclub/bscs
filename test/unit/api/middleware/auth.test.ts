import { describe, it, expect } from 'vitest';
import {
  SESSION_COOKIE,
  extractSessionCookie,
  createSessionCookie,
  extractAuth,
} from '../../../../src/api/middleware/auth.js';

describe('SESSION_COOKIE', () => {
  it('is bscs_session', () => {
    expect(SESSION_COOKIE).toBe('bscs_session');
  });
});

describe('extractSessionCookie', () => {
  it('extracts the bscs_session cookie value', () => {
    expect(extractSessionCookie('bscs_session=abc123')).toBe('abc123');
  });

  it('returns undefined when cookie header is undefined', () => {
    expect(extractSessionCookie(undefined)).toBeUndefined();
  });

  it('returns undefined when bscs_session cookie is absent', () => {
    expect(extractSessionCookie('other=val; another=val2')).toBeUndefined();
  });

  it('handles multiple cookies and finds bscs_session', () => {
    expect(extractSessionCookie('foo=bar; bscs_session=mytoken; baz=qux')).toBe('mytoken');
  });

  it('handles bscs_session as last cookie', () => {
    expect(extractSessionCookie('foo=bar; bscs_session=lasttoken')).toBe('lasttoken');
  });

  it('handles empty cookie header', () => {
    expect(extractSessionCookie('')).toBeUndefined();
  });
});

describe('createSessionCookie', () => {
  it('includes the token value', () => {
    const cookie = createSessionCookie('mytoken', false);
    expect(cookie).toContain('bscs_session=mytoken');
  });

  it('includes Path=/', () => {
    const cookie = createSessionCookie('tok', false);
    expect(cookie).toContain('Path=/');
  });

  it('includes HttpOnly', () => {
    const cookie = createSessionCookie('tok', false);
    expect(cookie).toContain('HttpOnly');
  });

  it('includes SameSite=Strict', () => {
    const cookie = createSessionCookie('tok', false);
    expect(cookie).toContain('SameSite=Strict');
  });

  it('includes MaxAge=86400', () => {
    const cookie = createSessionCookie('tok', false);
    expect(cookie).toContain('MaxAge=86400');
  });

  it('does NOT include Secure when secure=false', () => {
    const cookie = createSessionCookie('tok', false);
    expect(cookie).not.toContain('Secure');
  });

  it('includes Secure when secure=true', () => {
    const cookie = createSessionCookie('tok', true);
    expect(cookie).toContain('Secure');
  });
});

describe('extractAuth', () => {
  it('prefers cookie over bearer token', () => {
    const result = extractAuth('bscs_session=cookietoken', 'Bearer bearertoken');
    expect(result).toBe('cookietoken');
  });

  it('falls back to bearer token when no cookie', () => {
    const result = extractAuth(undefined, 'Bearer bearertoken');
    expect(result).toBe('bearertoken');
  });

  it('falls back to bearer token when cookie header has no bscs_session', () => {
    const result = extractAuth('other=val', 'Bearer bearertoken');
    expect(result).toBe('bearertoken');
  });

  it('returns undefined when neither cookie nor bearer present', () => {
    expect(extractAuth(undefined, undefined)).toBeUndefined();
  });

  it('returns cookie token when no auth header', () => {
    expect(extractAuth('bscs_session=mytoken', undefined)).toBe('mytoken');
  });

  it('returns undefined for invalid bearer scheme', () => {
    expect(extractAuth(undefined, 'Basic dXNlcjpwYXNz')).toBeUndefined();
  });
});
