/**
 * HTTP auth middleware helpers: session cookie extraction/creation and
 * request auth extraction (cookie-first, then Bearer token fallback).
 */

export const SESSION_COOKIE = 'bscs_session';

/**
 * Extract the bscs_session cookie value from a Cookie header string.
 */
export function extractSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name?.trim() === SESSION_COOKIE) {
      return rest.join('=').trim() || undefined;
    }
  }
  return undefined;
}

/**
 * Create a Set-Cookie header value for bscs_session.
 * MaxAge is 86400 (1 day).
 */
export function createSessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'MaxAge=86400',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Extract auth from a request: check session cookie first, then Bearer token.
 * Returns the token string if present, or undefined if not authenticated.
 */
export function extractAuth(
  cookieHeader: string | undefined,
  authHeader: string | undefined,
): string | undefined {
  const cookie = extractSessionCookie(cookieHeader);
  if (cookie) return cookie;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    return token || undefined;
  }

  return undefined;
}
