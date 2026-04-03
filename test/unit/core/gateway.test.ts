import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock heavy imports to test gateway logic in isolation
const mockLoadConfig = vi.fn();
vi.mock('../../../src/core/config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  saveConfig: vi.fn(),
}));

const mockRecordCostEntry = vi.fn();
vi.mock('../../../src/core/cost.js', () => ({
  recordCostEntry: (...args: unknown[]) => mockRecordCostEntry(...args),
}));

// Default config for tests that don't need custom config
const defaultConfig = () => ({
  models: {
    providers: {
      anthropic: {
        type: 'anthropic' as const,
        apiKey: 'test-key',
        enabled: true,
        local: false,
        gpu: false,
      },
      openai: {
        type: 'openai' as const,
        apiKey: 'test-openai-key',
        enabled: true,
        local: false,
        gpu: false,
      },
    },
    defaults: {
      coding: 'claude-sonnet-4',
    },
    fallbacks: {
      coding: ['claude-sonnet-4', 'gpt-4o'],
    },
  },
});

// Helper to extract headers from RequestInit into a plain object
function extractHeaders(init?: RequestInit): Record<string, string> {
  if (!init?.headers) return {};
  if (init.headers instanceof Headers) return Object.fromEntries(init.headers.entries());
  if (Array.isArray(init.headers)) return Object.fromEntries(init.headers as Array<[string, string]>);
  return init.headers as Record<string, string>;
}

// Helper to intercept only outbound (non-localhost) fetch calls.
// Calls to 127.0.0.1/localhost go through the real fetch (to reach the test gateway).
// All other calls go through the mockFn, which should capture and return a Response.
function interceptOutboundFetch(mockFn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const originalFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    // Let localhost calls go through to the real gateway
    if (urlStr.includes('127.0.0.1') || urlStr.includes('localhost')) {
      return originalFetch(url, init);
    }
    return mockFn(url, init);
  });
  return { spy, originalFetch };
}

// Helper to start gateway and return port + close function
async function startTestGateway(config?: ReturnType<typeof defaultConfig>) {
  mockLoadConfig.mockReturnValue(config ?? defaultConfig());

  const { startGateway } = await import('../../../src/core/gateway.js');
  const port = 19900 + Math.floor(Math.random() * 100);
  const gw = await startGateway(port, '127.0.0.1');
  return { port, close: async () => { await gw.close(); } };
}

// Standard success response for provider mock
function successResponse(overrides?: Partial<{ content: string; promptTokens: number; completionTokens: number }>) {
  return new Response(JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ message: { role: 'assistant', content: overrides?.content ?? 'hi' } }],
    usage: { prompt_tokens: overrides?.promptTokens ?? 10, completion_tokens: overrides?.completionTokens ?? 5, total_tokens: (overrides?.promptTokens ?? 10) + (overrides?.completionTokens ?? 5) },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('Gateway module', () => {
  beforeEach(() => {
    mockLoadConfig.mockReturnValue(defaultConfig());
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(defaultConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should export startGateway function', async () => {
    const gateway = await import('../../../src/core/gateway.js');
    expect(typeof gateway.startGateway).toBe('function');
  });

  it('should start gateway server and respond to health check', async () => {
    const { port, close } = await startTestGateway();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, unknown>;
      expect(data.status).toBe('ok');
      expect(data.gateway).toBe('bscs');
    } finally {
      await close();
    }
  });

  it('should return 404 for unknown routes', async () => {
    const { port, close } = await startTestGateway();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/unknown`);
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('should return 400 for invalid JSON body', async () => {
    const { port, close } = await startTestGateway();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'invalid json{{{',
      });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  describe('resolveProvider matches against provider model lists', () => {
    const multiProviderConfig = () => ({
      models: {
        providers: {
          anthropic: {
            type: 'anthropic' as const,
            apiKey: 'anthropic-key',
            enabled: true,
            models: ['claude-opus-4-6', 'claude-sonnet-4-6'],
          },
          zai: {
            type: 'openai' as const,
            apiKey: 'zai-key',
            enabled: true,
            models: ['glm-5', 'glm-5-turbo'],
          },
          minimax: {
            type: 'anthropic' as const,
            apiKey: 'minimax-key',
            enabled: true,
            models: ['MiniMax-M2.7'],
          },
        },
        defaults: {},
        fallbacks: {},
      },
    });

    it('should route "glm-5-turbo" to zai provider (exact model list match)', async () => {
      const capturedCalls: Array<{ url: string; headers: Record<string, string> }> = [];
      const { spy } = interceptOutboundFetch(async (url, init) => {
        capturedCalls.push({ url: url.toString(), headers: extractHeaders(init) });
        return successResponse();
      });

      const { port, close } = await startTestGateway(multiProviderConfig());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'glm-5-turbo', messages: [{ role: 'user', content: 'hello' }] }),
        });
        expect(res.status).toBe(200);
        // zai provider is type openai, so it should use Bearer auth with zai-key
        const providerCall = capturedCalls.find(c => c.headers['authorization']);
        expect(providerCall).toBeDefined();
        expect(providerCall!.headers['authorization']).toBe('Bearer zai-key');
      } finally {
        await close();
        spy.mockRestore();
      }
    });

    it('should route "MiniMax-M2.7" to minimax provider', async () => {
      const capturedHeaders: Array<Record<string, string>> = [];
      const { spy } = interceptOutboundFetch(async (_url, init) => {
        capturedHeaders.push(extractHeaders(init));
        return successResponse();
      });

      const { port, close } = await startTestGateway(multiProviderConfig());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'MiniMax-M2.7', messages: [{ role: 'user', content: 'hello' }] }),
        });
        expect(res.status).toBe(200);
        // minimax is type anthropic, so it should use x-api-key with minimax-key
        const providerCall = capturedHeaders.find(h => h['x-api-key'] === 'minimax-key');
        expect(providerCall).toBeDefined();
      } finally {
        await close();
        spy.mockRestore();
      }
    });

    it('should route "claude-opus-4-6" to anthropic provider', async () => {
      const capturedHeaders: Array<Record<string, string>> = [];
      const { spy } = interceptOutboundFetch(async (_url, init) => {
        capturedHeaders.push(extractHeaders(init));
        return successResponse();
      });

      const { port, close } = await startTestGateway(multiProviderConfig());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hello' }] }),
        });
        expect(res.status).toBe(200);
        // anthropic provider uses x-api-key
        const providerCall = capturedHeaders.find(h => h['x-api-key'] === 'anthropic-key');
        expect(providerCall).toBeDefined();
      } finally {
        await close();
        spy.mockRestore();
      }
    });

    it('should fallback to prefix inference for unknown models', async () => {
      const capturedCalls: Array<{ url: string; headers: Record<string, string> }> = [];
      const { spy } = interceptOutboundFetch(async (url, init) => {
        capturedCalls.push({ url: url.toString(), headers: extractHeaders(init) });
        return successResponse();
      });

      const { port, close } = await startTestGateway(multiProviderConfig());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }),
        });
        expect(res.status).toBe(200);
        // "gpt-4o-mini" matches "gpt-" prefix, inferring 'openai' type.
        // With this config, the first openai-type provider is "zai" (which has zai-key)
        const providerCall = capturedCalls.find(c => c.headers['authorization']);
        expect(providerCall).toBeDefined();
        expect(providerCall!.headers['authorization']).toContain('Bearer');
      } finally {
        await close();
        spy.mockRestore();
      }
    });
  });

  describe('Provider prefix stripping', () => {
    const prefixConfig = () => ({
      models: {
        providers: {
          anthropic: {
            type: 'anthropic' as const,
            apiKey: 'anthropic-key',
            enabled: true,
            models: ['claude-opus-4-6'],
          },
          zai: {
            type: 'openai' as const,
            apiKey: 'zai-key',
            enabled: true,
            models: ['glm-5'],
          },
          c4140: {
            type: 'openai' as const,
            apiKey: 'c4140-key',
            enabled: true,
            models: ['Qwen/Qwen2.5-72B-Instruct-GPTQ-Int4'],
          },
        },
        defaults: {},
        fallbacks: {},
      },
    });

    it('should strip "anthropic/" prefix and match model list', async () => {
      const capturedHeaders: Array<Record<string, string>> = [];
      const { spy } = interceptOutboundFetch(async (_url, init) => {
        capturedHeaders.push(extractHeaders(init));
        return successResponse();
      });

      const { port, close } = await startTestGateway(prefixConfig());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'anthropic/claude-opus-4-6', messages: [{ role: 'user', content: 'hello' }] }),
        });
        expect(res.status).toBe(200);
        const providerCall = capturedHeaders.find(h => h['x-api-key'] === 'anthropic-key');
        expect(providerCall).toBeDefined();
      } finally {
        await close();
        spy.mockRestore();
      }
    });

    it('should strip "zai/" prefix and match zai provider', async () => {
      const capturedHeaders: Array<Record<string, string>> = [];
      const { spy } = interceptOutboundFetch(async (_url, init) => {
        capturedHeaders.push(extractHeaders(init));
        return successResponse();
      });

      const { port, close } = await startTestGateway(prefixConfig());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'zai/glm-5', messages: [{ role: 'user', content: 'hello' }] }),
        });
        expect(res.status).toBe(200);
        const providerCall = capturedHeaders.find(h => h['authorization'] === 'Bearer zai-key');
        expect(providerCall).toBeDefined();
      } finally {
        await close();
        spy.mockRestore();
      }
    });

    it('should match full model name with slash before stripping prefix', async () => {
      const capturedHeaders: Array<Record<string, string>> = [];
      const { spy } = interceptOutboundFetch(async (_url, init) => {
        capturedHeaders.push(extractHeaders(init));
        return successResponse();
      });

      const { port, close } = await startTestGateway(prefixConfig());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'Qwen/Qwen2.5-72B-Instruct-GPTQ-Int4', messages: [{ role: 'user', content: 'hello' }] }),
        });
        expect(res.status).toBe(200);
        // Full name "Qwen/Qwen2.5-72B-Instruct-GPTQ-Int4" should match c4140's model list directly
        const providerCall = capturedHeaders.find(h => h['authorization'] === 'Bearer c4140-key');
        expect(providerCall).toBeDefined();
      } finally {
        await close();
        spy.mockRestore();
      }
    });
  });

  describe('Fallback chain on non-2xx responses', () => {
    const fallbackConfig = () => ({
      models: {
        providers: {
          providerA: {
            type: 'anthropic' as const,
            apiKey: 'key-a',
            enabled: true,
            models: ['model-a'],
          },
          providerB: {
            type: 'openai' as const,
            apiKey: 'key-b',
            enabled: true,
            models: ['model-b'],
          },
          providerC: {
            type: 'openai' as const,
            apiKey: 'key-c',
            enabled: true,
            models: ['model-c'],
          },
        },
        defaults: {},
        fallbacks: {
          coding: ['model-a', 'model-b', 'model-c'],
        },
      },
    });

    it('should try next provider when first returns non-2xx', async () => {
      let outboundCallCount = 0;
      const { spy } = interceptOutboundFetch(async () => {
        outboundCallCount++;
        // First outbound call: providerA returns 429
        if (outboundCallCount === 1) {
          return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          });
        }
        // Second outbound call: providerB returns 200
        return new Response(JSON.stringify({
          id: 'chatcmpl-test',
          choices: [{ message: { role: 'assistant', content: 'fallback response' } }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const { port, close } = await startTestGateway(fallbackConfig());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hello' }] }),
        });
        expect(res.status).toBe(200);
        const data = await res.json() as Record<string, unknown>;
        expect((data.choices as Array<Record<string, unknown>>)[0]!.message).toEqual({ role: 'assistant', content: 'fallback response' });
        // Should have called outbound fetch at least twice (first failed, second succeeded)
        expect(outboundCallCount).toBeGreaterThanOrEqual(2);
        // Cost recording should have been called on success
        expect(mockRecordCostEntry).toHaveBeenCalledTimes(1);
      } finally {
        await close();
        spy.mockRestore();
      }
    });
  });

  describe('Streaming with fallback', () => {
    it('should return 502 when all streaming providers fail', async () => {
      const { spy } = interceptOutboundFetch(async () => {
        return new Response(null, {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'content-type': 'application/json' },
        });
      });

      const { port, close } = await startTestGateway();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hello' }], stream: true }),
        });
        // Streaming now has fallback support — when all providers fail, returns 502
        expect(res.status).toBe(502);
      } finally {
        await close();
        spy.mockRestore();
      }
    });

    it('should proxy successful stream response', async () => {
      const { spy } = interceptOutboundFetch(async () => {
        return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      });

      const { port, close } = await startTestGateway();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hello' }], stream: true }),
        });
        expect(res.status).toBe(200);
      } finally {
        await close();
        spy.mockRestore();
      }
    });
  });

  describe('Request validation', () => {
    it('should return 400 when model field is missing', async () => {
      const { port, close } = await startTestGateway();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
        });
        expect(res.status).toBe(400);
        const data = await res.json() as Record<string, unknown>;
        expect((data.error as Record<string, unknown>).message).toContain('model');
      } finally {
        await close();
      }
    });

    it('should return 400 when messages field is missing', async () => {
      const { port, close } = await startTestGateway();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4' }),
        });
        expect(res.status).toBe(400);
        const data = await res.json() as Record<string, unknown>;
        expect((data.error as Record<string, unknown>).message).toContain('messages');
      } finally {
        await close();
      }
    });

    it('should return 400 when messages is empty array', async () => {
      const { port, close } = await startTestGateway();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4', messages: [] }),
        });
        expect(res.status).toBe(400);
        const data = await res.json() as Record<string, unknown>;
        expect((data.error as Record<string, unknown>).message).toContain('messages');
      } finally {
        await close();
      }
    });

    it('should pass through request when messages field is missing', async () => {
      const { spy } = interceptOutboundFetch(async () => {
        return successResponse();
      });

      const { port, close } = await startTestGateway();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4' }),
        });
        // Gateway now validates messages field and returns 400 when missing
        expect(res.status).toBe(400);
      } finally {
        await close();
        spy.mockRestore();
      }
    });

    it('should proceed normally with a valid request', async () => {
      const { spy } = interceptOutboundFetch(async () => {
        return successResponse({ content: 'hello!' });
      });

      const { port, close } = await startTestGateway();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hello' }] }),
        });
        expect(res.status).toBe(200);
        const data = await res.json() as Record<string, unknown>;
        expect(data.choices).toBeDefined();
      } finally {
        await close();
        spy.mockRestore();
      }
    });
  });

  describe('Unknown model handling', () => {
    it('should return 400 for model that matches no provider and no prefix', async () => {
      const { port, close } = await startTestGateway();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'totally-unknown-model-xyz', messages: [{ role: 'user', content: 'hello' }] }),
        });
        // Unknown model with no prefix match returns 400
        expect(res.status).toBe(400);
        const data = await res.json() as Record<string, unknown>;
        expect((data.error as Record<string, unknown>).message).toContain('Unknown model');
      } finally {
        await close();
      }
    });
  });

  describe('Anthropic request format conversion (buildAnthropicRequest)', () => {
    const anthroConfig = () => ({
      models: {
        providers: {
          anthropic: {
            type: 'anthropic' as const,
            apiKey: 'test-anthro-key',
            enabled: true,
            models: ['claude-sonnet-4-6'],
          },
        },
        defaults: {},
        fallbacks: {},
      },
    });

    it('should extract system messages into top-level system field', async () => {
      let capturedBody: Record<string, unknown> | undefined;
      let capturedHeaders: Record<string, string> | undefined;
      const { spy } = interceptOutboundFetch(async (_url, init) => {
        capturedBody = JSON.parse(init!.body as string) as Record<string, unknown>;
        capturedHeaders = extractHeaders(init);
        return new Response(JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          model: 'claude-sonnet-4-6-20250401',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 5 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const { port, close } = await startTestGateway(anthroConfig());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            messages: [
              { role: 'system', content: 'You are a helpful assistant.' },
              { role: 'user', content: 'Hello!' },
            ],
          }),
        });
        expect(res.status).toBe(200);

        // System message should be extracted to top-level field
        expect(capturedBody!.system).toBe('You are a helpful assistant.');
        // System message should NOT remain in the messages array
        const messages = capturedBody!.messages as Array<{ role: string; content: unknown }>;
        expect(messages.find(m => m.role === 'system')).toBeUndefined();
        // Only the user message should remain
        expect(messages).toHaveLength(1);
        expect(messages[0]!.role).toBe('user');
      } finally {
        await close();
        spy.mockRestore();
      }
    });

    it('should convert plain string content to Anthropic text content blocks', async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const { spy } = interceptOutboundFetch(async (_url, init) => {
        capturedBody = JSON.parse(init!.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'response' }],
          model: 'claude-sonnet-4-6-20250401',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 15, output_tokens: 3 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const { port, close } = await startTestGateway(anthroConfig());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            messages: [
              { role: 'user', content: 'Hello!' },
              { role: 'assistant', content: 'Hi there!' },
            ],
          }),
        });
        expect(res.status).toBe(200);

        const messages = capturedBody!.messages as Array<{ role: string; content: unknown }>;
        expect(messages).toHaveLength(2);
        // Each message content should be converted to [{type: "text", text: "..."}]
        expect(messages[0]!.content).toEqual([{ type: 'text', text: 'Hello!' }]);
        expect(messages[1]!.content).toEqual([{ type: 'text', text: 'Hi there!' }]);
      } finally {
        await close();
        spy.mockRestore();
      }
    });

    it('should pass through already-array content blocks unchanged', async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const { spy } = interceptOutboundFetch(async (_url, init) => {
        capturedBody = JSON.parse(init!.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'response' }],
          model: 'claude-sonnet-4-6-20250401',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 15, output_tokens: 3 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const { port, close } = await startTestGateway(anthroConfig());
      try {
        const multimodalContent = [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abcd' } },
          { type: 'text', text: 'What is this?' },
        ];
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            messages: [
              { role: 'user', content: multimodalContent },
            ],
          }),
        });
        expect(res.status).toBe(200);

        const messages = capturedBody!.messages as Array<{ role: string; content: unknown }>;
        expect(messages).toHaveLength(1);
        // Already-array content should be passed through as-is
        expect(messages[0]!.content).toEqual(multimodalContent);
      } finally {
        await close();
        spy.mockRestore();
      }
    });

    it('should send anthropic-version header 2025-04-01', async () => {
      let capturedHeaders: Record<string, string> | undefined;
      const { spy } = interceptOutboundFetch(async (_url, init) => {
        capturedHeaders = extractHeaders(init);
        return new Response(JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-sonnet-4-6-20250401',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const { port, close } = await startTestGateway(anthroConfig());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'test' }] }),
        });
        expect(res.status).toBe(200);
        expect(capturedHeaders!['anthropic-version']).toBe('2025-04-01');
      } finally {
        await close();
        spy.mockRestore();
      }
    });

    it('should prefer explicit top-level system over extracted system messages', async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const { spy } = interceptOutboundFetch(async (_url, init) => {
        capturedBody = JSON.parse(init!.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-sonnet-4-6-20250401',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const { port, close } = await startTestGateway(anthroConfig());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            system: 'Explicit system prompt',
            messages: [
              { role: 'system', content: 'Should be ignored in favor of top-level' },
              { role: 'user', content: 'Hello' },
            ],
          }),
        });
        expect(res.status).toBe(200);
        // Top-level system should take precedence
        expect(capturedBody!.system).toBe('Explicit system prompt');
        // System role should still be filtered out of messages
        const messages = capturedBody!.messages as Array<{ role: string }>;
        expect(messages.find(m => m.role === 'system')).toBeUndefined();
      } finally {
        await close();
        spy.mockRestore();
      }
    });
  });

  describe('Cost tracking with prefixed model names', () => {
    it('should record cost with the model name as used in the request', async () => {
      const { spy } = interceptOutboundFetch(async () => {
        return successResponse({ promptTokens: 100, completionTokens: 50 });
      });

      const { port, close } = await startTestGateway();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'anthropic/claude-opus-4-6', messages: [{ role: 'user', content: 'hello' }] }),
        });
        expect(res.status).toBe(200);
        expect(mockRecordCostEntry).toHaveBeenCalledTimes(1);
        const entry = mockRecordCostEntry.mock.calls[0]![0] as Record<string, unknown>;
        // The gateway records cost with the fallbackModel, which for no matching fallback
        // chain is just body.model (the prefixed name)
        expect(entry.model).toBe('anthropic/claude-opus-4-6');
      } finally {
        await close();
        spy.mockRestore();
      }
    });
  });
});
