import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, saveConfig } from '../../../src/core/config.js';

vi.mock('../../../src/core/docker.js', () => ({
  listBscsContainers: vi.fn().mockResolvedValue([]),
  startContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue('{}'),
  };
});

describe('OpenClaw Agent Tools (cron + config)', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-mcp-tools-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    originalConfigDir = process.env.BSCS_CONFIG_DIR;
    process.env.BSCS_CONFIG_DIR = tempDir;
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterAll(() => {
    if (originalConfigDir) {
      process.env.BSCS_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.BSCS_CONFIG_DIR;
    }
  });

  function afterAll(fn: () => void) {
    // Cleanup on last test
    return fn;
  }

  const ocBase = { role: 'custom' as const, template: 'custom' as const, machine: 'localhost' };
  const dkBase = { ...ocBase, runtime: 'docker' as const };

  describe('addCronJob', () => {
    it('should add a cron job to an openclaw agent', async () => {
      const { addCronJob, listCronJobs } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = {
        'oc-agent': {
          ...ocBase,
          name: 'oc-agent',
          status: 'running',
          runtime: 'openclaw',
          openclaw: { gatewayUrl: 'http://localhost:18777' },
        },
      };
      saveConfig(config);

      addCronJob('oc-agent', { id: 'daily-report', cron: '0 9 * * *', message: 'Generate daily report' });

      const jobs = listCronJobs('oc-agent');
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.id).toBe('daily-report');
      expect(jobs[0]!.cron).toBe('0 9 * * *');
    });

    it('should reject duplicate cron job ids', async () => {
      const { addCronJob } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = {
        'oc-agent': {
          ...ocBase,
          name: 'oc-agent',
          status: 'running',
          runtime: 'openclaw',
          openclaw: { gatewayUrl: 'http://localhost:18777', cronJobs: [{ id: 'job1', cron: '* * * * *', message: 'test' }] },
        },
      };
      saveConfig(config);

      expect(() => addCronJob('oc-agent', { id: 'job1', cron: '0 * * * *', message: 'dup' })).toThrow('already exists');
    });

    it('should reject cron on docker agents', async () => {
      const { addCronJob } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = { 'dock-agent': { ...dkBase, name: 'dock-agent', status: 'running' } };
      saveConfig(config);

      expect(() => addCronJob('dock-agent', { id: 'j', cron: '* * * * *', message: 'm' })).toThrow('only supported for openclaw');
    });
  });

  describe('removeCronJob', () => {
    it('should remove a cron job by id', async () => {
      const { removeCronJob, listCronJobs } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = {
        'oc-agent': {
          ...ocBase,
          name: 'oc-agent',
          status: 'running',
          runtime: 'openclaw',
          openclaw: {
            gatewayUrl: 'http://localhost:18777',
            cronJobs: [
              { id: 'j1', cron: '0 9 * * *', message: 'morning' },
              { id: 'j2', cron: '0 17 * * *', message: 'evening' },
            ],
          },
        },
      };
      saveConfig(config);

      removeCronJob('oc-agent', 'j1');
      const jobs = listCronJobs('oc-agent');
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.id).toBe('j2');
    });

    it('should throw for nonexistent job id', async () => {
      const { removeCronJob } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = {
        'oc-agent': {
          ...ocBase,
          name: 'oc-agent',
          status: 'running',
          runtime: 'openclaw',
          openclaw: { gatewayUrl: 'http://localhost:18777' },
        },
      };
      saveConfig(config);

      expect(() => removeCronJob('oc-agent', 'nonexistent')).toThrow('not found');
    });
  });

  describe('listCronJobs', () => {
    it('should return empty array when no cron jobs', async () => {
      const { listCronJobs } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = {
        'oc-agent': {
          ...ocBase,
          name: 'oc-agent',
          status: 'running',
          runtime: 'openclaw',
          openclaw: { gatewayUrl: 'http://localhost:18777' },
        },
      };
      saveConfig(config);

      const jobs = listCronJobs('oc-agent');
      expect(jobs).toEqual([]);
    });

    it('should throw for nonexistent agent', async () => {
      const { listCronJobs } = await import('../../../src/core/agent.js');
      expect(() => listCronJobs('no-such-agent')).toThrow('not found');
    });
  });

  describe('setAgentConfig', () => {
    it('should reject config set on docker agents', async () => {
      const { setAgentConfig } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = { 'dock-agent': { ...dkBase, name: 'dock-agent', status: 'running' } };
      saveConfig(config);

      await expect(setAgentConfig('dock-agent', 'key', 'val')).rejects.toThrow('only supported for openclaw');
    });

    it('should throw for nonexistent agent', async () => {
      const { setAgentConfig } = await import('../../../src/core/agent.js');
      await expect(setAgentConfig('nope', 'key', 'val')).rejects.toThrow('not found');
    });
  });

  describe('addSkill / removeSkill / listSkills', () => {
    it('should add and list skills', async () => {
      const { addSkill, listSkills } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = {
        'oc-agent': {
          ...ocBase,
          name: 'oc-agent',
          status: 'running',
          runtime: 'openclaw',
          openclaw: { gatewayUrl: 'http://localhost:18777' },
        },
      };
      saveConfig(config);

      addSkill('oc-agent', 'code-review');
      addSkill('oc-agent', 'deployment');
      const skills = listSkills('oc-agent');
      expect(skills).toEqual(['code-review', 'deployment']);
    });

    it('should reject duplicate skills', async () => {
      const { addSkill } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = {
        'oc-agent': {
          ...ocBase,
          name: 'oc-agent',
          status: 'running',
          runtime: 'openclaw',
          openclaw: { gatewayUrl: 'http://localhost:18777', skills: ['existing'] },
        },
      };
      saveConfig(config);

      expect(() => addSkill('oc-agent', 'existing')).toThrow('already exists');
    });

    it('should remove a skill', async () => {
      const { removeSkill, listSkills } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = {
        'oc-agent': {
          ...ocBase,
          name: 'oc-agent',
          status: 'running',
          runtime: 'openclaw',
          openclaw: { gatewayUrl: 'http://localhost:18777', skills: ['a', 'b', 'c'] },
        },
      };
      saveConfig(config);

      removeSkill('oc-agent', 'b');
      expect(listSkills('oc-agent')).toEqual(['a', 'c']);
    });

    it('should reject skill removal on docker agents', async () => {
      const { addSkill } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = { 'dock': { ...dkBase, name: 'dock', status: 'running' } };
      saveConfig(config);

      expect(() => addSkill('dock', 'test')).toThrow('only supported for openclaw');
    });
  });

  describe('setIdentity', () => {
    it('should set identity on an openclaw agent', async () => {
      const { setIdentity } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = {
        'oc-agent': {
          ...ocBase,
          name: 'oc-agent',
          status: 'running',
          runtime: 'openclaw',
          openclaw: { gatewayUrl: 'http://localhost:18777' },
        },
      };
      saveConfig(config);

      setIdentity('oc-agent', 'CodeBot', '🤖');
      const updated = loadConfig();
      expect(updated.agents!['oc-agent']!.openclaw!.identity).toEqual({ name: 'CodeBot', emoji: '🤖' });
    });

    it('should reject identity on docker agents', async () => {
      const { setIdentity } = await import('../../../src/core/agent.js');
      const config = loadConfig();
      config.agents = { 'dock': { ...dkBase, name: 'dock', status: 'running' } };
      saveConfig(config);

      expect(() => setIdentity('dock', 'Bot', '🤖')).toThrow('only supported for openclaw');
    });
  });
});
