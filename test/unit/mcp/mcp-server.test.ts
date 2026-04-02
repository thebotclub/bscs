import { describe, it, expect, vi } from 'vitest';

// Mock all heavy dependencies
vi.mock('../../../src/core/fleet.js', () => ({
  getFleetStatus: vi.fn().mockResolvedValue({
    agents: [],
    machines: [],
    totalAgents: 0,
    runningAgents: 0,
  }),
  computeReconcileChanges: vi.fn().mockResolvedValue([]),
  applyReconcileChange: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../../../src/core/agent.js', () => ({
  createAgent: vi.fn().mockResolvedValue({ name: 'test', status: 'created' }),
  destroyAgent: vi.fn().mockResolvedValue({ name: 'test', destroyed: true }),
  restartAgent: vi.fn().mockResolvedValue({ name: 'test', status: 'running' }),
  logsAgent: vi.fn().mockReturnValue({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((_event: string, cb: () => void) => cb()),
    kill: vi.fn(),
  }),
}));

vi.mock('../../../src/core/cost.js', () => ({
  getCostData: vi.fn().mockReturnValue([]),
  generateCostReport: vi.fn().mockReturnValue({ period: {}, total: 0 }),
}));

vi.mock('../../../src/core/security.js', () => ({
  runSecurityAudit: vi.fn().mockReturnValue({ passed: 5, failed: 0, checks: [] }),
}));

describe('MCP Server', () => {
  it('should export startMcpServer function', async () => {
    const { startMcpServer } = await import('../../../src/mcp/server.js');
    expect(typeof startMcpServer).toBe('function');
  });
});
