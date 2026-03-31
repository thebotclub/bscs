import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  handleListAgents,
  handleGetAgent,
  handleAgentAction,
  handleAgentLogs,
} from '../../../../src/api/routes/agents.js';
import type { BscsConfig } from '../../../../src/util/types.js';

// Mock agent core functions
vi.mock('../../../../src/core/agent.js', () => ({
  getAllAgentStatuses: vi.fn().mockResolvedValue([
    { name: 'alpha', status: 'running', machine: 'localhost', health: 'healthy' },
    { name: 'beta', status: 'stopped', machine: 'localhost', health: 'unknown' },
  ]),
  getAgentStatus: vi.fn().mockImplementation(async (name: string) => {
    if (name === 'alpha') {
      return { name: 'alpha', status: 'running', machine: 'localhost', health: 'healthy' };
    }
    throw new Error(`Agent ${name} not found`);
  }),
  startAgent: vi.fn().mockResolvedValue({ name: 'alpha', status: 'started' }),
  stopAgent: vi.fn().mockResolvedValue({ name: 'alpha', status: 'stopped' }),
  restartAgent: vi.fn().mockResolvedValue({ name: 'alpha', status: 'restarted' }),
  logsAgent: vi.fn().mockImplementation(() => {
    const { EventEmitter } = require('events');
    const proc = new EventEmitter();
    (proc as unknown as Record<string, unknown>).stdout = new EventEmitter();
    (proc as unknown as Record<string, unknown>).stderr = new EventEmitter();
    return proc;
  }),
}));

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

function mockReq(): IncomingMessage {
  return {} as unknown as IncomingMessage;
}

const testConfig: BscsConfig = {
  version: '1.0',
  docker: {
    image: 'ghcr.io/thebotclub/bscs:latest',
    registry: 'ghcr.io',
    security: {
      noNewPrivileges: true,
      capDropAll: true,
      tmpfs: true,
      pidsLimit: 256,
      readOnlyRootfs: false,
    },
    resources: {
      coding: { memory: '2g', pidsLimit: 256 },
      review: { memory: '2g', pidsLimit: 256 },
      brain: { memory: '2g', pidsLimit: 256 },
      ops: { memory: '2g', pidsLimit: 256 },
      default: { memory: '2g', pidsLimit: 256 },
    },
  },
  models: {
    providers: {},
    defaults: {},
    fallbacks: {},
  },
  agents: {
    alpha: {
      name: 'alpha',
      template: 'custom',
      role: 'custom',
      machine: 'localhost',
      runtime: 'docker',
    },
  },
};

describe('handleListAgents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with array of agents', async () => {
    const res = mockRes();
    await handleListAgents(mockReq(), res as unknown as ServerResponse, testConfig);

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(2);
  });

  it('returns agents with name field', async () => {
    const res = mockRes();
    await handleListAgents(mockReq(), res as unknown as ServerResponse, testConfig);

    const data = JSON.parse(res.body) as Array<{ name: string }>;
    expect(data[0]?.name).toBe('alpha');
  });
});

describe('handleGetAgent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with agent details for known agent', async () => {
    const res = mockRes();
    await handleGetAgent(mockReq(), res as unknown as ServerResponse, 'alpha', testConfig);

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { name: string };
    expect(data.name).toBe('alpha');
  });

  it('returns 404 for unknown agent', async () => {
    const res = mockRes();
    await handleGetAgent(mockReq(), res as unknown as ServerResponse, 'nonexistent', testConfig);

    expect(res.statusCode).toBe(404);
  });
});

describe('handleAgentAction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts an agent', async () => {
    const { startAgent } = await import('../../../../src/core/agent.js');
    const res = mockRes();
    await handleAgentAction(mockReq(), res as unknown as ServerResponse, 'alpha', 'start', testConfig);

    expect(startAgent).toHaveBeenCalledWith('alpha');
    expect(res.statusCode).toBe(200);
  });

  it('stops an agent', async () => {
    const { stopAgent } = await import('../../../../src/core/agent.js');
    const res = mockRes();
    await handleAgentAction(mockReq(), res as unknown as ServerResponse, 'alpha', 'stop', testConfig);

    expect(stopAgent).toHaveBeenCalledWith('alpha');
    expect(res.statusCode).toBe(200);
  });

  it('restarts an agent', async () => {
    const { restartAgent } = await import('../../../../src/core/agent.js');
    const res = mockRes();
    await handleAgentAction(mockReq(), res as unknown as ServerResponse, 'alpha', 'restart', testConfig);

    expect(restartAgent).toHaveBeenCalledWith('alpha');
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 for unknown action', async () => {
    const res = mockRes();
    await handleAgentAction(mockReq(), res as unknown as ServerResponse, 'alpha', 'explode', testConfig);

    expect(res.statusCode).toBe(400);
  });
});

describe('handleAgentLogs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 for unknown agent', async () => {
    const res = mockRes();
    await handleAgentLogs(mockReq(), res as unknown as ServerResponse, 'ghost', testConfig);

    expect(res.statusCode).toBe(404);
  });

  it('returns 200 for known agent', async () => {
    const res = mockRes();
    await handleAgentLogs(mockReq(), res as unknown as ServerResponse, 'alpha', testConfig);

    expect(res.statusCode).toBe(200);
  });
});
