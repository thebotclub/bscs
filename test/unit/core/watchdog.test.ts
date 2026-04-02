import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, saveConfig } from '../../../src/core/config.js';

// Mock docker
vi.mock('../../../src/core/docker.js', () => ({
  listBscsContainers: vi.fn().mockResolvedValue([]),
  startContainer: vi.fn().mockResolvedValue(undefined),
}));

// Mock the runtime module so we can control OpenClawRuntime behavior
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockHealthCheck = vi.fn().mockImplementation((name: string) => Promise.resolve({
  name,
  status: 'unhealthy',
  containerStatus: 'gateway-down',
  restartNeeded: true,
  lastCheck: new Date().toISOString(),
  error: 'Gateway unreachable',
}));
const mockList = vi.fn().mockResolvedValue([]);
const mockOpenClawRuntime = {
  start: mockStart,
  stop: vi.fn().mockResolvedValue(undefined),
  restart: vi.fn().mockResolvedValue(undefined),
  healthCheck: mockHealthCheck,
  list: mockList,
  status: vi.fn().mockResolvedValue({ name: 'test', status: 'running' }),
  create: vi.fn(),
  destroy: vi.fn(),
  logs: vi.fn(),
  shell: vi.fn(),
  isAvailable: vi.fn().mockResolvedValue(true),
};

vi.mock('../../../src/core/runtime/index.js', () => ({
  getRuntime: vi.fn((type: string) => {
    if (type === 'openclaw') return mockOpenClawRuntime;
    // For docker, delegate to real docker mock (mimic DockerRuntime behavior)
    return {
      list: async () => {
        const { listBscsContainers } = await import('../../../src/core/docker.js');
        const containers = await listBscsContainers();
        // Strip openclaw_ prefix like real DockerRuntime
        return containers.map((c: { name: string; status: string }) => ({
          name: c.name.replace('openclaw_', ''),
          status: c.status,
        }));
      },
      start: async (name: string) => {
        const { startContainer } = await import('../../../src/core/docker.js');
        return startContainer(name);
      },
      healthCheck: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      create: vi.fn(),
      destroy: vi.fn(),
      logs: vi.fn(),
      shell: vi.fn(),
      status: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
    };
  }),
}));

describe('Core Watchdog Module', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-watchdog-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    originalConfigDir = process.env.BSCS_CONFIG_DIR;
    process.env.BSCS_CONFIG_DIR = tempDir;
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    if (originalConfigDir) {
      process.env.BSCS_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.BSCS_CONFIG_DIR;
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('checkHealth', () => {
    it('should return empty when no agents', async () => {
      const { checkHealth } = await import('../../../src/core/watchdog.js');
      const results = await checkHealth();
      expect(results).toEqual([]);
    });

    it('should detect missing containers', async () => {
      const { checkHealth } = await import('../../../src/core/watchdog.js');
      const config = loadConfig();
      config.agents = { 'test-agent': { name: 'test-agent', status: 'running' } };
      saveConfig(config);
      const results = await checkHealth();
      expect(results).toHaveLength(1);
      expect(results[0]!.status).toBe('unhealthy');
      expect(results[0]!.restartNeeded).toBe(true);
    });

    it('should report healthy running containers', async () => {
      const { checkHealth } = await import('../../../src/core/watchdog.js');
      const { listBscsContainers } = await import('../../../src/core/docker.js');
      vi.mocked(listBscsContainers).mockResolvedValue([
        { id: 'c1', name: 'openclaw_test', image: 'test', status: 'running', ports: {} },
      ]);
      const config = loadConfig();
      config.agents = { test: { name: 'test', status: 'running' } };
      saveConfig(config);
      const results = await checkHealth();
      expect(results[0]!.status).toBe('healthy');
      expect(results[0]!.restartNeeded).toBe(false);
    });
  });

  describe('restartUnhealthy', () => {
    it('should restart missing containers', async () => {
      const { restartUnhealthy, resetRestartCounts } = await import('../../../src/core/watchdog.js');
      resetRestartCounts();
      const config = loadConfig();
      config.agents = { 'test-agent': { name: 'test-agent', status: 'running' } };
      saveConfig(config);
      const results = await restartUnhealthy();
      expect(results).toHaveLength(1);
      expect(results[0]!.restarted).toBe(true);
    });

    it('should respect max restart count', async () => {
      const { restartUnhealthy, resetRestartCounts } = await import('../../../src/core/watchdog.js');
      resetRestartCounts();
      const config = loadConfig();
      config.agents = { 'test-agent': { name: 'test-agent', status: 'running' } };
      saveConfig(config);

      // Exhaust restarts
      await restartUnhealthy({ interval: 30, maxRestarts: 1, cooldownMs: 0 });
      const results = await restartUnhealthy({ interval: 30, maxRestarts: 1, cooldownMs: 0 });
      expect(results[0]!.restarted).toBe(false);
      expect(results[0]!.error).toContain('Max restarts');
    });
  });

  describe('resetRestartCounts', () => {
    it('should clear all restart counts', async () => {
      const { restartUnhealthy, resetRestartCounts } = await import('../../../src/core/watchdog.js');
      const config = loadConfig();
      config.agents = { 'test-agent': { name: 'test-agent', status: 'running' } };
      saveConfig(config);

      await restartUnhealthy({ interval: 30, maxRestarts: 1, cooldownMs: 0 });
      resetRestartCounts();
      const results = await restartUnhealthy({ interval: 30, maxRestarts: 1, cooldownMs: 0 });
      expect(results[0]!.restarted).toBe(true);
    });
  });

  describe('gateway-aware restarts (WP-17)', () => {
    it('should issue one restart for 4 agents on same down gateway', async () => {
      const { restartUnhealthy, resetRestartCounts, checkHealth } = await import('../../../src/core/watchdog.js');
      resetRestartCounts();

      // Set up 4 openclaw agents on same gateway
      const config = loadConfig();
      const gwUrl = 'http://gw.test:18777';
      config.agents = {
        'oc-a': { name: 'oc-a', status: 'running', runtime: 'openclaw', openclaw: { gatewayUrl: gwUrl } },
        'oc-b': { name: 'oc-b', status: 'running', runtime: 'openclaw', openclaw: { gatewayUrl: gwUrl } },
        'oc-c': { name: 'oc-c', status: 'running', runtime: 'openclaw', openclaw: { gatewayUrl: gwUrl } },
        'oc-d': { name: 'oc-d', status: 'running', runtime: 'openclaw', openclaw: { gatewayUrl: gwUrl } },
      };
      saveConfig(config);

      // Gateway is down — healthCheck returns unhealthy for all (default mock already does this)
      mockStart.mockClear();

      const results = await restartUnhealthy({ interval: 30, maxRestarts: 5, cooldownMs: 0 });

      // All 4 should be marked as restarted
      expect(results).toHaveLength(4);
      for (const r of results) {
        expect(r.restarted).toBe(true);
      }
      // But only one start() call was made (gateway-level restart)
      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    it('should not restart gateway again within cooldown window', async () => {
      const { restartUnhealthy, resetRestartCounts } = await import('../../../src/core/watchdog.js');
      resetRestartCounts();

      const config = loadConfig();
      const gwUrl = 'http://gw.test:18777';
      config.agents = {
        'oc-x': { name: 'oc-x', status: 'running', runtime: 'openclaw', openclaw: { gatewayUrl: gwUrl } },
        'oc-y': { name: 'oc-y', status: 'running', runtime: 'openclaw', openclaw: { gatewayUrl: gwUrl } },
      };
      saveConfig(config);

      // Default mock returns unhealthy/gateway-down
      mockStart.mockClear();

      // First restart succeeds
      const r1 = await restartUnhealthy({ interval: 30, maxRestarts: 5, cooldownMs: 10000 });
      expect(r1.every((r) => r.restarted)).toBe(true);
      expect(mockStart).toHaveBeenCalledTimes(1);

      // Second attempt — within cooldown (cooldownMs * 3 = 30000)
      const r2 = await restartUnhealthy({ interval: 30, maxRestarts: 5, cooldownMs: 10000 });
      expect(r2.every((r) => !r.restarted)).toBe(true);
      expect(r2[0]!.error).toContain('cooldown');
      // No additional start call
      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    it('should restart docker and openclaw agents independently', async () => {
      const { restartUnhealthy, resetRestartCounts } = await import('../../../src/core/watchdog.js');
      resetRestartCounts();

      const config = loadConfig();
      const gwUrl = 'http://gw-up.test:18777';
      // 1 docker agent (missing container → unhealthy) + 1 openclaw agent (gateway down → unhealthy)
      config.agents = {
        'docker-bad': { name: 'docker-bad', status: 'running' },
        'oc-bad2': { name: 'oc-bad2', status: 'running', runtime: 'openclaw', openclaw: { gatewayUrl: gwUrl } },
      };
      saveConfig(config);

      // Default mock already returns unhealthy/gateway-down for openclaw
      mockStart.mockClear();

      const results = await restartUnhealthy({ interval: 30, maxRestarts: 5, cooldownMs: 0 });

      expect(results).toHaveLength(2);
      const dockerResult = results.find((r) => r.name === 'docker-bad');
      const ocResult = results.find((r) => r.name === 'oc-bad2');
      expect(dockerResult?.restarted).toBe(true);
      expect(ocResult?.restarted).toBe(true);
      // openclaw start called once (gateway restart), docker start called via docker runtime
      expect(mockStart).toHaveBeenCalledTimes(1);
    });
  });

  describe('per-agent restart on healthy gateway', () => {
    it('should restart individual agent when gateway is up but agent is down', async () => {
      const { restartUnhealthy, resetRestartCounts } = await import('../../../src/core/watchdog.js');
      resetRestartCounts();

      const config = loadConfig();
      const gwUrl = 'http://gw-ok.test:18777';
      config.agents = {
        'oc-sick': { name: 'oc-sick', status: 'running', runtime: 'openclaw', openclaw: { gatewayUrl: gwUrl } },
      };
      saveConfig(config);

      // Agent is unhealthy but NOT gateway-down
      mockHealthCheck.mockImplementationOnce((name: string) => Promise.resolve({
        name,
        status: 'unhealthy',
        containerStatus: 'agent-stopped',
        restartNeeded: true,
        lastCheck: new Date().toISOString(),
        error: 'Agent not responding',
      }));
      mockStart.mockClear();

      const results = await restartUnhealthy({ interval: 30, maxRestarts: 5, cooldownMs: 0 });
      expect(results).toHaveLength(1);
      expect(results[0]!.restarted).toBe(true);
      expect(results[0]!.name).toBe('oc-sick');
      // start() called with agent name (per-agent restart, not gateway)
      expect(mockStart).toHaveBeenCalledWith('oc-sick');
    });

    it('should respect max restarts for per-agent key', async () => {
      const { restartUnhealthy, resetRestartCounts } = await import('../../../src/core/watchdog.js');
      resetRestartCounts();

      const config = loadConfig();
      const gwUrl = 'http://gw-ok.test:18777';
      config.agents = {
        'oc-flaky': { name: 'oc-flaky', status: 'running', runtime: 'openclaw', openclaw: { gatewayUrl: gwUrl } },
      };
      saveConfig(config);

      // Always return agent-stopped (not gateway-down)
      mockHealthCheck.mockImplementation((name: string) => Promise.resolve({
        name,
        status: 'unhealthy',
        containerStatus: 'agent-stopped',
        restartNeeded: true,
        lastCheck: new Date().toISOString(),
        error: 'Agent not responding',
      }));
      mockStart.mockClear();

      // Exhaust the 1 allowed restart
      const r1 = await restartUnhealthy({ interval: 30, maxRestarts: 1, cooldownMs: 0 });
      expect(r1[0]!.restarted).toBe(true);

      // Second attempt should be blocked
      const r2 = await restartUnhealthy({ interval: 30, maxRestarts: 1, cooldownMs: 0 });
      expect(r2[0]!.restarted).toBe(false);
      expect(r2[0]!.error).toContain('Max restarts');

      // Reset clears it
      resetRestartCounts('oc-flaky');
      const r3 = await restartUnhealthy({ interval: 30, maxRestarts: 1, cooldownMs: 0 });
      expect(r3[0]!.restarted).toBe(true);
    });

    it('should reset namespaced agent: keys via resetRestartCounts', async () => {
      const { restartUnhealthy, resetRestartCounts } = await import('../../../src/core/watchdog.js');
      resetRestartCounts();

      const config = loadConfig();
      const gwUrl = 'http://gw-ok.test:18777';
      config.agents = {
        'oc-ns': { name: 'oc-ns', status: 'running', runtime: 'openclaw', openclaw: { gatewayUrl: gwUrl } },
      };
      saveConfig(config);

      mockHealthCheck.mockImplementation((name: string) => Promise.resolve({
        name,
        status: 'unhealthy',
        containerStatus: 'agent-stopped',
        restartNeeded: true,
        lastCheck: new Date().toISOString(),
        error: 'Agent not responding',
      }));

      // Exhaust restarts
      await restartUnhealthy({ interval: 30, maxRestarts: 1, cooldownMs: 0 });
      const blocked = await restartUnhealthy({ interval: 30, maxRestarts: 1, cooldownMs: 0 });
      expect(blocked[0]!.restarted).toBe(false);

      // Reset by name should clear agent:oc-ns too
      resetRestartCounts('oc-ns');
      const unblocked = await restartUnhealthy({ interval: 30, maxRestarts: 1, cooldownMs: 0 });
      expect(unblocked[0]!.restarted).toBe(true);
    });
  });
});
