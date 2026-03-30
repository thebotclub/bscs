/**
 * Dashboard authentication — generates and persists a random bearer token.
 * Token is stored at ~/.config/bscs/dashboard-token (mode 0600).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

function getTokenPath(): string {
  const dir = process.env.BSCS_CONFIG_DIR
    ? process.env.BSCS_CONFIG_DIR
    : `${homedir()}/.config/bscs`;
  return `${dir}/dashboard-token`;
}

/**
 * Load the existing token or generate and persist a new one.
 */
export function loadOrCreateAuthToken(): string {
  const tokenPath = getTokenPath();

  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, 'utf-8').trim();
    if (token.length >= 32) return token;
  }

  // Generate a new 32-byte (64-char hex) token
  const token = randomBytes(32).toString('hex');
  const dir = dirname(tokenPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // Best-effort on platforms that don't support chmod
  }
  return token;
}

/**
 * Validate a bearer token string against the stored token.
 * Returns true iff the token matches. Constant-time comparison.
 */
export function validateAuthToken(candidate: string, stored: string): boolean {
  if (!candidate || !stored) return false;
  // Constant-time compare to prevent timing attacks
  if (candidate.length !== stored.length) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(stored);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Extract the bearer token from an Authorization header value.
 * Returns the token string or undefined.
 */
export function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : undefined;
}
