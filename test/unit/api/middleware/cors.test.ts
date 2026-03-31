import { describe, it, expect } from 'vitest';
import { isAllowedOrigin } from '../../../../src/api/middleware/cors.js';

describe('isAllowedOrigin', () => {
  it('allows http://localhost', () => {
    expect(isAllowedOrigin('http://localhost')).toBe(true);
  });

  it('allows http://localhost with port', () => {
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
  });

  it('allows https://localhost', () => {
    expect(isAllowedOrigin('https://localhost')).toBe(true);
  });

  it('allows http://127.0.0.1', () => {
    expect(isAllowedOrigin('http://127.0.0.1')).toBe(true);
  });

  it('allows http://127.0.0.1 with port', () => {
    expect(isAllowedOrigin('http://127.0.0.1:8080')).toBe(true);
  });

  it('allows http://[::1]', () => {
    expect(isAllowedOrigin('http://[::1]')).toBe(true);
  });

  it('allows http://[::1] with port', () => {
    expect(isAllowedOrigin('http://[::1]:4000')).toBe(true);
  });

  it('allows *.ts.net domains', () => {
    expect(isAllowedOrigin('https://my-machine.ts.net')).toBe(true);
  });

  it('allows *.ts.net with port', () => {
    expect(isAllowedOrigin('https://my-machine.ts.net:8443')).toBe(true);
  });

  it('allows subdomains of ts.net', () => {
    expect(isAllowedOrigin('https://fleet-ctrl.ts.net')).toBe(true);
  });

  it('blocks evil.com', () => {
    expect(isAllowedOrigin('https://evil.com')).toBe(false);
  });

  it('blocks attacker domain that contains localhost', () => {
    expect(isAllowedOrigin('https://notlocalhost.com')).toBe(false);
  });

  it('blocks ts.net lookalike', () => {
    expect(isAllowedOrigin('https://evil-ts.net')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isAllowedOrigin(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isAllowedOrigin('')).toBe(false);
  });
});
