import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listSecrets, checkSecretsHealth, syncSecrets } from '../../../src/core/secrets.js';
import { loadConfig, saveConfig } from '../../../src/core/config.js';

// Mock execFileSync to avoid calling real `op` CLI
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (cmd: string, ...args: unknown[]) => {
      if (cmd === 'op') {
        throw new Error('op CLI mocked in tests');
      }
      return actual.execFileSync(cmd, ...args as Parameters<typeof actual.execFileSync> extends [unknown, ...infer R] ? R : never);
    },
  };
});

describe('Secrets CLI Commands', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-secrets-cli-test-${Date.now()}`);
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

  describe('secrets list', () => {
    it('should list empty secrets', () => {
      const secrets = listSecrets();
      expect(Array.isArray(secrets)).toBe(true);
    });

    it('should show op:// references', () => {
      const config = loadConfig();
      config.models = {
        ...config.models,
        providers: {
          anthropic: {
            type: 'anthropic',
            apiKey: 'op://vault/anthropic/key',
            enabled: true,
            local: false,
            gpu: false,
          },
        },
      };
      saveConfig(config);
      const secrets = listSecrets();
      const opRef = secrets.find(s => s.ref.includes('op://'));
      expect(opRef).toBeDefined();
    });
  });

  describe('secrets health', () => {
    it('should return health results', async () => {
      const health = await checkSecretsHealth();
      expect(Array.isArray(health)).toBe(true);
    });
  });

  describe('secrets sync', () => {
    it('should return sync results', async () => {
      const results = await syncSecrets();
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
