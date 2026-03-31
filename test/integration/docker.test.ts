import { describe, it, expect } from 'vitest';
import { isDockerRunning } from '../../src/core/docker.js';

describe('Docker Integration', () => {
  it('should detect Docker availability', async () => {
    const running = await isDockerRunning();
    // This test reports Docker status — doesn't fail if Docker is not running
    expect(typeof running).toBe('boolean');
  });
});
