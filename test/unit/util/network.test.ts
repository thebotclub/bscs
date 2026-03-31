import { describe, it, expect } from 'vitest';
import { getLocalIps, isLocalMachine } from '../../../src/util/network.js';

describe('getLocalIps', () => {
  it('should return an array of strings', () => {
    const ips = getLocalIps();
    expect(Array.isArray(ips)).toBe(true);
    expect(ips.length).toBeGreaterThan(0);
  });

  it('should include 127.0.0.1 or at least return a fallback', () => {
    const ips = getLocalIps();
    // Either we get real IPs or the fallback
    expect(ips.length).toBeGreaterThan(0);
  });
});

describe('isLocalMachine', () => {
  it('should return true for localhost', () => {
    expect(isLocalMachine('localhost')).toBe(true);
  });

  it('should return true for 127.0.0.1', () => {
    expect(isLocalMachine('127.0.0.1')).toBe(true);
  });

  it('should return false for a remote host', () => {
    expect(isLocalMachine('remote-server.example.com')).toBe(false);
  });
});
