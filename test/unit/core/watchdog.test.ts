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
});
