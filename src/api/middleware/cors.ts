/**
 * CORS origin validation: allow localhost, 127.0.0.1, ::1, and *.ts.net origins.
 */

/**
 * Check if the given origin is allowed.
 * Allowed: localhost (any port), 127.0.0.1 (any port), [::1] (any port), *.ts.net (any port).
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;

  try {
    const url = new URL(origin);
    const hostname = url.hostname;

    if (hostname === 'localhost') return true;
    if (hostname === '127.0.0.1') return true;
    if (hostname === '::1' || hostname === '[::1]') return true;
    if (hostname.endsWith('.ts.net')) return true;

    return false;
  } catch {
    return false;
  }
}
