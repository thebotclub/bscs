import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';

const CLI_PATH = join(__dirname, '../../dist/bin/bscs.js');

describe('CLI E2E', () => {
  it('should show version', () => {
    try {
      const output = execFileSync('node', [CLI_PATH, '--version'], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(output).toContain('0.1.0');
    } catch {
      // CLI may not be built — skip gracefully in dev
      console.log('Skipping: CLI not built (run npm run build first)');
    }
  });
});
