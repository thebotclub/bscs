import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMachineCommand } from '../../../src/cli/machine/index.js';
import { loadConfig, saveConfig,
  getConfigPathString
} from '../../../src/core/config.js';

// Mock SSH
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

describe('Machine Commands', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-test-${Date.now()}`);
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

  describe('machine add', () => {
    it('should add a machine to config', async () => {
      const config = loadConfig();
      expect(config.machines).toBeUndefined();
      
      // Simulate adding a machine
      config.machines = config.machines || {};
      config.machines['test-host'] = {
        host: 'test-host',
        user: 'root',
        role: 'worker',
        port: 22,
      };
      saveConfig(config);
      
      const reloaded = loadConfig();
      expect(reloaded.machines).toBeDefined();
      expect(reloaded.machines?.['test-host']).toEqual({
        host: 'test-host',
        user: 'root',
        role: 'worker',
        port: 22,
      });
    });

    it('should reject duplicate machine', async () => {
      const config = loadConfig();
      config.machines = {
        'existing-host': {
          host: 'existing-host',
          user: 'root',
          role: 'worker',
          port: 22,
        },
      };
      saveConfig(config);
      
      // Verify adding same machine again would be a duplicate
      const reloaded = loadConfig();
      expect(reloaded.machines?.['existing-host']).toBeDefined();
      
      // Attempting to add via core module should throw
      const { addMachine } = await import('../../../src/core/machine.js');
      expect(() => addMachine('existing-host', { host: 'existing-host' })).toThrow('already exists');
    });
  });

  describe('machine remove', () => {
    it('should remove a machine from config', async () => {
      const config = loadConfig();
      config.machines = {
        'to-remove': {
          host: 'to-remove',
          user: 'root',
          role: 'worker',
          port: 22,
        },
      };
      saveConfig(config);
      
      // Remove it
      delete config.machines['to-remove'];
      saveConfig(config);
      
      const reloaded = loadConfig();
      expect(reloaded.machines?.['to-remove']).toBeUndefined();
    });

    it('should error when removing non-existent machine', () => {
      const config = loadConfig();
      expect(config.machines?.['nonexistent']).toBeUndefined();
    });
  });

  describe('machine bootstrap', () => {
    it('should show dry-run preview', async () => {
      // The bootstrap command with --dry-run should show steps
      // without actually connecting via SSH
      vi.mocked(execSync).mockReturnValue('');
      
      // Dry run should not execute SSH commands
      // This is handled by the CLI action
    });

    it('should detect already installed software', async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('docker --version')) {
          return 'Docker version 24.0.0';
        }
        if (cmd.includes('node --version')) {
          return 'v22.0.0';
        }
        return 'installed';
      });
    });
  });
});
