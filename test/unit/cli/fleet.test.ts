import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, saveConfig } from '../../../src/core/config.js';

vi.mock('../../../src/core/docker.js', () => ({
  listBscsContainers: vi.fn().mockResolvedValue([]),
  listAllContainers: vi.fn().mockResolvedValue([]),
  pullImage: vi.fn().mockResolvedValue(undefined),
  createContainer: vi.fn().mockResolvedValue({ id: 'c123' }),
  startContainer: vi.fn().mockResolvedValue(undefined),
  stopContainer: vi.fn().mockResolvedValue(undefined),
  removeContainer: vi.fn().mockResolvedValue(undefined),
}));

describe('Fleet CLI Commands', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-fleet-cli-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    originalConfigDir = process.env.BSCS_CONFIG_DIR;
    process.env.BSCS_CONFIG_DIR = tempDir;
    vi.clearAllMocks();
    vi.resetModules();
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

  describe('fleet status', () => {
    it('should return status with empty fleet', async () => {
      const { getFleetStatus } = await import('../../../src/core/fleet.js');
      const status = await getFleetStatus();
      expect(status.summary.total).toBe(0);
    });

    it('should include all configured agents', async () => {
      const { getFleetStatus } = await import('../../../src/core/fleet.js');
      const config = loadConfig();
      config.agents = {
        'agent-aa': { name: 'agent-aa', status: 'running' },
        'agent-bb': { name: 'agent-bb', status: 'stopped' },
      };
      saveConfig(config);
      const status = await getFleetStatus();
      expect(status.agents).toHaveLength(2);
    });
  });

  describe('fleet init', () => {
    it('should create fleet config', async () => {
      const { initFleet } = await import('../../../src/core/fleet.js');
      const result = initFleet({
        fleetName: 'my-fleet',
        controller: 'localhost',
        image: 'openclaw:latest',
        portRangeStart: 19000,
        portRangeEnd: 19999,
      });
      expect(existsSync(result.configPath)).toBe(true);
    });
  });

  describe('fleet reconcile', () => {
    it('should detect changes needed', async () => {
      const { computeReconcileChanges } = await import('../../../src/core/fleet.js');
      const config = loadConfig();
      config.agents = { orphan: { name: 'orphan', status: 'running' } };
      saveConfig(config);
      const changes = await computeReconcileChanges();
      expect(changes.length).toBeGreaterThan(0);
    });
  });
});
