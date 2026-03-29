import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, saveConfig } from '../../../src/core/config.js';

// Mock docker
vi.mock('../../../src/core/docker.js', () => ({
  listBscsContainers: vi.fn().mockResolvedValue([]),
  pullImage: vi.fn().mockResolvedValue(undefined),
  createContainer: vi.fn().mockResolvedValue({ id: 'c123' }),
  startContainer: vi.fn().mockResolvedValue(undefined),
  stopContainer: vi.fn().mockResolvedValue(undefined),
  removeContainer: vi.fn().mockResolvedValue(undefined),
}));

describe('Core Fleet Module', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-fleet-test-${Date.now()}`);
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

  describe('getFleetStatus', () => {
    it('should return empty fleet with defaults', async () => {
      const { getFleetStatus } = await import('../../../src/core/fleet.js');
      const status = await getFleetStatus();
      expect(status.fleetName).toBe('unnamed-fleet');
      expect(status.agents).toEqual([]);
      expect(status.summary.total).toBe(0);
    });

    it('should include configured agents', async () => {
      const { getFleetStatus } = await import('../../../src/core/fleet.js');
      const config = loadConfig();
      config.fleet = { name: 'test-fleet' };
      config.agents = {
        'agent-aa': { name: 'agent-aa', status: 'running', ports: { gateway: 19000, remote: 19001 } },
      };
      saveConfig(config);
      const status = await getFleetStatus();
      expect(status.fleetName).toBe('test-fleet');
      expect(status.agents).toHaveLength(1);
      expect(status.agents[0]!.name).toBe('agent-aa');
      expect(status.agents[0]!.status).toBe('missing'); // no container
    });

    it('should compute summary correctly', async () => {
      const { getFleetStatus } = await import('../../../src/core/fleet.js');
      const { listBscsContainers } = await import('../../../src/core/docker.js');
      vi.mocked(listBscsContainers).mockResolvedValue([
        { id: 'c1', name: 'openclaw_agent-aa', image: 'test', status: 'running', ports: { gateway: 19000, remote: 19001 } },
        { id: 'c2', name: 'openclaw_agent-bb', image: 'test', status: 'stopped', ports: { gateway: 19002, remote: 19003 } },
      ]);
      const config = loadConfig();
      config.agents = {
        'agent-aa': { name: 'agent-aa', status: 'running' },
        'agent-bb': { name: 'agent-bb', status: 'stopped' },
      };
      saveConfig(config);
      const status = await getFleetStatus();
      expect(status.summary.running).toBe(1);
      expect(status.summary.stopped).toBe(1);
      expect(status.summary.total).toBe(2);
    });
  });

  describe('computeReconcileChanges', () => {
    it('should return empty when in sync', async () => {
      const { computeReconcileChanges } = await import('../../../src/core/fleet.js');
      const { listBscsContainers } = await import('../../../src/core/docker.js');
      vi.mocked(listBscsContainers).mockResolvedValue([
        { id: 'c1', name: 'openclaw_agent-aa', image: 'test', status: 'running', ports: {} },
      ]);
      const config = loadConfig();
      config.agents = { 'agent-aa': { name: 'agent-aa', status: 'running' } };
      saveConfig(config);
      const changes = await computeReconcileChanges();
      expect(changes).toHaveLength(0);
    });

    it('should detect missing containers', async () => {
      const { computeReconcileChanges } = await import('../../../src/core/fleet.js');
      const { listBscsContainers } = await import('../../../src/core/docker.js');
      vi.mocked(listBscsContainers).mockResolvedValue([]);
      const config = loadConfig();
      config.agents = { 'agent-aa': { name: 'agent-aa', status: 'running' } };
      saveConfig(config);
      const changes = await computeReconcileChanges();
      expect(changes).toHaveLength(1);
      expect(changes[0]!.action).toBe('create');
    });

    it('should detect stopped containers that should run', async () => {
      const { computeReconcileChanges } = await import('../../../src/core/fleet.js');
      const { listBscsContainers } = await import('../../../src/core/docker.js');
      vi.mocked(listBscsContainers).mockResolvedValue([
        { id: 'c1', name: 'openclaw_agent-aa', image: 'test', status: 'stopped', ports: {} },
      ]);
      const config = loadConfig();
      config.agents = { 'agent-aa': { name: 'agent-aa', status: 'running' } };
      saveConfig(config);
      const changes = await computeReconcileChanges();
      expect(changes[0]!.action).toBe('start');
    });
  });

  describe('initFleet', () => {
    it('should create config file', async () => {
      const { initFleet } = await import('../../../src/core/fleet.js');
      const result = initFleet({
        fleetName: 'test-fleet',
        controller: 'localhost',
        image: 'test:latest',
        portRangeStart: 19000,
        portRangeEnd: 19999,
      });
      expect(result.configPath).toContain('config.json');
      expect(existsSync(result.configPath)).toBe(true);
    });

    it('should throw if config already exists', async () => {
      const { initFleet } = await import('../../../src/core/fleet.js');
      writeFileSync(join(tempDir, 'config.json'), '{}');
      expect(() => initFleet({
        fleetName: 'test',
        controller: 'localhost',
        image: 'test:latest',
        portRangeStart: 19000,
        portRangeEnd: 19999,
      })).toThrow('already exists');
    });
  });

  describe('importFleetSh', () => {
    it('should throw for missing path', async () => {
      const { importFleetSh } = await import('../../../src/core/fleet.js');
      expect(() => importFleetSh('/nonexistent/path')).toThrow('not found');
    });

    it('should import from fleet.sh config', async () => {
      const { importFleetSh } = await import('../../../src/core/fleet.js');
      // Remove existing config first
      const configPath = join(tempDir, 'config.json');
      if (existsSync(configPath)) rmSync(configPath);

      const fleetDir = join(tempDir, 'fleet-sh');
      mkdirSync(fleetDir, { recursive: true });
      writeFileSync(join(fleetDir, 'config'), 'FLEET_NAME="imported"\nIMAGE="my-image:v1"\nAGENTS=("atlas" "vault")');

      const result = importFleetSh(fleetDir);
      expect(result.fleetName).toBe('imported');
      expect(result.image).toBe('my-image:v1');
      expect(Object.keys(result.agents)).toHaveLength(2);
    });
  });
});
