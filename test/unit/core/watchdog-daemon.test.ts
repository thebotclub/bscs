import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock docker and config modules
vi.mock('../../../src/core/docker.js', () => ({
  listBscsContainers: vi.fn().mockResolvedValue([
    { name: 'openclaw_agent-1', status: 'running', image: 'test:latest', id: 'abc123' },
    { name: 'openclaw_agent-2', status: 'exited', image: 'test:latest', id: 'def456' },
  ]),
  startContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/core/config.js', () => ({
  loadConfig: () => ({
    agents: {
      'agent-1': { status: 'running', role: 'coding', image: 'test:latest' },
      'agent-2': { status: 'running', role: 'coding', image: 'test:latest' },
    },
  }),
}));

describe('Watchdog daemon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should detect unhealthy containers', async () => {
    const { checkHealth } = await import('../../../src/core/watchdog.js');
    const results = await checkHealth();

    expect(results).toHaveLength(2);
    
    const healthy = results.find((r) => r.name === 'agent-1');
    expect(healthy?.status).toBe('healthy');
    
    const unhealthy = results.find((r) => r.name === 'agent-2');
    expect(unhealthy?.status).toBe('unhealthy');
    expect(unhealthy?.restartNeeded).toBe(true);
  });

  it('should restart unhealthy containers', async () => {
    const { restartUnhealthy, resetRestartCounts } = await import('../../../src/core/watchdog.js');
    const docker = await import('../../../src/core/docker.js');

    resetRestartCounts();
    const results = await restartUnhealthy();

    expect(results.length).toBeGreaterThan(0);
    const restarted = results.find((r) => r.name === 'agent-2');
    expect(restarted?.restarted).toBe(true);
    expect(docker.startContainer).toHaveBeenCalledWith('agent-2');
  });

  it('should start and stop watchdog daemon', async () => {
    const { startWatchdogDaemon, resetRestartCounts } = await import('../../../src/core/watchdog.js');

    resetRestartCounts();
    const onCycle = vi.fn();

    const daemon = startWatchdogDaemon(
      { interval: 1, maxRestarts: 3, cooldownMs: 0 },
      onCycle,
    );

    expect(daemon.running).toBe(true);

    // Wait for at least one cycle
    await new Promise((resolve) => setTimeout(resolve, 100));

    daemon.stop();
    expect(onCycle).toHaveBeenCalled();
  });

  it('should respect max restarts limit', async () => {
    const { restartUnhealthy, resetRestartCounts } = await import('../../../src/core/watchdog.js');

    resetRestartCounts();

    // Exhaust restarts
    await restartUnhealthy({ interval: 30, maxRestarts: 1, cooldownMs: 0 });
    const results = await restartUnhealthy({ interval: 30, maxRestarts: 1, cooldownMs: 0 });

    const agent2 = results.find((r) => r.name === 'agent-2');
    expect(agent2?.restarted).toBe(false);
    expect(agent2?.error).toContain('Max restarts');
  });
});
