import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BscsConfig } from '../../../src/util/types.js';

// Mock child_process
const mockExecSync = vi.fn();
const mockExec = vi.fn();

vi.mock('child_process', () => ({
  exec: (...args: any[]) => mockExec(...args),
  execSync: (...args: any[]) => mockExecSync(...args),
}));

describe('Fleet Doctor', () => {
  const baseConfig: BscsConfig = {
    version: '1.0',
    docker: {
      image: 'ghcr.io/thebotclub/bscs:latest',
      registry: 'ghcr.io',
      security: { noNewPrivileges: true, capDropAll: true, tmpfs: true, pidsLimit: 256, readOnlyRootfs: false },
      resources: {
        coding: { memory: '2g', pidsLimit: 256 },
        review: { memory: '2g', pidsLimit: 256 },
        brain: { memory: '2g', pidsLimit: 256 },
        ops: { memory: '2g', pidsLimit: 256 },
        default: { memory: '2g', pidsLimit: 256 },
      },
    },
    models: { providers: {}, defaults: {}, fallbacks: {} },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: getLocalIps returns localhost
    mockExecSync.mockReturnValue('127.0.0.1\n');
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  function setupExec(responses: Record<string, { ok: boolean; output: string }>) {
    mockExec.mockImplementation((cmd: string, _opts: any, callback: Function) => {
      for (const [pattern, response] of Object.entries(responses)) {
        if (cmd.includes(pattern)) {
          if (response.ok) {
            callback(null, response.output, '');
          } else {
            callback(new Error(response.output), '', response.output);
          }
          return;
        }
      }
      // Default: command succeeds with empty output
      callback(null, '', '');
    });
  }

  describe('DoctorResult interface', () => {
    it('should import runDoctor', async () => {
      const { runDoctor } = await import('../../../src/core/doctor.js');
      expect(runDoctor).toBeDefined();
      expect(typeof runDoctor).toBe('function');
    });
  });

  describe('runDoctor quick mode', () => {
    it('should return valid result for empty config', async () => {
      setupExec({
        'docker version': { ok: true, output: '29.3.1' },
        'df -h': { ok: true, output: '45% 120Gi' },
        'sysctl': { ok: true, output: '17179869184\n1000000 500000' },
        'node --version': { ok: true, output: 'v25.8.0' },
        'openclaw --version': { ok: true, output: '2026.3.13' },
        'docker ps': { ok: true, output: '' },
      });

      const { runDoctor } = await import('../../../src/core/doctor.js');
      const result = await runDoctor(baseConfig, false);

      expect(result).toBeDefined();
      expect(result.mode).toBe('quick');
      expect(result.timestamp).toBeDefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeDefined();
      expect(result.score.total).toBeGreaterThanOrEqual(0);
      expect(result.checks).toBeDefined();
      expect(Array.isArray(result.checks)).toBe(true);
    });

    it('should include fleet checks even with no agents', async () => {
      setupExec({});

      const { runDoctor } = await import('../../../src/core/doctor.js');
      const result = await runDoctor(baseConfig, false);

      const fleetChecks = result.checks.filter(c => c.category === 'fleet');
      expect(fleetChecks.length).toBe(3); // port conflicts, orphans, config consistency
    });

    it('should detect port conflicts', async () => {
      setupExec({
        'docker inspect': { ok: true, output: 'running|2024-01-01T00:00:00Z|healthy' },
        'curl': { ok: true, output: '{"status":"ok"}' },
        'docker ps': { ok: true, output: '' },
      });

      const configWithConflicts: BscsConfig = {
        ...baseConfig,
        agents: {
          'agent-a': { name: 'agent-a', role: 'coding', machine: 'localhost', runtime: 'docker', template: 'custom', ports: { gateway: 19000, remote: 19001 } },
          'agent-b': { name: 'agent-b', role: 'coding', machine: 'localhost', runtime: 'docker', template: 'custom', ports: { gateway: 19000, remote: 19003 } },
        },
      };

      const { runDoctor } = await import('../../../src/core/doctor.js');
      const result = await runDoctor(configWithConflicts, false);

      const portCheck = result.checks.find(c => c.name === 'Port Conflicts');
      expect(portCheck).toBeDefined();
      expect(portCheck!.status).toBe('error');
    });

    it('should detect no port conflicts when ports are unique', async () => {
      setupExec({
        'docker inspect': { ok: true, output: 'running|2024-01-01T00:00:00Z|healthy' },
        'curl': { ok: true, output: '{"status":"ok"}' },
        'docker ps': { ok: true, output: '' },
      });

      const configNoConflicts: BscsConfig = {
        ...baseConfig,
        agents: {
          'agent-a': { name: 'agent-a', role: 'coding', machine: 'localhost', runtime: 'docker', template: 'custom', ports: { gateway: 19000, remote: 19001 } },
          'agent-b': { name: 'agent-b', role: 'coding', machine: 'localhost', runtime: 'docker', template: 'custom', ports: { gateway: 19002, remote: 19003 } },
        },
      };

      const { runDoctor } = await import('../../../src/core/doctor.js');
      const result = await runDoctor(configNoConflicts, false);

      const portCheck = result.checks.find(c => c.name === 'Port Conflicts');
      expect(portCheck).toBeDefined();
      expect(portCheck!.status).toBe('ok');
    });

    it('should check config consistency for unknown machines', async () => {
      setupExec({
        'echo ok': { ok: false, output: 'connection refused' },
        'docker ps': { ok: true, output: '' },
      });

      const configBadRef: BscsConfig = {
        ...baseConfig,
        agents: {
          'agent-a': { name: 'agent-a', role: 'coding', machine: '10.0.0.99', runtime: 'docker', template: 'custom' },
        },
      };

      const { runDoctor } = await import('../../../src/core/doctor.js');
      const result = await runDoctor(configBadRef, false);

      const consistencyCheck = result.checks.find(c => c.name === 'Config Consistency');
      expect(consistencyCheck).toBeDefined();
      expect(consistencyCheck!.status).toBe('warn');
    });
  });

  describe('runDoctor deep mode', () => {
    it('should include deep checks when deep=true', async () => {
      setupExec({
        'docker inspect': { ok: true, output: 'running|2024-01-01T00:00:00Z|healthy' },
        'curl': { ok: true, output: '{"status":"ok"}' },
        'docker logs': { ok: true, output: '' },
        'docker stats': { ok: true, output: '0.50%|100MiB / 2GiB' },
        'docker exec': { ok: true, output: 'All checks passed!' },
        'grep -ci': { ok: true, output: '0' },
        'docker ps': { ok: true, output: '' },
      });

      const configWithAgent: BscsConfig = {
        ...baseConfig,
        agents: {
          'test-agent': { name: 'test-agent', role: 'coding', machine: 'localhost', runtime: 'docker', template: 'custom', ports: { gateway: 19000 } },
        },
      };

      const { runDoctor } = await import('../../../src/core/doctor.js');
      const result = await runDoctor(configWithAgent, true);

      expect(result.mode).toBe('deep');
      const agentChecks = result.checks.filter(c => c.category === 'agent');
      const checkNames = agentChecks.map(c => c.name);
      // Quick checks
      expect(checkNames).toContain('Container');
      expect(checkNames).toContain('Gateway');
      expect(checkNames).toContain('Uptime');
      // Deep checks
      expect(checkNames).toContain('Recent Errors');
      expect(checkNames).toContain('Rate Limiting');
      expect(checkNames).toContain('Channel Status');
      expect(checkNames).toContain('Resources');
      expect(checkNames).toContain('Sub-Doctor');
    });

    it('should not include deep checks when deep=false', async () => {
      setupExec({
        'docker inspect': { ok: true, output: 'running|2024-01-01T00:00:00Z|healthy' },
        'curl': { ok: true, output: '{"status":"ok"}' },
        'docker ps': { ok: true, output: '' },
      });

      const configWithAgent: BscsConfig = {
        ...baseConfig,
        agents: {
          'test-agent': { name: 'test-agent', role: 'coding', machine: 'localhost', runtime: 'docker', template: 'custom', ports: { gateway: 19000 } },
        },
      };

      const { runDoctor } = await import('../../../src/core/doctor.js');
      const result = await runDoctor(configWithAgent, false);

      expect(result.mode).toBe('quick');
      const checkNames = result.checks.filter(c => c.category === 'agent').map(c => c.name);
      expect(checkNames).not.toContain('Recent Errors');
      expect(checkNames).not.toContain('Rate Limiting');
      expect(checkNames).not.toContain('Sub-Doctor');
    });
  });

  describe('score calculation', () => {
    it('should calculate score correctly', async () => {
      setupExec({
        'docker ps': { ok: true, output: '' },
      });

      const { runDoctor } = await import('../../../src/core/doctor.js');
      const result = await runDoctor(baseConfig, false);

      const { score } = result;
      expect(score.ok + score.warn + score.error + score.critical + score.skip).toBe(score.total);
    });
  });

  describe('DoctorCheck interface', () => {
    it('should have valid categories', async () => {
      setupExec({
        'docker inspect': { ok: true, output: 'running|2024-01-01T00:00:00Z|healthy' },
        'curl': { ok: true, output: '{"status":"ok"}' },
        'docker ps': { ok: true, output: '' },
      });

      const configWithAgent: BscsConfig = {
        ...baseConfig,
        agents: {
          'test-agent': { name: 'test-agent', role: 'coding', machine: 'localhost', runtime: 'docker', template: 'custom', ports: { gateway: 19000 } },
        },
      };

      const { runDoctor } = await import('../../../src/core/doctor.js');
      const result = await runDoctor(configWithAgent, false);

      for (const check of result.checks) {
        expect(['machine', 'agent', 'fleet']).toContain(check.category);
        expect(['ok', 'warn', 'error', 'critical', 'skip']).toContain(check.status);
        expect(check.name).toBeDefined();
        expect(check.message).toBeDefined();
        expect(check.target).toBeDefined();
      }
    });
  });

  describe('machine status tracking', () => {
    it('should track machine online/offline status', async () => {
      setupExec({
        'echo ok': { ok: false, output: 'connection refused' },
        'docker ps': { ok: true, output: '' },
      });

      const configWithMachine: BscsConfig = {
        ...baseConfig,
        machines: {
          '10.0.0.1': { host: '10.0.0.1', user: 'hani', role: 'worker', port: 22, sshAlias: 'remote1' },
        },
      };

      const { runDoctor } = await import('../../../src/core/doctor.js');
      const result = await runDoctor(configWithMachine, false);

      expect(result.machines).toBeDefined();
      expect(result.machines['10.0.0.1']).toBe('offline');
    });

    it('should skip agent checks when machine is offline', async () => {
      setupExec({
        'echo ok': { ok: false, output: 'timeout' },
        'docker ps': { ok: true, output: '' },
      });

      const configWithRemoteAgent: BscsConfig = {
        ...baseConfig,
        machines: {
          '10.0.0.1': { host: '10.0.0.1', user: 'hani', role: 'worker', port: 22, sshAlias: 'remote1' },
        },
        agents: {
          'remote-agent': { name: 'remote-agent', role: 'coding', machine: '10.0.0.1', runtime: 'docker', template: 'custom' },
        },
      };

      const { runDoctor } = await import('../../../src/core/doctor.js');
      const result = await runDoctor(configWithRemoteAgent, false);

      const agentChecks = result.checks.filter(c => c.category === 'agent');
      expect(agentChecks.every(c => c.status === 'skip')).toBe(true);
    });
  });
});
