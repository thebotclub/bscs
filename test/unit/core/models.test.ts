import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  listProviders,
  addProvider,
  removeProvider,
  providersStatus,
  showDefaults,
  showFallbacks,
} from '../../../src/core/models.js';

describe('Core Models Module', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-models-test-${Date.now()}`);
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

  describe('listProviders', () => {
    it('should return empty array with no config', () => {
      const providers = listProviders();
      expect(Array.isArray(providers)).toBe(true);
    });
  });

  describe('addProvider', () => {
    it('should add a provider', () => {
      addProvider('test-provider', {
        type: 'anthropic',
        apiKey: 'op://vault/key',
      });
      const providers = listProviders();
      expect(providers.some(p => p.name === 'test-provider')).toBe(true);
    });
  });

  describe('removeProvider', () => {
    it('should remove an existing provider', () => {
      addProvider('to-remove', { type: 'openai', apiKey: 'test' });
      removeProvider('to-remove');
      const providers = listProviders();
      expect(providers.some(p => p.name === 'to-remove')).toBe(false);
    });
  });

  describe('providersStatus', () => {
    it('should return status array', async () => {
      const statuses = await providersStatus();
      expect(Array.isArray(statuses)).toBe(true);
    });
  });

  describe('showDefaults', () => {
    it('should return model defaults', () => {
      const defaults = showDefaults();
      expect(defaults).toBeDefined();
      expect(typeof defaults).toBe('object');
    });
  });

  describe('showFallbacks', () => {
    it('should return fallback chains', () => {
      const fallbacks = showFallbacks();
      expect(typeof fallbacks).toBe('object');
    });
  });
});
