import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UserError, withErrorHandler } from '../../../src/util/errors.js';

describe('UserError', () => {
  it('should store message and suggestion', () => {
    const err = new UserError('something broke', 'try this');
    expect(err.message).toBe('something broke');
    expect(err.suggestion).toBe('try this');
    expect(err.name).toBe('UserError');
  });

  it('should work without suggestion', () => {
    const err = new UserError('just a message');
    expect(err.message).toBe('just a message');
    expect(err.suggestion).toBeUndefined();
  });
});

describe('withErrorHandler', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  
  beforeEach(() => {
    process.exitCode = undefined;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('should not set exit code on success', async () => {
    await withErrorHandler(async () => {});
    expect(process.exitCode).toBeUndefined();
  });

  it('should set exit code 1 for UserError', async () => {
    await withErrorHandler(async () => {
      throw new UserError('test error', 'test suggestion');
    });
    expect(process.exitCode).toBe(1);
  });

  it('should set exit code 2 for unexpected errors', async () => {
    await withErrorHandler(async () => {
      throw new Error('unexpected');
    });
    expect(process.exitCode).toBe(2);
  });
});
