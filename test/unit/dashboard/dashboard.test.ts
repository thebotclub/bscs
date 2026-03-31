import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

// ── Auth helpers ──────────────────────────────────────────────────────

describe('Auth: loadOrCreateAuthToken', () => {
  let tempDir: string;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-auth-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    origConfigDir = process.env.BSCS_CONFIG_DIR;
    process.env.BSCS_CONFIG_DIR = tempDir;
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    if (origConfigDir !== undefined) process.env.BSCS_CONFIG_DIR = origConfigDir;
    else delete process.env.BSCS_CONFIG_DIR;
  });

  it('creates a 64-char hex token on first call', async () => {
    const { loadOrCreateAuthToken } = await import('../../../src/core/auth.js');
    const token = loadOrCreateAuthToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same token on subsequent calls (persisted)', async () => {
    const { loadOrCreateAuthToken } = await import('../../../src/core/auth.js');
    const t1 = loadOrCreateAuthToken();
    const t2 = loadOrCreateAuthToken();
    expect(t1).toBe(t2);
  });
});

// ── Auth: validateAuthToken ───────────────────────────────────────────

describe('Auth: validateAuthToken', () => {
  it('returns true for matching tokens (constant-time)', async () => {
    const { validateAuthToken } = await import('../../../src/core/auth.js');
    expect(validateAuthToken('abc123', 'abc123')).toBe(true);
  });

  it('returns false for mismatched tokens', async () => {
    const { validateAuthToken } = await import('../../../src/core/auth.js');
    expect(validateAuthToken('abc123', 'abc124')).toBe(false);
  });

  it('returns false when candidate is empty', async () => {
    const { validateAuthToken } = await import('../../../src/core/auth.js');
    expect(validateAuthToken('', 'abc123')).toBe(false);
  });

  it('returns false when stored is empty', async () => {
    const { validateAuthToken } = await import('../../../src/core/auth.js');
    expect(validateAuthToken('abc123', '')).toBe(false);
  });

  it('returns false for different-length tokens', async () => {
    const { validateAuthToken } = await import('../../../src/core/auth.js');
    expect(validateAuthToken('short', 'muchlongertoken')).toBe(false);
  });
});

// ── Auth: extractBearerToken ──────────────────────────────────────────

describe('Auth: extractBearerToken', () => {
  it('extracts token from valid Bearer header', async () => {
    const { extractBearerToken } = await import('../../../src/core/auth.js');
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('returns undefined for missing header', async () => {
    const { extractBearerToken } = await import('../../../src/core/auth.js');
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  it('returns undefined for non-Bearer auth scheme', async () => {
    const { extractBearerToken } = await import('../../../src/core/auth.js');
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeUndefined();
  });

  it('returns undefined for malformed header', async () => {
    const { extractBearerToken } = await import('../../../src/core/auth.js');
    expect(extractBearerToken('Bearer')).toBeUndefined();
  });
});

// ── WebSocket frame builder ───────────────────────────────────────────

describe('buildWsFrame', () => {
  let buildWsFrame: typeof import('../../../src/dashboard/server.js').buildWsFrame;

  beforeAll(async () => {
    ({ buildWsFrame } = await import('../../../src/dashboard/server.js'));
  });

  it('encodes short payload (≤125 bytes) with 2-byte header', () => {
    const msg = 'hello';
    const frame = buildWsFrame(msg);
    // Byte 0: 0x81 (FIN + text opcode)
    expect(frame[0]).toBe(0x81);
    // Byte 1: payload length (5)
    expect(frame[1]).toBe(5);
    expect(frame.length).toBe(2 + 5);
  });

  it('encodes medium payload (126–65535 bytes) with 4-byte header and 16-bit length', () => {
    const msg = 'x'.repeat(200);
    const frame = buildWsFrame(msg);
    expect(frame[0]).toBe(0x81);
    expect(frame[1]).toBe(0x7e); // 126 = extended 16-bit length marker
    const len = frame.readUInt16BE(2);
    expect(len).toBe(200);
    expect(frame.length).toBe(4 + 200);
  });

  it('encodes large payload (>65535 bytes) with 10-byte header and 64-bit length', () => {
    const msg = 'x'.repeat(70000);
    const frame = buildWsFrame(msg);
    expect(frame[0]).toBe(0x81);
    expect(frame[1]).toBe(0x7f); // 127 = extended 64-bit length marker
    // high 32 bits = 0
    expect(frame.readUInt32BE(2)).toBe(0);
    // low 32 bits = 70000
    expect(frame.readUInt32BE(6)).toBe(70000);
    expect(frame.length).toBe(10 + 70000);
  });

  it('correctly encodes a 125-byte payload (boundary)', () => {
    const msg = 'y'.repeat(125);
    const frame = buildWsFrame(msg);
    expect(frame[1]).toBe(125);
    expect(frame.length).toBe(2 + 125);
  });

  it('correctly encodes a 126-byte payload (first extended case)', () => {
    const msg = 'y'.repeat(126);
    const frame = buildWsFrame(msg);
    expect(frame[1]).toBe(0x7e);
    expect(frame.readUInt16BE(2)).toBe(126);
    expect(frame.length).toBe(4 + 126);
  });
});
