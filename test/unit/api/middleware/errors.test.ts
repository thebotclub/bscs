import { describe, it, expect } from 'vitest';
import type { ServerResponse } from 'http';
import { jsonResponse, jsonError } from '../../../../src/api/middleware/errors.js';

function mockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body = '';
  return {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    writeHead: (code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
    },
    end: (data?: string) => {
      body = data ?? '';
    },
    write: (data: string) => {
      body += data;
      return true;
    },
    on: (_event: string, _handler: () => void) => {},
    get headers() {
      return headers;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
}

describe('jsonResponse', () => {
  it('sets Content-Type to application/json', () => {
    const res = mockRes();
    jsonResponse(res as unknown as ServerResponse, { ok: true });
    expect(res.headers['Content-Type']).toBe('application/json');
  });

  it('writes JSON-serialized body', () => {
    const res = mockRes();
    jsonResponse(res as unknown as ServerResponse, { ok: true, count: 3 });
    expect(JSON.parse(res.body)).toEqual({ ok: true, count: 3 });
  });

  it('uses status 200 by default', () => {
    const res = mockRes();
    jsonResponse(res as unknown as ServerResponse, {});
    expect(res.statusCode).toBe(200);
  });

  it('uses provided status code', () => {
    const res = mockRes();
    jsonResponse(res as unknown as ServerResponse, { ok: true }, 201);
    expect(res.statusCode).toBe(201);
  });

  it('handles non-object data (array)', () => {
    const res = mockRes();
    jsonResponse(res as unknown as ServerResponse, [1, 2, 3]);
    expect(JSON.parse(res.body)).toEqual([1, 2, 3]);
  });
});

describe('jsonError', () => {
  it('wraps message in { error } object', () => {
    const res = mockRes();
    jsonError(res as unknown as ServerResponse, 'Not found', 404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
  });

  it('defaults to status 500', () => {
    const res = mockRes();
    jsonError(res as unknown as ServerResponse, 'Internal error');
    expect(res.statusCode).toBe(500);
  });

  it('uses provided status code', () => {
    const res = mockRes();
    jsonError(res as unknown as ServerResponse, 'Unauthorized', 401);
    expect(res.statusCode).toBe(401);
  });

  it('sets Content-Type to application/json', () => {
    const res = mockRes();
    jsonError(res as unknown as ServerResponse, 'Bad request', 400);
    expect(res.headers['Content-Type']).toBe('application/json');
  });
});
