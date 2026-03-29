import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getCostData, generateCostReport, getBudgetStatus, setDailyBudget } from '../../../src/core/cost.js';

describe('Core Cost Module', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-cost-test-${Date.now()}`);
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

  describe('getCostData', () => {
    it('should return data for today', () => {
      const data = getCostData('today');
      expect(data).toBeDefined();
      expect(Array.isArray(data)).toBe(true);
    });

    it('should return data for week', () => {
      const data = getCostData('week');
      expect(data).toBeDefined();
    });

    it('should return data for month', () => {
      const data = getCostData('month');
      expect(data).toBeDefined();
    });
  });

  describe('generateCostReport', () => {
    it('should generate report with total', () => {
      const data = getCostData('today');
      const report = generateCostReport(data, 'today');
      expect(report).toHaveProperty('total');
      expect(report).toHaveProperty('period');
      expect(report.period).toHaveProperty('start');
      expect(report.period).toHaveProperty('end');
    });

    it('should group by agent', () => {
      const data = getCostData('today');
      const report = generateCostReport(data, 'today', 'agent');
      expect(report).toHaveProperty('byAgent');
    });

    it('should group by model', () => {
      const data = getCostData('today');
      const report = generateCostReport(data, 'today', 'model');
      expect(report).toHaveProperty('byModel');
    });
  });

  describe('getBudgetStatus', () => {
    it('should return budget status', () => {
      const status = getBudgetStatus();
      expect(status).toHaveProperty('limit');
      expect(status).toHaveProperty('spent');
      expect(status).toHaveProperty('percent');
    });
  });

  describe('setDailyBudget', () => {
    it('should set daily budget in config', () => {
      setDailyBudget(10);
      const status = getBudgetStatus();
      expect(status.limit).toBe(10);
    });
  });
});
