import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../../../src/core/config.js';
import { BscsConfigSchema } from '../../../src/util/types.js';

describe('Config Module', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    // Create temp directory
    tempDir = join(tmpdir(), `bscs-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    
    // Set temp config dir
    originalConfigDir = process.env.BSCS_CONFIG_DIR;
    process.env.BSCS_CONFIG_DIR = tempDir;
  });

  afterEach(() => {
    // Cleanup
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    
    // Restore original env
    if (originalConfigDir !== undefined) {
      process.env.BSCS_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.BSCS_CONFIG_DIR;
    }
  });

  describe('BscsConfigSchema', () => {
    it('should parse valid config', () => {
      const config = {
        version: '1.0',
        docker: {
          image: 'openclaw-fleet:latest',
        },
      };
      
      const result = BscsConfigSchema.parse(config);
      expect(result.version).toBe('1.0');
      expect(result.docker?.image).toBe('openclaw-fleet:latest');
    });

    it('should apply defaults for missing fields', () => {
      // When parsing with docker.image missing, default is applied
      const config = { docker: {} };
      const result = BscsConfigSchema.parse(config);
      
      // Check that defaults are applied
      expect(result.docker?.image).toBe('ghcr.io/thebotclub/bscs:latest');
    });

    it('should validate agent config', () => {
      const config = {
        agents: {
          'test-agent': {
            name: 'test-agent',
            ports: {
              gateway: 19000,
              remote: 19001,
            },
            status: 'running',
          },
        },
      };
      
      const result = BscsConfigSchema.parse(config);
      expect(result.agents?.['test-agent']?.name).toBe('test-agent');
      expect(result.agents?.['test-agent']?.status).toBe('running');
    });

    it('should reject invalid status', () => {
      const config = {
        agents: {
          'test-agent': {
            name: 'test-agent',
            status: 'invalid',
          },
        },
      };
      
      expect(() => BscsConfigSchema.parse(config)).toThrow();
    });
  });

  describe('loadConfig', () => {
    it('should return defaults when config does not exist', () => {
      const config = loadConfig();
      
      expect(config.version).toBe('1.0');
      expect(config.docker?.image).toBe('ghcr.io/thebotclub/bscs:latest');
    });

    it('should load existing config', () => {
      const configPath = join(tempDir, 'config.json');
      const existingConfig = {
        version: '1.0',
        fleet: {
          name: 'test-fleet',
        },
      };
      
      writeFileSync(configPath, JSON.stringify(existingConfig));
      
      const config = loadConfig();
      expect(config.fleet?.name).toBe('test-fleet');
    });

    it('should throw on invalid JSON', () => {
      const configPath = join(tempDir, 'config.json');
      writeFileSync(configPath, 'not json');
      
      expect(() => loadConfig()).toThrow();
    });

    it('should throw on invalid schema', () => {
      const configPath = join(tempDir, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        agents: {
          test: {
            status: 'invalid-status',
          },
        },
      }));
      
      expect(() => loadConfig()).toThrow();
    });
  });

  describe('saveConfig', () => {
    it('should create config directory if needed', () => {
      const newDir = join(tempDir, 'new-subdir');
      process.env.BSCS_CONFIG_DIR = newDir;
      
      saveConfig(DEFAULT_CONFIG);
      
      expect(existsSync(join(newDir, 'config.json'))).toBe(true);
    });

    it('should write valid JSON', () => {
      saveConfig(DEFAULT_CONFIG);
      
      const configPath = join(tempDir, 'config.json');
      const content = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      
      expect(parsed.version).toBe('1.0');
    });

    it('should validate before saving', () => {
      const invalidConfig = {
        version: '1.0',
        agents: {
          test: {
            status: 'invalid',
          },
        },
      } as any;
      
      expect(() => saveConfig(invalidConfig)).toThrow();
    });

    it('should round-trip config', () => {
      const config = {
        version: '1.0',
        fleet: {
          name: 'my-fleet',
          domain: 'example.com',
        },
        agents: {
          atlas: {
            name: 'atlas',
            image: 'openclaw-fleet:latest',
            ports: {
              gateway: 19000,
              remote: 19001,
            },
            status: 'running' as const,
          },
        },
      };
      
      saveConfig(config);
      const loaded = loadConfig();
      
      expect(loaded.fleet?.name).toBe('my-fleet');
      expect(loaded.agents?.atlas?.name).toBe('atlas');
      expect(loaded.agents?.atlas?.ports?.gateway).toBe(19000);
    });
  });

  describe('DEFAULT_CONFIG', () => {
    it('should have required fields', () => {
      expect(DEFAULT_CONFIG.version).toBe('1.0');
      expect(DEFAULT_CONFIG.docker?.image).toBe('ghcr.io/thebotclub/bscs:latest');
      expect(DEFAULT_CONFIG.defaults?.image).toBe('ghcr.io/thebotclub/bscs:latest');
      expect(DEFAULT_CONFIG.defaults?.portRange?.start).toBe(19000);
      expect(DEFAULT_CONFIG.defaults?.portRange?.end).toBe(19999);
    });
  });
});
