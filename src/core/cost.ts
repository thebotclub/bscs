import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from '../util/logger.js';
import { loadConfig, saveConfig } from './config.js';

const logger = createLogger('cost');

// =============================================================================
// Cost Tracking
// =============================================================================

const COST_DATA_DIR = process.env.BSCS_COST_DIR 
  ? `${process.env.BSCS_COST_DIR}/costs`
  : `${homedir()}/.config/bscs/costs`;

interface CostEntry {
  timestamp: string;
  agent: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

interface CostReport {
  period: { start: string; end: string };
  total: number;
  entries?: CostEntry[];
  byAgent?: Record<string, number>;
  byModel?: Record<string, number>;
  byProvider?: Record<string, number>;
  budget?: { limit: number; spent: number; percent: number };
}

/**
 * Get cost data for a period
 */
export function getCostData(period: string): CostEntry[] {
  const entries: CostEntry[] = [];
  const today = new Date();

  // Ensure cost directory exists
  if (!existsSync(COST_DATA_DIR)) {
    mkdirSync(COST_DATA_DIR, { recursive: true });
    return entries;
  }

  const files = readdirSync(COST_DATA_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .reverse();

  // Get date range based on period
  const startDate = new Date();
  let endDate: Date | null = null;

  if (period === 'today') {
    startDate.setHours(0, 0, 0, 0);
  } else if (period === 'yesterday') {
    // yesterday: exactly midnight-to-midnight (does NOT include today)
    startDate.setDate(today.getDate() - 1);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(today);
    endDate.setHours(0, 0, 0, 0); // midnight = start of today
  } else if (period === 'week') {
    startDate.setDate(today.getDate() - 7);
  } else if (period === 'month') {
    startDate.setMonth(today.getMonth() - 1);
  }

  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate ? endDate.toISOString().slice(0, 10) : today.toISOString().slice(0, 10);

  for (const file of files) {
    const fileDate = file.slice(0, 10);
    if (fileDate >= startStr && fileDate <= endStr) {
      try {
        const content = readFileSync(join(COST_DATA_DIR, file), 'utf-8');
        const lines = content.trim().split('\n');
        for (const line of lines) {
          if (!line) continue;
          try {
            entries.push(JSON.parse(line));
          } catch {
            // Skip malformed entries
          }
        }
      } catch {
        // Skip files we can't read
      }
    }
  }

  return entries;
}

/**
 * Generate a cost report
 */
export function generateCostReport(
  entries: CostEntry[],
  period: string,
  groupBy?: string
): CostReport {
  const today = new Date();
  const startDate = new Date();
  let periodEnd = today;

  if (period === 'today') {
    startDate.setHours(0, 0, 0, 0);
  } else if (period === 'yesterday') {
    startDate.setDate(today.getDate() - 1);
    startDate.setHours(0, 0, 0, 0);
    periodEnd = new Date(today);
    periodEnd.setHours(0, 0, 0, 0); // midnight = start of today, end of yesterday
  } else if (period === 'week') {
    startDate.setDate(today.getDate() - 7);
  } else if (period === 'month') {
    startDate.setMonth(today.getMonth() - 1);
  }

  // For yesterday, only count entries within the exact day
  const effectiveEntries =
    period === 'yesterday'
      ? entries.filter((e) => {
          const ts = new Date(e.timestamp);
          return ts >= startDate && ts < periodEnd;
        })
      : entries;

  const total = effectiveEntries.reduce((sum, e) => sum + e.cost, 0);

  const report: CostReport = {
    period: {
      start: startDate.toISOString(),
      end: periodEnd.toISOString(),
    },
    total,
  };

  if (groupBy === 'agent') {
    report.byAgent = {};
    for (const entry of effectiveEntries) {
      report.byAgent[entry.agent] = (report.byAgent[entry.agent] ?? 0) + entry.cost;
    }
  } else if (groupBy === 'model') {
    report.byModel = {};
    for (const entry of effectiveEntries) {
      report.byModel[entry.model] = (report.byModel[entry.model] ?? 0) + entry.cost;
    }
  } else if (groupBy === 'provider') {
    report.byProvider = {};
    for (const entry of effectiveEntries) {
      report.byProvider[entry.provider] = (report.byProvider[entry.provider] ?? 0) + entry.cost;
    }
  }

  // Add budget status
  const budget = loadDailyBudget();
  if (budget !== undefined) {
    report.budget = {
      limit: budget,
      spent: total,
      percent: (total / budget) * 100,
    };
  }

  return report;
}

/**
 * Load daily budget
 */
export function loadDailyBudget(): number | undefined {
  const config = loadConfig();
  return config.budget?.daily;
}

/**
 * Set daily budget
 */
export function setDailyBudget(amount: number): void {
  const config = loadConfig();
  
  if (!config.budget) {
    config.budget = { daily: amount, alertThreshold: 0.8 };
  } else {
    config.budget.daily = amount;
  }
  
  saveConfig(config);
  logger.info({ amount }, 'Daily budget set');
}

/**
 * Get budget status
 */
export function getBudgetStatus(): { limit: number; spent: number; percent: number } {
  const budget = loadDailyBudget() ?? 10;
  const today = getCostData('today');
  const spent = today.reduce((sum, e) => sum + e.cost, 0);

  return {
    limit: budget,
    spent,
    percent: (spent / budget) * 100,
  };
}
