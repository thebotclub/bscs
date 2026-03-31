import { describe, it, expect, beforeEach } from 'vitest';

// We test the signal logic by importing the module
// Since signals are module-level state, we reset before each test
// by re-importing via dynamic import with cache-busting isn't easy in vitest,
// so we manipulate signal values directly.

import {
  fleet,
  loading,
  error,
  filter,
  sortBy,
  selectedMachine,
  filteredAgents,
  machines,
} from '../../../src/ui/signals.js';
import type { FleetStatus } from '../../../src/ui/api.js';

const sampleFleet: FleetStatus = {
  agents: [
    { name: 'alpha', status: 'running', machine: '10.0.0.1', health: 'ok', role: 'TG' },
    { name: 'beta', status: 'stopped', machine: '10.0.0.2', health: 'ok', role: 'WA' },
    { name: 'gamma', status: 'running', machine: '10.0.0.1', health: 'ok', role: 'DC' },
    { name: 'delta', status: 'unknown', machine: '10.0.0.3', health: 'degraded' },
  ],
  machines: {
    '10.0.0.1': { name: 'server-1', role: 'primary' },
    '10.0.0.2': { name: 'server-2' },
    '10.0.0.3': { name: 'server-3' },
  },
};

beforeEach(() => {
  fleet.value = null;
  filter.value = '';
  sortBy.value = 'name';
  selectedMachine.value = null;
  loading.value = false;
  error.value = null;
});

describe('filteredAgents signal', () => {
  it('returns empty array when fleet is null', () => {
    fleet.value = null;
    expect(filteredAgents.value).toEqual([]);
  });

  it('returns all agents when no filter or machine selected', () => {
    fleet.value = sampleFleet;
    expect(filteredAgents.value).toHaveLength(4);
  });

  it('filters agents by name text', () => {
    fleet.value = sampleFleet;
    filter.value = 'alp';
    const result = filteredAgents.value;
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('alpha');
  });

  it('filters agents by machine text', () => {
    fleet.value = sampleFleet;
    filter.value = '10.0.0.2';
    const result = filteredAgents.value;
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('beta');
  });

  it('filter is case-insensitive', () => {
    fleet.value = sampleFleet;
    filter.value = 'ALPHA';
    expect(filteredAgents.value).toHaveLength(1);
  });

  it('filters by selectedMachine', () => {
    fleet.value = sampleFleet;
    selectedMachine.value = '10.0.0.1';
    const result = filteredAgents.value;
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.name).sort()).toEqual(['alpha', 'gamma']);
  });

  it('combines machine filter and text filter', () => {
    fleet.value = sampleFleet;
    selectedMachine.value = '10.0.0.1';
    filter.value = 'alp';
    expect(filteredAgents.value).toHaveLength(1);
    expect(filteredAgents.value[0]?.name).toBe('alpha');
  });

  it('sorts by name ascending', () => {
    fleet.value = sampleFleet;
    sortBy.value = 'name';
    const names = filteredAgents.value.map((a) => a.name);
    expect(names).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  });

  it('sorts by status', () => {
    fleet.value = sampleFleet;
    sortBy.value = 'status';
    const statuses = filteredAgents.value.map((a) => a.status);
    // running, running, stopped, unknown
    expect(statuses[0]).toBe('running');
    expect(statuses[2]).toBe('stopped');
    expect(statuses[3]).toBe('unknown');
  });

  it('sorts by machine', () => {
    fleet.value = sampleFleet;
    sortBy.value = 'machine';
    const result = filteredAgents.value;
    // 10.0.0.1 agents first, then 10.0.0.2, then 10.0.0.3
    expect(result[0]?.machine).toBe('10.0.0.1');
    expect(result[result.length - 1]?.machine).toBe('10.0.0.3');
  });
});

describe('machines computed signal', () => {
  it('returns empty array when fleet is null', () => {
    fleet.value = null;
    expect(machines.value).toEqual([]);
  });

  it('returns unique machine IPs sorted', () => {
    fleet.value = sampleFleet;
    const result = machines.value;
    expect(result).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  });

  it('includes machines from machines map even without agents', () => {
    fleet.value = {
      agents: [{ name: 'x', status: 'running', machine: '10.0.0.1', health: 'ok' }],
      machines: {
        '10.0.0.1': {},
        '10.0.0.9': { name: 'extra' },
      },
    };
    const result = machines.value;
    expect(result).toContain('10.0.0.9');
  });
});

describe('loading and error signals', () => {
  it('loading defaults to false', () => {
    expect(loading.value).toBe(false);
  });

  it('error defaults to null', () => {
    expect(error.value).toBeNull();
  });

  it('can set and read loading state', () => {
    loading.value = true;
    expect(loading.value).toBe(true);
    loading.value = false;
    expect(loading.value).toBe(false);
  });

  it('can set and read error state', () => {
    error.value = 'Something went wrong';
    expect(error.value).toBe('Something went wrong');
  });
});
