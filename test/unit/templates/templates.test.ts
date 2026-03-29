import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateOpenclawConfig, generateOpenclawConfigJson } from '../../../src/templates/agent-config.js';
import { generateComposeService, generateComposeFile } from '../../../src/templates/docker-compose.js';
import { generateWorkspace, getWorkspacePath } from '../../../src/templates/workspace.js';

describe('Templates', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-templates-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('agent-config', () => {
    it('should generate valid config object', () => {
      const config = generateOpenclawConfig({
        name: 'test-agent',
        role: 'coding',
        model: 'claude-sonnet-4',
        image: 'test:latest',
        ports: { gateway: 19000, remote: 19001 },
      });
      expect(config).toHaveProperty('agent');
      expect(config).toHaveProperty('gateway');
    });

    it('should generate valid JSON string', () => {
      const json = generateOpenclawConfigJson({
        name: 'test',
        role: 'custom',
        model: 'claude-sonnet-4',
        image: 'test:latest',
        ports: { gateway: 19000, remote: 19001 },
      });
      const parsed = JSON.parse(json);
      expect(parsed.agent.name).toBe('test');
    });

    it('should enable tribunal for coding role', () => {
      const config = generateOpenclawConfig({
        name: 'coder',
        role: 'coding',
        model: 'claude-sonnet-4',
        image: 'test:latest',
        ports: { gateway: 19000, remote: 19001 },
      }) as Record<string, any>;
      expect(config['security']['tribunal']).toBe(true);
    });

    it('should disable tribunal for non-coding role', () => {
      const config = generateOpenclawConfig({
        name: 'brain',
        role: 'brain',
        model: 'claude-opus-4',
        image: 'test:latest',
        ports: { gateway: 19002, remote: 19003 },
      }) as Record<string, any>;
      expect(config['security']['tribunal']).toBe(false);
    });
  });

  describe('docker-compose', () => {
    it('should generate service with security options', () => {
      const svc = generateComposeService({
        name: 'test',
        image: 'openclaw:latest',
        ports: { gateway: 19000, remote: 19001 },
      });
      expect(svc.container_name).toBe('openclaw_test');
      expect(svc.security_opt).toContain('no-new-privileges:true');
      expect(svc.cap_drop).toContain('ALL');
    });

    it('should generate compose file for multiple services', () => {
      const file = generateComposeFile([
        { name: 'a', image: 'test:1', ports: { gateway: 19000, remote: 19001 } },
        { name: 'b', image: 'test:2', ports: { gateway: 19002, remote: 19003 } },
      ]);
      const parsed = JSON.parse(file);
      expect(Object.keys(parsed.services)).toHaveLength(2);
    });
  });

  describe('workspace', () => {
    it('should create workspace structure', () => {
      const basePath = join(tempDir, 'workspace');
      const created = generateWorkspace({
        basePath,
        agentName: 'test-agent',
        role: 'coding',
      });
      expect(created.length).toBeGreaterThan(0);
      expect(existsSync(join(basePath, 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(basePath, 'SOUL.md'))).toBe(true);
      expect(existsSync(join(basePath, 'MEMORY.md'))).toBe(true);
    });

    it('should not overwrite existing files', () => {
      const basePath = join(tempDir, 'workspace2');
      generateWorkspace({ basePath, agentName: 'a', role: 'coding' });
      const created2 = generateWorkspace({ basePath, agentName: 'a', role: 'coding' });
      // Nothing new should be created since files already exist
      expect(created2).toHaveLength(0);
    });

    it('should return correct workspace path', () => {
      const path = getWorkspacePath('/base', 'test-agent');
      expect(path).toContain('agents');
      expect(path).toContain('test-agent');
      expect(path).toContain('workspace');
    });
  });
});
