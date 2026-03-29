import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, saveConfig } from '../../../src/core/config.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

describe('Core Machine Module', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-machine-test-${Date.now()}`);
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

  describe('addMachine', () => {
    it('should add a new machine', async () => {
      const { addMachine } = await import('../../../src/core/machine.js');
      addMachine('test-host', { host: '192.168.1.100', user: 'root', role: 'worker' });
      const config = loadConfig();
      expect(config.machines?.['test-host']).toBeDefined();
      expect(config.machines?.['test-host']?.host).toBe('192.168.1.100');
    });

    it('should reject duplicate machine name', async () => {
      const { addMachine } = await import('../../../src/core/machine.js');
      addMachine('test-host', { host: '192.168.1.100' });
      expect(() => addMachine('test-host', { host: '192.168.1.200' })).toThrow('already exists');
    });

    it('should use default role and port', async () => {
      const { addMachine } = await import('../../../src/core/machine.js');
      addMachine('test-host', { host: '10.0.0.1' });
      const config = loadConfig();
      expect(config.machines?.['test-host']?.role).toBe('worker');
      expect(config.machines?.['test-host']?.port).toBe(22);
    });
  });

  describe('removeMachine', () => {
    it('should remove an existing machine', async () => {
      const { addMachine, removeMachine } = await import('../../../src/core/machine.js');
      addMachine('test-host', { host: '10.0.0.1' });
      removeMachine('test-host');
      const config = loadConfig();
      expect(config.machines?.['test-host']).toBeUndefined();
    });

    it('should throw for non-existent machine', async () => {
      const { removeMachine } = await import('../../../src/core/machine.js');
      expect(() => removeMachine('nonexistent')).toThrow('not found');
    });

    it('should prevent removal if agents are assigned', async () => {
      const { addMachine, removeMachine } = await import('../../../src/core/machine.js');
      addMachine('test-host', { host: '10.0.0.1' });
      const config = loadConfig();
      config.agents = { 'agent-a': { name: 'agent-a', machine: 'test-host', status: 'running' } };
      saveConfig(config);
      expect(() => removeMachine('test-host')).toThrow('has agents assigned');
    });
  });

  describe('getMachineStatus', () => {
    it('should return status for localhost', async () => {
      const { getMachineStatus } = await import('../../../src/core/machine.js');
      const config = loadConfig();
      config.machines = {
        localhost: { host: 'localhost', user: 'user', role: 'controller', port: 22 },
      };
      saveConfig(config);
      const statuses = await getMachineStatus();
      expect(statuses).toHaveLength(1);
      expect(statuses[0]!.reachable).toBe(true);
    });

    it('should filter by name', async () => {
      const { getMachineStatus } = await import('../../../src/core/machine.js');
      const config = loadConfig();
      config.machines = {
        localhost: { host: 'localhost', user: 'user', role: 'controller', port: 22 },
        remote: { host: '10.0.0.1', user: 'root', role: 'worker', port: 22 },
      };
      saveConfig(config);
      const statuses = await getMachineStatus('localhost');
      expect(statuses).toHaveLength(1);
      expect(statuses[0]!.name).toBe('localhost');
    });
  });

  describe('getBootstrapSteps', () => {
    it('should return standard bootstrap steps', async () => {
      const { getBootstrapSteps } = await import('../../../src/core/machine.js');
      const steps = getBootstrapSteps({ host: 'test', user: 'root', role: 'worker', port: 22 });
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.some(s => s.name === 'docker')).toBe(true);
      expect(steps.some(s => s.name === 'node')).toBe(true);
    });
  });

  describe('bootstrapMachine', () => {
    it('should throw for non-existent machine', async () => {
      const { bootstrapMachine } = await import('../../../src/core/machine.js');
      await expect(bootstrapMachine('nonexistent')).rejects.toThrow('not found');
    });

    it('should return steps in dry-run', async () => {
      const { bootstrapMachine, addMachine } = await import('../../../src/core/machine.js');
      addMachine('remote', { host: '10.0.0.1', user: 'root' });
      const result = await bootstrapMachine('remote', { dryRun: true });
      expect(result.executed).toBe(false);
      expect(result.steps.length).toBeGreaterThan(0);
    });

    it('should throw for localhost bootstrap', async () => {
      const { bootstrapMachine, addMachine } = await import('../../../src/core/machine.js');
      addMachine('local', { host: 'localhost' });
      await expect(bootstrapMachine('local')).rejects.toThrow('Cannot bootstrap localhost');
    });
  });
});
