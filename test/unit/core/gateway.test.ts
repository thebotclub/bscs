import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock heavy imports to test gateway logic in isolation
vi.mock('../../../src/core/config.js', () => ({
  loadConfig: () => ({
    models: {
      providers: {
        anthropic: {
          type: 'anthropic',
          apiKey: 'test-key',
          enabled: true,
          local: false,
          gpu: false,
        },
        openai: {
          type: 'openai',
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
  }),
}));

vi.mock('../../../src/core/cost.js', () => ({
  recordCostEntry: vi.fn(),
}));

describe('Gateway module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export startGateway function', async () => {
    const gateway = await import('../../../src/core/gateway.js');
    expect(typeof gateway.startGateway).toBe('function');
  });

  it('should start gateway server and respond to health check', async () => {
    const { startGateway } = await import('../../../src/core/gateway.js');

    // Use a random high port to avoid conflicts
    const port = 19900 + Math.floor(Math.random() * 100);
    const gw = await startGateway(port, '127.0.0.1');

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, unknown>;
      expect(data.status).toBe('ok');
      expect(data.gateway).toBe('bscs');
    } finally {
      gw.close();
    }
  });

  it('should return 404 for unknown routes', async () => {
    const { startGateway } = await import('../../../src/core/gateway.js');

    const port = 19900 + Math.floor(Math.random() * 100);
    const gw = await startGateway(port, '127.0.0.1');

    try {
      const res = await fetch(`http://127.0.0.1:${port}/unknown`);
      expect(res.status).toBe(404);
    } finally {
      gw.close();
    }
  });

  it('should return 400 for invalid JSON body', async () => {
    const { startGateway } = await import('../../../src/core/gateway.js');

    const port = 19900 + Math.floor(Math.random() * 100);
    const gw = await startGateway(port, '127.0.0.1');

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'invalid json{{{',
      });
      expect(res.status).toBe(400);
    } finally {
      gw.close();
    }
  });
});
