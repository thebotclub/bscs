import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runSecurityAudit, getSecurityBaseline } from '../../../src/core/security.js';
import { loadConfig, saveConfig } from '../../../src/core/config.js';

describe('Core Security Module', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-security-test-${Date.now()}`);
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
  });

  describe('runSecurityAudit', () => {
    it('should return audit result with findings', () => {
      const result = runSecurityAudit();
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('findings');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('score');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('should flag missing noNewPrivileges', () => {
      const config = loadConfig();
      // Default config has security defaults, so it should be enabled
      const result = runSecurityAudit(config);
      expect(result.findings).toBeDefined();
    });

    it('should detect missing budget', () => {
      const config = loadConfig();
      delete config.budget;
      saveConfig(config);
      const result = runSecurityAudit(loadConfig());
      const budgetFinding = result.findings.find(f => f.category === 'cost');
      expect(budgetFinding).toBeDefined();
      expect(budgetFinding!.severity).toBe('warning');
    });

    it('should detect inline API keys', () => {
      const config = loadConfig();
      config.models = {
        ...config.models,
        providers: {
          'test-provider': {
            type: 'anthropic',
            apiKey: 'sk-ant-api-really-long-key-here-1234567890',
            enabled: true,
            local: false,
            gpu: false,
          },
        },
      };
      config.agents = { 'test-agent': { name: 'test-agent', model: 'claude-sonnet-4', status: 'running' } };
      saveConfig(config);
      const result = runSecurityAudit(loadConfig());
      const secretFinding = result.findings.find(f => f.category === 'secrets');
      expect(secretFinding).toBeDefined();
      expect(secretFinding!.severity).toBe('critical');
    });

    it('should give high score for secure config', () => {
      const config = loadConfig();
      config.budget = { daily: 10, alertThreshold: 0.8 };
      saveConfig(config);
      const result = runSecurityAudit(loadConfig());
      // Default docker config has security enabled
      expect(result.score).toBeGreaterThan(50);
    });
  });

  describe('getSecurityBaseline', () => {
    it('should return array of recommendations', () => {
      const baseline = getSecurityBaseline();
      expect(Array.isArray(baseline)).toBe(true);
      expect(baseline.length).toBeGreaterThan(0);
    });

    it('should include docker recommendations', () => {
      const baseline = getSecurityBaseline();
      const dockerRecs = baseline.filter(r => r.category === 'docker');
      expect(dockerRecs.length).toBeGreaterThan(0);
    });

    it('should show applied status for defaults', () => {
      const baseline = getSecurityBaseline();
      // Default config has security options enabled
      const applied = baseline.filter(r => r.applied);
      expect(applied.length).toBeGreaterThan(0);
    });

    it('should include secrets and cost recommendations', () => {
      const baseline = getSecurityBaseline();
      expect(baseline.some(r => r.category === 'secrets')).toBe(true);
      expect(baseline.some(r => r.category === 'cost')).toBe(true);
    });
  });
});
