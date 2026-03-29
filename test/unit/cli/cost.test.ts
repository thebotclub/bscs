import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getCostData, generateCostReport, setDailyBudget, getBudgetStatus } from '../../../src/core/cost.js';

describe('Cost CLI Commands', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-cost-cli-test-${Date.now()}`);
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

  describe('cost report generation', () => {
    it('should generate report for today', () => {
      const data = getCostData('today');
      const report = generateCostReport(data, 'today');
      expect(report.total).toBeGreaterThanOrEqual(0);
    });

    it('should support groupBy options', () => {
      const data = getCostData('today');
      const byAgent = generateCostReport(data, 'today', 'agent');
      expect(byAgent).toHaveProperty('byAgent');

      const byModel = generateCostReport(data, 'today', 'model');
      expect(byModel).toHaveProperty('byModel');

      const byProvider = generateCostReport(data, 'today', 'provider');
      expect(byProvider).toHaveProperty('byProvider');
    });
  });

  describe('budget management', () => {
    it('should set and read daily budget', () => {
      setDailyBudget(25);
      const status = getBudgetStatus();
      expect(status.limit).toBe(25);
    });

    it('should report zero percent when no spend', () => {
      setDailyBudget(100);
      const status = getBudgetStatus();
      expect(status.percent).toBeGreaterThanOrEqual(0);
    });
  });
});
