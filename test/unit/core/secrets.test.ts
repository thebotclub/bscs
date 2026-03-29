import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listSecrets, checkSecretsHealth, syncSecrets } from '../../../src/core/secrets.js';
import { loadConfig, saveConfig } from '../../../src/core/config.js';

describe('Core Secrets Module', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-secrets-test-${Date.now()}`);
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

  describe('listSecrets', () => {
    it('should return empty array with no secrets', () => {
      const secrets = listSecrets();
      expect(Array.isArray(secrets)).toBe(true);
    });

    it('should list configured secrets from providers', () => {
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
      expect(secrets.length).toBeGreaterThanOrEqual(1);
      expect(secrets[0]!.status).toBe('op-reference');
    });
  });

  describe('checkSecretsHealth', () => {
    it('should return health status array', async () => {
      const results = await checkSecretsHealth();
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('syncSecrets', () => {
    it('should return sync results', async () => {
      const results = await syncSecrets();
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
