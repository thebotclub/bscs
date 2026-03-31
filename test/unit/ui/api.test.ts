import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError } from '../../../src/ui/api.js';

// We test the api module by mocking globalThis.fetch
// The api module uses fetch internally

describe('ApiError', () => {
  it('has correct name and message', () => {
    const err = new ApiError('Not found', 404);
    expect(err.name).toBe('ApiError');
    expect(err.message).toBe('Not found');
    expect(err.status).toBe(404);
  });

  it('is an instance of Error', () => {
    const err = new ApiError('Unauthorized', 401);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('api retry logic', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns data on first successful call', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ agents: [], machines: {} }),
    });

    // Re-import to get fresh module with mocked fetch
    const { fetchFleet } = await import('../../../src/ui/api.js');
    const result = await fetchFleet();
    expect(result).toEqual({ agents: [], machines: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws ApiError on 401 without retry', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: 'Unauthorized' }),
    });

    const { api } = await import('../../../src/ui/api.js');
    await expect(api.get('/api/fleet')).rejects.toThrow(ApiError);
    // Should not retry 4xx — called only once
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws ApiError on 404', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Not found' }),
    });

    const { api } = await import('../../../src/ui/api.js');
    await expect(api.get('/api/missing')).rejects.toThrow(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('includes error message from response body', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: 'Forbidden resource' }),
    });

    const { api } = await import('../../../src/ui/api.js');
    try {
      await api.get('/api/secret');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      if (err instanceof ApiError) {
        expect(err.message).toBe('Forbidden resource');
        expect(err.status).toBe(403);
      }
    }
  });

  it('sends POST body as JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, message: 'done' }),
    });

    const { api } = await import('../../../src/ui/api.js');
    const result = await api.post<{ ok: boolean; message: string }>('/api/auth', {
      token: 'abc123',
    });
    expect(result.ok).toBe(true);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[1]?.body).toBe(JSON.stringify({ token: 'abc123' }));
  });
});

describe('startAgent / stopAgent / restartAgent', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('startAgent calls correct endpoint', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, message: 'started' }),
    });
    const { startAgent } = await import('../../../src/ui/api.js');
    const result = await startAgent('my-agent');
    expect(result.ok).toBe(true);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain('/api/agents/my-agent/start');
    expect(call[1]?.method).toBe('POST');
  });

  it('stopAgent calls correct endpoint', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, message: 'stopped' }),
    });
    const { stopAgent } = await import('../../../src/ui/api.js');
    const result = await stopAgent('my-agent');
    expect(result.ok).toBe(true);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain('/api/agents/my-agent/stop');
  });

  it('restartAgent calls correct endpoint', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, message: 'restarted' }),
    });
    const { restartAgent } = await import('../../../src/ui/api.js');
    const result = await restartAgent('my-agent');
    expect(result.ok).toBe(true);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain('/api/agents/my-agent/restart');
  });

  it('encodes agent name with special characters', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, message: 'started' }),
    });
    const { startAgent } = await import('../../../src/ui/api.js');
    await startAgent('agent name/with spaces');
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain(encodeURIComponent('agent name/with spaces'));
  });
});
