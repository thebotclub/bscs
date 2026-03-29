import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

describe('Core Tribunal Module', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-tribunal-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    originalConfigDir = process.env.BSCS_CONFIG_DIR;
    process.env.BSCS_CONFIG_DIR = tempDir;
    vi.clearAllMocks();
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

  describe('createDefaultTribunalConfig', () => {
    it('should create valid config for agent', async () => {
      const { createDefaultTribunalConfig } = await import('../../../src/core/tribunal.js');
      const config = createDefaultTribunalConfig('test-agent');
      expect(config.version).toBe('1.0');
      expect(config.agent.name).toBe('test-agent');
      expect(config.rules.preventFileDeletion).toBe(true);
      expect(config.rules.preventCommandExecution).toContain('rm -rf');
    });
  });

  describe('saveTribunalConfig / loadTribunalConfig', () => {
    it('should round-trip config', async () => {
      const { createDefaultTribunalConfig, saveTribunalConfig, loadTribunalConfig } = await import('../../../src/core/tribunal.js');
      const config = createDefaultTribunalConfig('test-agent');
      saveTribunalConfig('test-agent', config);
      const loaded = loadTribunalConfig('test-agent');
      expect(loaded).not.toBeNull();
      expect(loaded!.agent.name).toBe('test-agent');
    });

    it('should return null for missing config', async () => {
      const { loadTribunalConfig } = await import('../../../src/core/tribunal.js');
      const config = loadTribunalConfig('nonexistent');
      expect(config).toBeNull();
    });
  });

  describe('isTribunalInstalled', () => {
    it('should return false when not installed', async () => {
      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
      const { isTribunalInstalled } = await import('../../../src/core/tribunal.js');
      expect(isTribunalInstalled()).toBe(false);
    });
  });

  describe('checkTribunalHealth', () => {
    it('should report errors when not installed', async () => {
      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
      const { checkTribunalHealth } = await import('../../../src/core/tribunal.js');
      const health = checkTribunalHealth('test-agent');
      expect(health.installed).toBe(false);
      expect(health.errors.length).toBeGreaterThan(0);
    });

    it('should report config missing', async () => {
      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockReturnValue('1.0.0' as any);
      const { checkTribunalHealth } = await import('../../../src/core/tribunal.js');
      const health = checkTribunalHealth('nonexistent-agent');
      expect(health.errors).toContain('Tribunal config not found');
    });
  });
});
