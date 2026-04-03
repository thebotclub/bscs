import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile as execFileModule } from 'child_process';
import { loadConfig, saveConfig } from '../../../src/core/config.js';

// Mock docker
vi.mock('../../../src/core/docker.js', () => ({
  listBscsContainers: vi.fn().mockResolvedValue([]),
  listAllContainers: vi.fn().mockResolvedValue([]),
  pullImage: vi.fn().mockResolvedValue(undefined),
  createContainer: vi.fn().mockResolvedValue({ id: 'c123' }),
  startContainer: vi.fn().mockResolvedValue(undefined),
  stopContainer: vi.fn().mockResolvedValue(undefined),
  removeContainer: vi.fn().mockResolvedValue(undefined),
}));

// Mock child_process.execFile for async importFromOpenClaw detail fetching
const mockExecFile = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: mockExecFile,
  };
});

// Helper to normalize raw OpenClaw API data (with id) to listAgents format (with name)
function normalizeListAgents(raw: Array<Record<string, unknown>>): Array<{ name: string; enabled: boolean; channels?: Array<{ type: string; accountId: string }>; model?: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => ({
    name: (a.id as string) || (a.name as string) || 'unknown',
    enabled: a.enabled !== false,
    channels: Array.isArray(a.channels)
      ? (a.channels as Array<{ type: string; accountId?: string; id?: string }>).map((c) => ({
          type: c.type,
          accountId: c.accountId || c.id || '',
        }))
      : undefined,
    model: typeof a.model === 'string' ? a.model : undefined,
  }));
}

// Mock runtime module for OpenClaw drift detection tests
const mockListAgents = vi.fn().mockResolvedValue([]);
const mockBindChannel = vi.fn().mockResolvedValue(undefined);
const mockUnbindChannel = vi.fn().mockResolvedValue(undefined);
const mockSetConfig = vi.fn().mockResolvedValue(undefined);
const mockOcRuntime = {
  list: vi.fn().mockResolvedValue([]),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  restart: vi.fn().mockResolvedValue(undefined),
  create: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  status: vi.fn().mockResolvedValue({ name: 'test', status: 'running' }),
  healthCheck: vi.fn(),
  logs: vi.fn(),
  shell: vi.fn(),
  isAvailable: vi.fn().mockResolvedValue(true),
  // OpenClaw-specific — these make isOpenClawRuntime() return true
  bindChannel: mockBindChannel,
  unbindChannel: mockUnbindChannel,
  setConfig: mockSetConfig,
  listAgents: mockListAgents,
  restartGateway: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../../src/core/runtime/index.js', () => ({
  getRuntime: vi.fn((type: string) => {
    if (type === 'openclaw') return mockOcRuntime;
    // Docker runtime: delegate to mocked docker module
    return {
      list: async () => {
        const { listBscsContainers } = await import('../../../src/core/docker.js');
        return (await listBscsContainers()).map((c: { name: string; status: string }) => ({
          name: c.name.replace('openclaw_', ''),
          status: c.status,
        }));
      },
      start: async (name: string) => {
        const { startContainer } = await import('../../../src/core/docker.js');
        return startContainer(name);
      },
      stop: vi.fn(),
      restart: vi.fn(),
      create: vi.fn(),
      destroy: vi.fn(),
      status: vi.fn(),
      healthCheck: vi.fn(),
      logs: vi.fn(),
      shell: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
    };
  }),
  isOpenClawRuntime: vi.fn((runtime: unknown) =>
    runtime !== null && runtime !== undefined && typeof runtime === 'object' && 'bindChannel' in runtime && 'unbindChannel' in runtime && 'setConfig' in runtime,
  ),
  buildContainerNamesFromConfig: vi.fn(() => new Map()),
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
      const { listAllContainers } = await import('../../../src/core/docker.js');
      vi.mocked(listAllContainers).mockResolvedValue([
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

      const { importFromOpenClaw, _setExecCommandForFleet } = await import('../../../src/core/fleet.js');

      const mockAgents = [
        { id: 'bot-alpha', workspace: 'alpha-ws', model: 'gpt-4', identityName: 'Alpha', identityEmoji: 'A' },
        { id: 'bot-beta', workspace: 'beta-ws', model: 'claude-3' },
        { id: 'bot-gamma' },
      ];

      _setExecCommandForFleet((() => JSON.stringify(mockAgents)) as any);
      // execFile mock for per-agent detail fetching
      mockExecFile.mockImplementation((cmd: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => {
        if (args?.includes('get')) {
          const name = args[args.indexOf('get') + 1];
          cb(null, JSON.stringify({ id: name }));
        } else {
          cb(new Error('unexpected'), '');
        }
      });

      const result = await importFromOpenClaw('http://localhost:18777', { apply: true });
      expect(result.imported).toEqual(['bot-alpha', 'bot-beta', 'bot-gamma']);
      expect(result.skipped).toEqual([]);
      expect(result.errors).toEqual([]);

      // Verify config was written
      const config = loadConfig();
      expect(config.agents!['bot-alpha']).toBeDefined();
      expect(config.agents!['bot-alpha']!.runtime).toBe('openclaw');
      expect(config.agents!['bot-alpha']!.openclaw?.gatewayUrl).toBe('http://localhost:18777');
      expect(config.agents!['bot-alpha']!.openclaw?.identity?.name).toBe('Alpha');
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

      const { importFromOpenClaw, _setExecCommandForFleet } = await import('../../../src/core/fleet.js');

      const mockAgents = [
        { id: 'existing' },
        { id: 'new-agent' },
      ];

      _setExecCommandForFleet((() => JSON.stringify(mockAgents)) as any);
      mockExecFile.mockImplementation((cmd: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => {
        if (args?.includes('get')) {
          const name = args[args.indexOf('get') + 1];
          cb(null, JSON.stringify({ id: name }));
        } else {
          cb(new Error('unexpected'), '');
        }
      });

      const result = await importFromOpenClaw('http://localhost:18777', { apply: true });
      expect(result.imported).toEqual(['new-agent']);
      expect(result.skipped).toEqual(['existing']);
    });

    it('should throw on gateway unreachable', async () => {
      saveConfig({ version: '1.0', agents: {} });

      const { importFromOpenClaw, _setExecCommandForFleet } = await import('../../../src/core/fleet.js');

      _setExecCommandForFleet((() => { throw new Error('Connection refused'); }) as any);

      await expect(importFromOpenClaw('http://localhost:18777')).rejects.toThrow('Failed to query OpenClaw gateway');
    });

    it('should not write config in dry-run mode', async () => {
      saveConfig({ version: '1.0', agents: {} });

      const { importFromOpenClaw, _setExecCommandForFleet } = await import('../../../src/core/fleet.js');

      const mockAgents = [{ id: 'test-agent' }];
      _setExecCommandForFleet((() => JSON.stringify(mockAgents)) as any);
      mockExecFile.mockImplementation((cmd: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => {
        if (args?.includes('get')) cb(null, JSON.stringify({ id: 'test-agent' }));
        else cb(new Error('unexpected'), '');
      });

      const result = await importFromOpenClaw('http://localhost:18777'); // no apply
      expect(result.imported).toEqual(['test-agent']);

      // Verify config was NOT written
      const config = loadConfig();
      expect(config.agents!['test-agent']).toBeUndefined();
    });
  });

  describe('reconciliation config drift (OpenClaw)', () => {
    it('should detect channel binding mismatch', async () => {
      const { computeReconcileChanges } = await import('../../../src/core/fleet.js');

      const gwUrl = 'http://oc.test:18777';
      saveConfig({
        version: '1.0',
        agents: {
          'drift-agent': {
            name: 'drift-agent',
            status: 'running',
            runtime: 'openclaw',
            openclaw: {
              gatewayUrl: gwUrl,
              channels: [{ type: 'telegram', accountId: 'tg1' }],
            },
          },
        },
      });

      // Gateway says agent is running but channels differ
      mockOcRuntime.status.mockResolvedValueOnce({ name: 'drift-agent', status: 'running' });
      mockListAgents.mockResolvedValueOnce(normalizeListAgents([{ id: 'drift-agent', enabled: true, channels: [{ type: 'discord', accountId: 'dc1' }] }]));

      const changes = await computeReconcileChanges();
      const rebind = changes.find((c) => c.action === 'rebind');
      expect(rebind).toBeDefined();
      expect(rebind!.agent).toBe('drift-agent');
      expect(rebind!.reason).toContain('Channel binding mismatch');
    });

    it('should detect model drift', async () => {
      const { computeReconcileChanges } = await import('../../../src/core/fleet.js');

      const gwUrl = 'http://oc.test:18777';
      saveConfig({
        version: '1.0',
        agents: {
          'model-agent': {
            name: 'model-agent',
            status: 'running',
            runtime: 'openclaw',
            openclaw: {
              gatewayUrl: gwUrl,
              model: { primary: 'gpt-4' },
            },
          },
        },
      });

      mockOcRuntime.status.mockResolvedValueOnce({ name: 'model-agent', status: 'running' });
      // With H-05 caching, only one listAgents call per gateway URL
      mockListAgents.mockResolvedValueOnce(normalizeListAgents([{ id: 'model-agent', enabled: true, model: 'claude-3' }]));

      const changes = await computeReconcileChanges();
      const configUpdate = changes.find((c) => c.action === 'config-update');
      expect(configUpdate).toBeDefined();
      expect(configUpdate!.agent).toBe('model-agent');
      expect(configUpdate!.reason).toContain('Model drift');
    });

    it('should not flag model drift when case matches', async () => {
      const { computeReconcileChanges } = await import('../../../src/core/fleet.js');

      const gwUrl = 'http://oc.test:18777';
      saveConfig({
        version: '1.0',
        agents: {
          'same-model': {
            name: 'same-model',
            status: 'running',
            runtime: 'openclaw',
            openclaw: {
              gatewayUrl: gwUrl,
              model: { primary: 'GPT-4' },
            },
          },
        },
      });

      mockOcRuntime.status.mockResolvedValueOnce({ name: 'same-model', status: 'running' });
      mockListAgents.mockResolvedValueOnce(normalizeListAgents([{ id: 'same-model', enabled: true, model: 'gpt-4' }]));

      const changes = await computeReconcileChanges();
      expect(changes.filter((c) => c.action === 'config-update')).toHaveLength(0);
    });

    it('should detect orphaned agents in gateway', async () => {
      const { computeReconcileChanges } = await import('../../../src/core/fleet.js');

      const gwUrl = 'http://oc.test:18777';
      saveConfig({
        version: '1.0',
        agents: {
          'known-agent': {
            name: 'known-agent',
            status: 'running',
            runtime: 'openclaw',
            openclaw: { gatewayUrl: gwUrl },
          },
        },
      });

      mockOcRuntime.status.mockResolvedValueOnce({ name: 'known-agent', status: 'running' });
      // With H-05 caching, single listAgents call per gateway URL covers both drift + orphan checks
      mockListAgents.mockResolvedValueOnce(normalizeListAgents([
        { id: 'known-agent', enabled: true },
        { id: 'rogue-agent', enabled: true },
      ]));

      const changes = await computeReconcileChanges();
      const orphaned = changes.find((c) => c.action === 'orphaned');
      expect(orphaned).toBeDefined();
      expect(orphaned!.agent).toBe('rogue-agent');
      expect(orphaned!.reason).toContain('not in BSCS config');
    });
  });

  describe('importFromOpenClaw — extractFallbacks', () => {
    it('should extract fallbackModels field into model.fallbacks', async () => {
      saveConfig({ version: '1.0', agents: {} });

      const { importFromOpenClaw, _setExecCommandForFleet } = await import('../../../src/core/fleet.js');

      const mockAgentsList = [
        { id: 'test', model: 'gpt-4', enabled: true },
      ];

      _setExecCommandForFleet((() => JSON.stringify(mockAgentsList)) as any);
      mockExecFile.mockImplementation((cmd: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => {
        cb(null, JSON.stringify({ id: 'test', model: 'gpt-4', fallbackModels: ['model-b', 'model-c'] }));
      });

      const result = await importFromOpenClaw('http://localhost:18777', { apply: true });
      expect(result.imported).toEqual(['test']);

      const config = loadConfig();
      expect(config.agents!['test']!.openclaw?.model?.fallbacks).toEqual(['model-b', 'model-c']);
    });

    it('should extract fallbacks field (alternate name) into model.fallbacks', async () => {
      saveConfig({ version: '1.0', agents: {} });

      const { importFromOpenClaw, _setExecCommandForFleet } = await import('../../../src/core/fleet.js');

      const mockAgentsList = [
        { id: 'test', enabled: true },
      ];

      _setExecCommandForFleet((() => JSON.stringify(mockAgentsList)) as any);
      mockExecFile.mockImplementation((cmd: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => {
        cb(null, JSON.stringify({ id: 'test', model: 'gpt-4', fallbacks: ['model-b', 'model-c'] }));
      });

      const result = await importFromOpenClaw('http://localhost:18777', { apply: true });
      expect(result.imported).toEqual(['test']);

      const config = loadConfig();
      expect(config.agents!['test']!.openclaw?.model?.fallbacks).toEqual(['model-b', 'model-c']);
    });
  });

  describe('importFromOpenClaw — per-agent detail fetch', () => {
    it('should fetch agent details to populate channels', async () => {
      saveConfig({ version: '1.0', agents: {} });

      const { importFromOpenClaw, _setExecCommandForFleet } = await import('../../../src/core/fleet.js');

      const mockAgentsList = [
        { id: 'test', model: 'gpt-4', enabled: true },
      ];

      _setExecCommandForFleet((() => JSON.stringify(mockAgentsList)) as any);
      mockExecFile.mockImplementation((cmd: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => {
        cb(null, JSON.stringify({ id: 'test', channels: [{ type: 'telegram', accountId: '123' }] }));
      });

      const result = await importFromOpenClaw('http://localhost:18777', { apply: true });
      expect(result.imported).toEqual(['test']);

      const config = loadConfig();
      expect(config.agents!['test']!.openclaw?.channels).toEqual([{ type: 'telegram', accountId: '123' }]);
    });
  });

  describe('importFromOpenClaw — enabled=false', () => {
    it('should set status to stopped when enabled is false', async () => {
      saveConfig({ version: '1.0', agents: {} });

      const { importFromOpenClaw, _setExecCommandForFleet } = await import('../../../src/core/fleet.js');

      const mockAgentsList = [
        { id: 'test', enabled: false },
      ];

      _setExecCommandForFleet((() => JSON.stringify(mockAgentsList)) as any);
      mockExecFile.mockImplementation((cmd: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => {
        cb(null, JSON.stringify({ id: 'test' }));
      });

      const result = await importFromOpenClaw('http://localhost:18777', { apply: true });
      expect(result.imported).toEqual(['test']);

      const config = loadConfig();
      expect(config.agents!['test']!.status).toBe('stopped');
    });
  });

  describe('importFromOpenClaw — missing agents get response', () => {
    it('should still import agent when agents get throws', async () => {
      saveConfig({ version: '1.0', agents: {} });

      const { importFromOpenClaw, _setExecCommandForFleet } = await import('../../../src/core/fleet.js');

      const mockAgentsList = [
        { id: 'test', model: 'gpt-4', enabled: true },
      ];

      _setExecCommandForFleet((() => JSON.stringify(mockAgentsList)) as any);
      // execFile mock throws for agents get — simulates timeout
      mockExecFile.mockImplementation((cmd: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => {
        cb(new Error('timeout'), '');
      });

      const result = await importFromOpenClaw('http://localhost:18777', { apply: true });
      expect(result.imported).toEqual(['test']);
      expect(result.errors).toEqual([]);

      // Agent should be imported with default values (no channels, no fallbacks)
      const config = loadConfig();
      expect(config.agents!['test']).toBeDefined();
      expect(config.agents!['test']!.openclaw?.channels).toEqual([]);
    });
  });

  describe('applyReconcileChange (OpenClaw drift actions)', () => {
    it('should rebind channels by querying live state first', async () => {
      const { applyReconcileChange } = await import('../../../src/core/fleet.js');

      saveConfig({
        version: '1.0',
        agents: {
          'rebind-agent': {
            name: 'rebind-agent',
            status: 'running',
            runtime: 'openclaw',
            openclaw: {
              gatewayUrl: 'http://oc.test:18777',
              channels: [{ type: 'telegram', accountId: 'tg1' }],
            },
          },
        },
      });

      // Live agent has discord bound — should be unbound first
      mockListAgents.mockResolvedValueOnce(normalizeListAgents([
        { id: 'rebind-agent', enabled: true, channels: [{ type: 'discord', accountId: 'dc1' }] },
      ]));

      const result = await applyReconcileChange({ action: 'rebind', agent: 'rebind-agent', reason: 'Channel mismatch' });
      expect(result.success).toBe(true);
      // Should unbind the live discord channel
      expect(mockUnbindChannel).toHaveBeenCalledWith('rebind-agent', 'discord');
      // Should rebind the config telegram channel
      expect(mockBindChannel).toHaveBeenCalledWith('rebind-agent', 'telegram', 'tg1');
    });

    it('should apply config-update for model drift', async () => {
      const { applyReconcileChange } = await import('../../../src/core/fleet.js');

      saveConfig({
        version: '1.0',
        agents: {
          'model-fix': {
            name: 'model-fix',
            status: 'running',
            runtime: 'openclaw',
            openclaw: {
              gatewayUrl: 'http://oc.test:18777',
              model: { primary: 'gpt-4' },
            },
          },
        },
      });

      const result = await applyReconcileChange({ action: 'config-update', agent: 'model-fix', reason: 'Model drift' });
      expect(result.success).toBe(true);
      expect(mockSetConfig).toHaveBeenCalledWith('agent.model-fix.model', 'gpt-4');
    });

    it('should handle orphaned action without auto-delete', async () => {
      const { applyReconcileChange } = await import('../../../src/core/fleet.js');

      saveConfig({ version: '1.0', agents: {} });

      const result = await applyReconcileChange({ action: 'orphaned', agent: 'rogue', reason: 'Not in config' });
      expect(result.success).toBe(true);
      // No destroy call — orphaned agents are warning-only
      expect(mockOcRuntime.destroy).not.toHaveBeenCalled();
    });
  });

  describe('syncFleetStatus', () => {
    it('should update agent status from running to stopped', async () => {
      const { syncFleetStatus } = await import('../../../src/core/fleet.js');

      saveConfig({
        version: '1.0',
        agents: {
          'oc-agent': {
            name: 'oc-agent',
            status: 'running',
            runtime: 'openclaw',
            openclaw: { gatewayUrl: 'http://localhost:18777' },
          },
        },
      });

      mockOcRuntime.status.mockResolvedValueOnce({ name: 'oc-agent', status: 'stopped' });

      const result = await syncFleetStatus();
      expect(result.updated).toEqual(['oc-agent']);
      expect(result.unchanged).toEqual([]);
      expect(result.errors).toEqual([]);

      // Verify config was written
      const config = loadConfig();
      expect(config.agents!['oc-agent']!.status).toBe('stopped');
    });

    it('should update agent status from stopped to running', async () => {
      const { syncFleetStatus } = await import('../../../src/core/fleet.js');

      saveConfig({
        version: '1.0',
        agents: {
          'oc-agent': {
            name: 'oc-agent',
            status: 'stopped',
            runtime: 'openclaw',
            openclaw: { gatewayUrl: 'http://localhost:18777' },
          },
        },
      });

      mockOcRuntime.status.mockResolvedValueOnce({ name: 'oc-agent', status: 'running' });

      const result = await syncFleetStatus();
      expect(result.updated).toEqual(['oc-agent']);
      expect(result.unchanged).toEqual([]);

      const config = loadConfig();
      expect(config.agents!['oc-agent']!.status).toBe('running');
    });

    it('should skip non-openclaw agents', async () => {
      const { syncFleetStatus } = await import('../../../src/core/fleet.js');

      saveConfig({
        version: '1.0',
        agents: {
          'docker-agent': {
            name: 'docker-agent',
            status: 'running',
            runtime: 'docker',
          },
          'native-agent': {
            name: 'native-agent',
            status: 'stopped',
            runtime: 'native',
          },
        },
      });

      const result = await syncFleetStatus();
      expect(result.updated).toEqual([]);
      expect(result.unchanged).toEqual(['docker-agent', 'native-agent']);
      expect(result.errors).toEqual([]);
    });

    it('should not write config in dry-run mode', async () => {
      const { syncFleetStatus } = await import('../../../src/core/fleet.js');

      saveConfig({
        version: '1.0',
        agents: {
          'oc-agent': {
            name: 'oc-agent',
            status: 'running',
            runtime: 'openclaw',
            openclaw: { gatewayUrl: 'http://localhost:18777' },
          },
        },
      });

      mockOcRuntime.status.mockResolvedValueOnce({ name: 'oc-agent', status: 'stopped' });

      const result = await syncFleetStatus({ dryRun: true });
      expect(result.updated).toEqual(['oc-agent']);

      // Config should NOT have been written
      const config = loadConfig();
      expect(config.agents!['oc-agent']!.status).toBe('running');
    });

    it('should handle errors gracefully', async () => {
      const { syncFleetStatus } = await import('../../../src/core/fleet.js');

      saveConfig({
        version: '1.0',
        agents: {
          'oc-agent': {
            name: 'oc-agent',
            status: 'running',
            runtime: 'openclaw',
            openclaw: { gatewayUrl: 'http://localhost:18777' },
          },
        },
      });

      mockOcRuntime.status.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await syncFleetStatus();
      expect(result.updated).toEqual([]);
      expect(result.unchanged).toEqual(['oc-agent']);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('oc-agent');
      expect(result.errors[0]).toContain('Connection refused');

      // Config should remain unchanged
      const config = loadConfig();
      expect(config.agents!['oc-agent']!.status).toBe('running');
    });
  });
});
