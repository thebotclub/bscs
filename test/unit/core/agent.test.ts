import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, saveConfig } from '../../../src/core/config.js';

// Mock docker module
vi.mock('../../../src/core/docker.js', () => ({
  listBscsContainers: vi.fn().mockResolvedValue([]),
  getContainer: vi.fn().mockResolvedValue(null),
  pullImage: vi.fn().mockResolvedValue(undefined),
  createContainer: vi.fn().mockResolvedValue({ id: 'test-container-123' }),
  startContainer: vi.fn().mockResolvedValue(undefined),
  stopContainer: vi.fn().mockResolvedValue(undefined),
  removeContainer: vi.fn().mockResolvedValue(undefined),
}));

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn().mockReturnValue({ on: vi.fn() }),
}));

describe('Core Agent Module', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-agent-test-${Date.now()}`);
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

  describe('allocatePorts', () => {
    it('should allocate first available port pair', async () => {
      const { allocatePorts } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      const ports = await allocatePorts(config);
      expect(ports.gateway).toBe(19000);
      expect(ports.remote).toBe(19001);
    });

    it('should skip used ports', async () => {
      const { allocatePorts } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = {
        existing: {
          name: 'existing',
          ports: { gateway: 19000, remote: 19001 },
          status: 'running',
        },
      };
      saveConfig(config);
      const reloaded = loadConfig();
      const ports = await allocatePorts(reloaded);
      expect(ports.gateway).toBe(19002);
      expect(ports.remote).toBe(19003);
    });

    it('should throw when no ports available', async () => {
      const { allocatePorts } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.defaults = { image: 'test', portRange: { start: 19000, end: 19001 } };
      config.agents = {
        existing: {
          name: 'existing',
          ports: { gateway: 19000, remote: 19001 },
          status: 'running',
        },
      };
      saveConfig(config);
      const reloaded = loadConfig();
      await expect(allocatePorts(reloaded)).rejects.toThrow('No available ports');
    });
  });

  describe('getResourcesForRole', () => {
    it('should return coding resources for coding role', async () => {
      const { getResourcesForRole } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      const resources = getResourcesForRole('coding', config);
      expect(resources.memory).toBe('4g');
      expect(resources.pidsLimit).toBe(512);
    });

    it('should return default resources for custom role', async () => {
      const { getResourcesForRole } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      const resources = getResourcesForRole('custom', config);
      expect(resources.memory).toBe('2g');
    });
  });

  describe('getModelForRole', () => {
    it('should return configured model for role', async () => {
      const { getModelForRole } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      const model = getModelForRole('coding', config);
      expect(model).toBe('claude-sonnet-4');
    });

    it('should fallback to default for unknown role', async () => {
      const { getModelForRole } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      const model = getModelForRole('custom', config);
      expect(model).toBe('claude-sonnet-4');
    });
  });

  describe('createAgent', () => {
    it('should create agent in dry-run mode', async () => {
      const { createAgent } = await import('../../../src/core/agent.js');
      const result = await createAgent({
        name: 'test-agent',
        role: 'coding',
        dryRun: true,
      });
      expect(result.dryRun).toBe(true);
      expect(result.name).toBe('test-agent');
      expect(result.role).toBe('coding');
      expect(result.ports.gateway).toBe(19000);
    });

    it('should throw for duplicate agent name', async () => {
      const { createAgent } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = {
        'test-agent': {
          name: 'test-agent',
          status: 'running',
        },
      };
      saveConfig(config);
      await expect(createAgent({ name: 'test-agent', role: 'coding' })).rejects.toThrow('already exists');
    });
  });

  describe('destroyAgent', () => {
    it('should throw for non-existent agent', async () => {
      const { destroyAgent } = await import('../../../src/core/agent.js');
      await expect(destroyAgent('nonexistent')).rejects.toThrow('not found');
    });

    it('should remove agent from config', async () => {
      const { destroyAgent } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = {
        'test-agent': {
          name: 'test-agent',
          status: 'running',
        },
      };
      saveConfig(config);
      const result = await destroyAgent('test-agent');
      expect(result.destroyed).toBe(true);
      const reloaded = loadConfig();
      expect(reloaded.agents?.['test-agent']).toBeUndefined();
    });
  });

  describe('startAgent', () => {
    it('should throw for non-existent agent', async () => {
      const { startAgent } = await import('../../../src/core/agent.js');
      await expect(startAgent('nonexistent')).rejects.toThrow('not found');
    });

    it('should update config status', async () => {
      const { startAgent } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = { 'test-agent': { name: 'test-agent', status: 'stopped' } };
      saveConfig(config);
      const result = await startAgent('test-agent');
      expect(result.status).toBe('running');
    });
  });

  describe('stopAgent', () => {
    it('should update config status to stopped', async () => {
      const { stopAgent } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = { 'test-agent': { name: 'test-agent', status: 'running' } };
      saveConfig(config);
      const result = await stopAgent('test-agent');
      expect(result.status).toBe('stopped');
    });
  });

  describe('restartAgent', () => {
    it('should restart and return running status', async () => {
      const { restartAgent } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = { 'test-agent': { name: 'test-agent', status: 'running' } };
      saveConfig(config);
      const result = await restartAgent('test-agent');
      expect(result.status).toBe('running');
    });
  });

  describe('getAllAgentStatuses', () => {
    it('should return empty array when no agents', async () => {
      const { getAllAgentStatuses } = await import('../../../src/core/agent.js');
      const statuses = await getAllAgentStatuses();
      expect(statuses).toEqual([]);
    });

    it('should return status for configured agents', async () => {
      const { getAllAgentStatuses } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = {
        'agent-a': { name: 'agent-a', role: 'coding', status: 'running' },
        'agent-b': { name: 'agent-b', role: 'review', status: 'stopped' },
      };
      saveConfig(config);
      const statuses = await getAllAgentStatuses();
      expect(statuses).toHaveLength(2);
      expect(statuses[0]!.name).toBe('agent-a');
    });
  });

  describe('bindChannel / unbindChannel', () => {
    it('should bind a channel to an openclaw agent', async () => {
      const config = loadConfig();
      config.agents = {
        'oc-agent': {
          name: 'oc-agent',
          role: 'custom',
          runtime: 'openclaw',
          status: 'running',
          openclaw: { gatewayUrl: 'http://localhost:18777', workspace: 'oc-agent' },
        },
      };
      saveConfig(config);

      const { bindChannel } = await import('../../../src/core/agent.js');
      await bindChannel('oc-agent', 'telegram', 'tg123');

      const updated = loadConfig();
      expect(updated.agents!['oc-agent']!.openclaw?.channels).toEqual([
        { type: 'telegram', accountId: 'tg123' },
      ]);
    });

    it('should unbind a channel from an openclaw agent', async () => {
      const config = loadConfig();
      config.agents = {
        'oc-agent': {
          name: 'oc-agent',
          role: 'custom',
          runtime: 'openclaw',
          status: 'running',
          openclaw: {
            gatewayUrl: 'http://localhost:18777',
            workspace: 'oc-agent',
            channels: [
              { type: 'telegram', accountId: 'tg123' },
              { type: 'discord', accountId: 'dc456' },
            ],
          },
        },
      };
      saveConfig(config);

      const { unbindChannel } = await import('../../../src/core/agent.js');
      await unbindChannel('oc-agent', 'telegram');

      const updated = loadConfig();
      expect(updated.agents!['oc-agent']!.openclaw?.channels).toEqual([
        { type: 'discord', accountId: 'dc456' },
      ]);
    });

    it('should throw when binding to a docker agent', async () => {
      const config = loadConfig();
      config.agents = {
        'docker-agent': {
          name: 'docker-agent',
          role: 'coding',
          runtime: 'docker',
          status: 'running',
        },
      };
      saveConfig(config);

      const { bindChannel } = await import('../../../src/core/agent.js');
      await expect(bindChannel('docker-agent', 'telegram', 'tg123'))
        .rejects.toThrow('channel bind is only supported for openclaw agents');
    });

    it('should throw when agent not found', async () => {
      saveConfig({ version: '1.0', agents: {} });

      const { bindChannel } = await import('../../../src/core/agent.js');
      await expect(bindChannel('nonexistent', 'telegram', 'tg123'))
        .rejects.toThrow('not found');
    });
  });
});
