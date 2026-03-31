/**
 * API auth handlers: POST /api/auth and GET /api/auth/check.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { validateAuthToken } from '../core/auth.js';
import { extractAuth, createSessionCookie } from './middleware/auth.js';
import { jsonResponse, jsonError } from './middleware/errors.js';

/**
 * Read the full request body as a string.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * POST /api/auth — accepts JSON body { token: string }.
 * On success: sets bscs_session cookie, returns { ok: true }.
 * On failure: returns { ok: false, error: 'Invalid token' } with 401.
 */
export async function handlePostAuth(
  req: IncomingMessage,
  res: ServerResponse,
  authToken: string,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    jsonError(res, 'Failed to read request body', 400);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    jsonError(res, 'Invalid JSON body', 400);
    return;
  }

  const candidate =
    parsed !== null &&
    typeof parsed === 'object' &&
    'token' in parsed &&
    typeof (parsed as Record<string, unknown>)['token'] === 'string'
      ? (parsed as Record<string, string>)['token']
      : undefined;

  if (!candidate || !validateAuthToken(candidate, authToken)) {
    jsonResponse(res, { ok: false, error: 'Invalid token' }, 401);
    return;
  }

  // Determine whether to set Secure flag: only over HTTPS
  const secure = false; // server runs locally; callers can override if needed
  const cookie = createSessionCookie(candidate, secure);
  res.setHeader('Set-Cookie', cookie);
  jsonResponse(res, { ok: true });
}

/**
 * GET /api/auth/check — check if session is valid.
 * Accepts cookie OR bearer token.
 * Returns { ok: true } or 401.
 */
export function handleGetAuthCheck(
  req: IncomingMessage,
  res: ServerResponse,
  authToken: string,
): void {
  const cookieHeader =
    typeof req.headers['cookie'] === 'string' ? req.headers['cookie'] : undefined;
  const authHeader =
    typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : undefined;

  const candidate = extractAuth(cookieHeader, authHeader);
  if (!candidate || !validateAuthToken(candidate, authToken)) {
    jsonError(res, 'Unauthorized', 401);
    return;
  }

  jsonResponse(res, { ok: true });
}
