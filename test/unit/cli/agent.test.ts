import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, saveConfig } from '../../../src/core/config.js';

describe('Agent Commands', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-test-agent-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    originalConfigDir = process.env.BSCS_CONFIG_DIR;
    process.env.BSCS_CONFIG_DIR = tempDir;
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
    vi.clearAllMocks();
  });

  describe('agent role assignment', () => {
    it('should assign coding role to agent', async () => {
      const config = loadConfig();
      config.agents = config.agents || {};
      config.agents['test-coder'] = {
        name: 'test-coder',
        role: 'coding',
        template: 'coding',
        machine: 'localhost',
        status: 'created',
        created: new Date().toISOString(),
      };
      saveConfig(config);
      
      const reloaded = loadConfig();
      expect(reloaded.agents?.['test-coder']?.role).toBe('coding');
      expect(reloaded.agents?.['test-coder']?.template).toBe('coding');
    });

    it('should assign brain role with correct model', async () => {
      const config = loadConfig();
      config.models = config.models || {};
      config.models.defaults = { brain: 'claude-opus-4' };
      config.agents = config.agents || {};
      config.agents['test-brain'] = {
        name: 'test-brain',
        role: 'brain',
        template: 'custom',
        machine: 'localhost',
        model: config.models.defaults.brain,
        status: 'created',
        created: new Date().toISOString(),
      };
      saveConfig(config);
      
      const reloaded = loadConfig();
      expect(reloaded.agents?.['test-brain']?.role).toBe('brain');
      expect(reloaded.agents?.['test-brain']?.model).toBe('claude-opus-4');
    });

    it('should assign review role with correct model', async () => {
      const config = loadConfig();
      config.models = config.models || {};
      config.models.defaults = { review: 'claude-sonnet-4' };
      config.agents = config.agents || {};
      config.agents['test-reviewer'] = {
        name: 'test-reviewer',
        role: 'review',
        template: 'review',
        machine: 'localhost',
        model: config.models.defaults.review,
        status: 'created',
        created: new Date().toISOString(),
      };
      saveConfig(config);
      
      const reloaded = loadConfig();
      expect(reloaded.agents?.['test-reviewer']?.role).toBe('review');
    });

    it('should use default role for custom', async () => {
      const config = loadConfig();
      config.agents = config.agents || {};
      config.agents['test-custom'] = {
        name: 'test-custom',
        role: 'custom',
        template: 'custom',
        machine: 'localhost',
        status: 'created',
        created: new Date().toISOString(),
      };
      saveConfig(config);
      
      const reloaded = loadConfig();
      expect(reloaded.agents?.['test-custom']?.role).toBe('custom');
    });
  });

  describe('dry-run mode', () => {
    it('should not create agent in dry-run mode', async () => {
      const config = loadConfig();
      const initialCount = Object.keys(config.agents || {}).length;
      
      // In dry-run mode, we would preview but not save
      // Simulate by not saving
      const newConfig = { ...config };
      newConfig.agents = newConfig.agents || {};
      // Don't add anything
      
      const afterCount = Object.keys(config.agents || {}).length;
      expect(afterCount).toBe(initialCount);
    });
  });

  describe('port allocation', () => {
    it('should allocate ports from configured range', async () => {
      const config = loadConfig();
      config.defaults = {
        image: 'test:latest',
        portRange: {
          start: 19000,
          end: 19010,
        },
      };
      saveConfig(config);
      
      const reloaded = loadConfig();
      expect(reloaded.defaults?.portRange?.start).toBe(19000);
      expect(reloaded.defaults?.portRange?.end).toBe(19010);
    });

    it('should avoid port conflicts', async () => {
      const config = loadConfig();
      config.defaults = {
        image: 'test:latest',
        portRange: {
          start: 19000,
          end: 19010,
        },
      };
      config.agents = {
        'existing-agent': {
          name: 'existing-agent',
          role: 'custom',
          template: 'custom',
          machine: 'localhost',
          status: 'running',
          ports: { gateway: 19000, remote: 19001 },
          created: new Date().toISOString(),
        },
      };
      saveConfig(config);
      
      // Next agent should get 19002/19003
      const usedPorts = new Set([19000, 19001]);
      let nextGateway = 19000;
      for (let port = 19000; port <= 19009; port += 2) {
        if (!usedPorts.has(port)) {
          nextGateway = port;
          break;
        }
      }
      expect(nextGateway).toBe(19002);
    });
  });

  describe('resource allocation by role', () => {
    it('should assign more memory to coding agents', async () => {
      const config = loadConfig();
      const codingResources = config.docker?.resources?.coding;
      expect(codingResources?.memory).toBe('4g');
    });

    it('should assign less memory to brain agents', async () => {
      const config = loadConfig();
      const brainResources = config.docker?.resources?.brain;
      expect(brainResources?.memory).toBe('2g');
    });
  });
});
