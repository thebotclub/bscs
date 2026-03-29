import { describe, it, expect } from 'vitest';
import { formatTable, formatJson, formatOutput } from '../../../src/util/output.js';

describe('output utilities', () => {
  describe('formatTable', () => {
    it('should format a simple table', () => {
      const headers = ['Name', 'Status', 'Uptime'];
      const rows = [['agent-1', 'running', '2h'], ['agent-2', 'stopped', '0m']];

      const result = formatTable(headers, rows);

      expect(result).toContain('Name');
      expect(result).toContain('Status');
      expect(result).toContain('Uptime');
      expect(result).toContain('agent-1');
      expect(result).toContain('running');
    });

    it('should handle empty rows', () => {
      const headers = ['Name', 'Status'];
      const rows: string[][] = [];

      const result = formatTable(headers, rows);

      expect(result).toContain('No data to display');
    });

    it('should handle rows with missing values', () => {
      const headers = ['Name', 'Status', 'Port'];
      const rows = [['agent-1', 'running']]; // Missing port

      const result = formatTable(headers, rows);

      expect(result).toContain('agent-1');
      expect(result).toContain('running');
    });
  });

  describe('formatJson', () => {
    it('should format JSON with pretty printing', () => {
      const data = { name: 'test', count: 42 };
      const result = formatJson(data, true);

      expect(result).toContain('\n');
      expect(result).toContain('"name"');
      expect(result).toContain('"test"');
    });

    it('should format JSON without pretty printing', () => {
      const data = { name: 'test', count: 42 };
      const result = formatJson(data, false);

      expect(result).not.toContain('\n');
      expect(result).toBe('{"name":"test","count":42}');
    });
  });

  describe('formatOutput', () => {
    it('should return empty string in quiet mode', () => {
      const data = { name: 'test' };
      const result = formatOutput(data, { quiet: true });

      expect(result).toBe('');
    });

    it('should return JSON in json mode', () => {
      const data = { name: 'test' };
      const result = formatOutput(data, { json: true });

      expect(result).toContain('"name"');
      expect(result).toContain('"test"');
    });

    it('should use human formatter when provided and not in json mode', () => {
      const data = { name: 'test' };
      const result = formatOutput(data, {}, () => 'Human readable output');

      expect(result).toBe('Human readable output');
    });
  });
});
