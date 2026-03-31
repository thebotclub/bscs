import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { createFleetHandler, FLEET_CACHE_TTL } from '../../../../src/api/routes/fleet.js';
import type { BscsConfig } from '../../../../src/util/types.js';

// Mock the fleet module
vi.mock('../../../../src/core/fleet.js', () => ({
  getFleetStatus: vi.fn().mockResolvedValue({
    fleetName: 'test-fleet',
    controller: 'local',
    machines: {},
    agents: [],
    summary: { total: 0, running: 0, stopped: 0, unknown: 0 },
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
};

describe('createFleetHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a function', () => {
    const handler = createFleetHandler(testConfig);
    expect(typeof handler).toBe('function');
  });

  it('responds with 200 and JSON fleet data', async () => {
    const handler = createFleetHandler(testConfig);
    const res = mockRes();
    await handler(mockReq(), res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty('fleetName', 'test-fleet');
  });

  it('sets Content-Type to application/json', async () => {
    const handler = createFleetHandler(testConfig);
    const res = mockRes();
    await handler(mockReq(), res as unknown as ServerResponse);

    expect(res.headers['Content-Type']).toBe('application/json');
  });

  it('uses cache on second call (getFleetStatus called once)', async () => {
    const { getFleetStatus } = await import('../../../../src/core/fleet.js');
    const handler = createFleetHandler(testConfig);

    const res1 = mockRes();
    const res2 = mockRes();
    await handler(mockReq(), res1 as unknown as ServerResponse);
    await handler(mockReq(), res2 as unknown as ServerResponse);

    expect(getFleetStatus).toHaveBeenCalledTimes(1);
    expect(res1.body).toBe(res2.body);
  });

  it('each factory call has its own independent cache', async () => {
    const { getFleetStatus } = await import('../../../../src/core/fleet.js');
    const h1 = createFleetHandler(testConfig);
    const h2 = createFleetHandler(testConfig);

    await h1(mockReq(), mockRes() as unknown as ServerResponse);
    await h2(mockReq(), mockRes() as unknown as ServerResponse);

    expect(getFleetStatus).toHaveBeenCalledTimes(2);
  });
});

describe('FLEET_CACHE_TTL', () => {
  it('is 15000 ms', () => {
    expect(FLEET_CACHE_TTL).toBe(15000);
  });
});
