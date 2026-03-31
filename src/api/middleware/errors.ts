/**
 * HTTP response helpers for sending JSON and JSON error responses.
 */
import type { ServerResponse } from 'http';

/**
 * Send a JSON response with the given data and status code.
 */
export function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

/**
 * Send a JSON error response: { error: message }.
 */
export function jsonError(res: ServerResponse, message: string, status = 500): void {
  jsonResponse(res, { error: message }, status);
}
