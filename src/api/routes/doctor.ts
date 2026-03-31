/**
 * Doctor route handlers: run diagnostics and fix issues.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { BscsConfig } from '../../util/types.js';
import { runDoctor, fixDoctorIssue, type DoctorCheck } from '../../core/doctor.js';
import { jsonResponse, jsonError } from '../middleware/errors.js';

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
 * GET /api/doctor — run the doctor diagnostics and return results.
 */
export async function handleGetDoctor(
  _req: IncomingMessage,
  res: ServerResponse,
  config: BscsConfig,
): Promise<void> {
  try {
    const result = await runDoctor(config, false);
    jsonResponse(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Doctor check failed';
    jsonError(res, message, 500);
  }
}

/**
 * POST /api/doctor/fix — fix a specific doctor issue.
 * Expects JSON body: { check: DoctorCheck }
 */
export async function handleDoctorFix(
  req: IncomingMessage,
  res: ServerResponse,
  config: BscsConfig,
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

  const check =
    parsed !== null && typeof parsed === 'object' && 'check' in parsed
      ? (parsed as Record<string, unknown>)['check']
      : undefined;

  if (!check || typeof check !== 'object') {
    jsonError(res, 'Missing or invalid check field', 400);
    return;
  }

  try {
    const result = await fixDoctorIssue(check as DoctorCheck, config);
    jsonResponse(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Fix failed';
    jsonError(res, message, 500);
  }
}
