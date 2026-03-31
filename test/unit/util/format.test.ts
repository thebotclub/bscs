import { describe, it, expect } from 'vitest';
import { formatUptime } from '../../../src/util/format.js';

describe('formatUptime', () => {
  it('should format seconds to minutes', () => {
    expect(formatUptime(120)).toBe('2m');
  });

  it('should format with hours and minutes', () => {
    expect(formatUptime(3661)).toBe('1h 1m');
  });

  it('should format with days, hours, minutes', () => {
    expect(formatUptime(90061)).toBe('1d 1h 1m');
  });

  it('should handle zero', () => {
    expect(formatUptime(0)).toBe('0m');
  });
});
