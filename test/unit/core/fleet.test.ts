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

  describe('importFromOpenClaw', () => {
    it('should import agents from openclaw gateway', async () => {
      // Set up initial config
      saveConfig({ version: '1.0', agents: {} });

      const { importFromOpenClaw, setExecCommandForFleet } = await import('../../../src/core/fleet.js');

      const mockAgents = [
        { name: 'bot-alpha', workspace: 'alpha-ws', model: 'gpt-4', channels: [{ type: 'telegram', accountId: 'tg123' }] },
        { name: 'bot-beta', workspace: 'beta-ws', model: 'claude-3', channels: [] },
        { name: 'bot-gamma' },
      ];

      setExecCommandForFleet((() => JSON.stringify(mockAgents)) as any);

      const result = importFromOpenClaw('http://localhost:18777', { apply: true });
      expect(result.imported).toEqual(['bot-alpha', 'bot-beta', 'bot-gamma']);
      expect(result.skipped).toEqual([]);
      expect(result.errors).toEqual([]);

      // Verify config was written
      const config = loadConfig();
      expect(config.agents!['bot-alpha']).toBeDefined();
      expect(config.agents!['bot-alpha']!.runtime).toBe('openclaw');
      expect(config.agents!['bot-alpha']!.openclaw?.gatewayUrl).toBe('http://localhost:18777');
      expect(config.agents!['bot-alpha']!.openclaw?.channels).toHaveLength(1);
      expect(config.agents!['bot-beta']!.openclaw?.workspace).toBe('beta-ws');
      expect(config.agents!['bot-gamma']!.openclaw?.workspace).toBe('bot-gamma');
    });

    it('should skip agents already in config', async () => {
      saveConfig({
        version: '1.0',
        agents: {
          existing: { name: 'existing', role: 'custom', runtime: 'docker', status: 'running' },
        },
      });

      const { importFromOpenClaw, setExecCommandForFleet } = await import('../../../src/core/fleet.js');

      const mockAgents = [
        { name: 'existing' },
        { name: 'new-agent' },
      ];

      setExecCommandForFleet((() => JSON.stringify(mockAgents)) as any);

      const result = importFromOpenClaw('http://localhost:18777', { apply: true });
      expect(result.imported).toEqual(['new-agent']);
      expect(result.skipped).toEqual(['existing']);
    });

    it('should throw on gateway unreachable', async () => {
      saveConfig({ version: '1.0', agents: {} });

      const { importFromOpenClaw, setExecCommandForFleet } = await import('../../../src/core/fleet.js');

      setExecCommandForFleet((() => { throw new Error('Connection refused'); }) as any);

      expect(() => importFromOpenClaw('http://localhost:18777')).toThrow('Failed to query OpenClaw gateway');
    });

    it('should not write config in dry-run mode', async () => {
      saveConfig({ version: '1.0', agents: {} });

      const { importFromOpenClaw, setExecCommandForFleet } = await import('../../../src/core/fleet.js');

      const mockAgents = [{ name: 'test-agent' }];
      setExecCommandForFleet((() => JSON.stringify(mockAgents)) as any);

      const result = importFromOpenClaw('http://localhost:18777'); // no apply
      expect(result.imported).toEqual(['test-agent']);

      // Verify config was NOT written
      const config = loadConfig();
      expect(config.agents!['test-agent']).toBeUndefined();
    });
  });
});
