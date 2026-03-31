import { describe, it, expect, beforeEach } from 'vitest';
import { isRateLimited, resetRateLimits, MAX_ATTEMPTS } from '../../../../src/api/middleware/rate-limit.js';

describe('isRateLimited', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it('should allow first request', () => {
    expect(isRateLimited('127.0.0.1')).toBe(false);
  });

  it('should allow up to MAX_ATTEMPTS requests', () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(isRateLimited('127.0.0.1')).toBe(false);
    }
  });

  it('should block after MAX_ATTEMPTS', () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      isRateLimited('127.0.0.1');
    }
    expect(isRateLimited('127.0.0.1')).toBe(true);
  });

  it('should track different IPs independently', () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      isRateLimited('127.0.0.1');
    }
    expect(isRateLimited('127.0.0.1')).toBe(true);
    expect(isRateLimited('192.168.1.1')).toBe(false);
  });
});
