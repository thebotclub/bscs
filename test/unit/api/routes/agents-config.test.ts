import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { handleAgentConfig } from '../../../../src/api/routes/agents.js';
import type { BscsConfig } from '../../../../src/util/types.js';

vi.mock('../../../../src/core/agent.js', () => ({
  getAllAgentStatuses: vi.fn().mockResolvedValue([]),
  getAgentStatus: vi.fn().mockResolvedValue({ name: 'alpha', status: 'running', machine: 'localhost', health: 'ok' }),
  startAgent: vi.fn().mockResolvedValue({ name: 'alpha', status: 'started' }),
  stopAgent: vi.fn().mockResolvedValue({ name: 'alpha', status: 'stopped' }),
  restartAgent: vi.fn().mockResolvedValue({ name: 'alpha', status: 'restarted' }),
}));

vi.mock('../../../../src/core/config.js', () => ({
  getAgentConfigPath: vi.fn().mockImplementation((name: string) => `/home/user/.openclaw-${name}/openclaw.json`),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockImplementation(async (path: string) => {
    if (path.includes('alpha')) {
      return JSON.stringify({ name: 'alpha', model: 'claude-opus-4-6', role: 'brain' });
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
}));

function mockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body = '';
  return {
    setHeader: (k: string, v: string) => { headers[k] = v; },
    writeHead: (code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
    },
    end: (data?: string) => { body = data ?? ''; },
    write: (data: string) => { body += data; return true; },
    on: (_event: string, _handler: () => void) => {},
    get headers() { return headers; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
}

function mockReq(): IncomingMessage {
  return {} as unknown as IncomingMessage;
}

const testConfig: BscsConfig = {
  version: '1.0',
  docker: {
    image: 'ghcr.io/thebotclub/bscs:latest',
    registry: 'ghcr.io',
    security: { noNewPrivileges: true, capDropAll: true, tmpfs: true, pidsLimit: 256, readOnlyRootfs: false },
    resources: {
      coding: { memory: '2g', pidsLimit: 256 },
      review: { memory: '2g', pidsLimit: 256 },
      brain: { memory: '2g', pidsLimit: 256 },
      ops: { memory: '2g', pidsLimit: 256 },
      default: { memory: '2g', pidsLimit: 256 },
    },
  },
  models: { providers: {}, defaults: {}, fallbacks: {} },
  agents: {
    alpha: { name: 'alpha', template: 'custom', role: 'custom', machine: 'localhost', runtime: 'docker' },
  },
};

describe('handleAgentConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 for unknown agent', async () => {
    const res = mockRes();
    await handleAgentConfig(mockReq(), res as unknown as ServerResponse, 'ghost', testConfig);
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/not found/i);
  });

  it('returns 200 with config JSON for known agent', async () => {
    const res = mockRes();
    await handleAgentConfig(mockReq(), res as unknown as ServerResponse, 'alpha', testConfig);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { name: string; config: Record<string, unknown> };
    expect(body.name).toBe('alpha');
    expect(body.config).toBeTruthy();
  });

  it('returns config with expected fields', async () => {
    const res = mockRes();
    await handleAgentConfig(mockReq(), res as unknown as ServerResponse, 'alpha', testConfig);
    const body = JSON.parse(res.body) as { name: string; config: { name: string; model: string; role: string } };
    expect(body.config.name).toBe('alpha');
    expect(body.config.model).toBe('claude-opus-4-6');
  });

  it('returns 404 when config file does not exist', async () => {
    const res = mockRes();
    // 'beta' is not in config.agents, so should return 404
    await handleAgentConfig(mockReq(), res as unknown as ServerResponse, 'beta', testConfig);
    expect(res.statusCode).toBe(404);
  });
});
