import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { handlePostAuth, handleGetAuthCheck } from '../../../src/api/auth.js';

// Build a mock ServerResponse-like object
function mockRes() {
  const headers: Record<string, string | string[]> = {};
  let statusCode = 200;
  let body = '';
  return {
    setHeader: (k: string, v: string | string[]) => {
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

// Build a mock IncomingMessage that emits data/end for a given body
function mockReq(bodyStr: string, extraHeaders: Record<string, string> = {}): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage;
  (emitter as unknown as Record<string, unknown>).headers = extraHeaders;
  process.nextTick(() => {
    emitter.emit('data', Buffer.from(bodyStr));
    emitter.emit('end');
  });
  return emitter;
}

const VALID_TOKEN = 'secret-token-123';

describe('handlePostAuth', () => {
  it('accepts a valid token, sets session cookie, returns { ok: true }', async () => {
    const req = mockReq(JSON.stringify({ token: VALID_TOKEN }));
    const res = mockRes();
    await handlePostAuth(req, res as unknown as ServerResponse, VALID_TOKEN);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    const setCookie = res.headers['Set-Cookie'];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toContain('bscs_session=');
  });

  it('rejects invalid token with 401', async () => {
    const req = mockReq(JSON.stringify({ token: 'wrong-token' }));
    const res = mockRes();
    await handlePostAuth(req, res as unknown as ServerResponse, VALID_TOKEN);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it('rejects empty body with 401 or 400', async () => {
    const req = mockReq('');
    const res = mockRes();
    await handlePostAuth(req, res as unknown as ServerResponse, VALID_TOKEN);

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects body without token field with 401', async () => {
    const req = mockReq(JSON.stringify({ other: 'value' }));
    const res = mockRes();
    await handlePostAuth(req, res as unknown as ServerResponse, VALID_TOKEN);

    expect(res.statusCode).toBe(401);
  });

  it('rejects malformed JSON body', async () => {
    const req = mockReq('not-json');
    const res = mockRes();
    await handlePostAuth(req, res as unknown as ServerResponse, VALID_TOKEN);

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('handleGetAuthCheck', () => {
  it('returns { ok: true } for valid session cookie', () => {
    const req = mockReq('', { cookie: 'bscs_session=' + VALID_TOKEN });
    const res = mockRes();
    handleGetAuthCheck(req, res as unknown as ServerResponse, VALID_TOKEN);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('returns { ok: true } for valid bearer token', () => {
    const req = mockReq('', { authorization: 'Bearer ' + VALID_TOKEN });
    const res = mockRes();
    handleGetAuthCheck(req, res as unknown as ServerResponse, VALID_TOKEN);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('returns 401 for invalid token', () => {
    const req = mockReq('', { authorization: 'Bearer wrong' });
    const res = mockRes();
    handleGetAuthCheck(req, res as unknown as ServerResponse, VALID_TOKEN);

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when no auth provided', () => {
    const req = mockReq('', {});
    const res = mockRes();
    handleGetAuthCheck(req, res as unknown as ServerResponse, VALID_TOKEN);

    expect(res.statusCode).toBe(401);
  });

  it('prefers cookie over bearer token', () => {
    const req = mockReq('', {
      cookie: 'bscs_session=' + VALID_TOKEN,
      authorization: 'Bearer wrong',
    });
    const res = mockRes();
    handleGetAuthCheck(req, res as unknown as ServerResponse, VALID_TOKEN);

    expect(res.statusCode).toBe(200);
  });
});
