import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Test cost recording
describe('recordCostEntry', () => {
  let tempDir: string;
  let originalCostDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-cost-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    originalCostDir = process.env.BSCS_COST_DIR;
    process.env.BSCS_COST_DIR = tempDir;
  });

  afterEach(() => {
    if (originalCostDir) {
      process.env.BSCS_COST_DIR = originalCostDir;
    } else {
      delete process.env.BSCS_COST_DIR;
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should write cost entry to JSONL file', async () => {
    const { recordCostEntry } = await import('../../../src/core/cost.js');

    const entry = {
      timestamp: '2025-01-15T10:30:00.000Z',
      agent: 'test-agent',
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.0105,
    };

    recordCostEntry(entry);

    const costDir = join(tempDir, 'costs');
    const filePath = join(costDir, '2025-01-15.jsonl');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.agent).toBe('test-agent');
    expect(parsed.model).toBe('claude-sonnet-4');
    expect(parsed.cost).toBe(0.0105);
  });

  it('should append multiple entries to same day file', async () => {
    const { recordCostEntry } = await import('../../../src/core/cost.js');

    recordCostEntry({
      timestamp: '2025-01-15T10:00:00.000Z',
      agent: 'agent-1',
      model: 'gpt-4o',
      provider: 'openai',
      inputTokens: 500,
      outputTokens: 200,
      cost: 0.003,
    });

    recordCostEntry({
      timestamp: '2025-01-15T11:00:00.000Z',
      agent: 'agent-2',
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.0105,
    });

    const filePath = join(tempDir, 'costs', '2025-01-15.jsonl');
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    const second = JSON.parse(lines[1]!);
    expect(first.agent).toBe('agent-1');
    expect(second.agent).toBe('agent-2');
  });
});
