import { describe, it, expect } from 'vitest';
import { readBody } from '../../../../src/api/middleware/body.js';
import { Readable } from 'stream';

function mockRequest(body: string): any {
  const readable = new Readable({
    read() {
      this.push(Buffer.from(body));
      this.push(null);
    },
  });
  (readable as any).destroy = () => {};
  return readable;
}

function mockLargeRequest(size: number): any {
  const readable = new Readable({
    read() {
      this.push(Buffer.alloc(size, 'x'));
      this.push(null);
    },
  });
  (readable as any).destroy = () => {};
  return readable;
}

describe('readBody', () => {
  it('should read a normal body', async () => {
    const req = mockRequest('{"token":"abc"}');
    const body = await readBody(req);
    expect(body).toBe('{"token":"abc"}');
  });

  it('should reject body exceeding max size', async () => {
    const req = mockLargeRequest(65537);
    await expect(readBody(req, 1024)).rejects.toThrow('Request body too large');
  });

  it('should accept body at exactly max size', async () => {
    const req = mockRequest('x'.repeat(1024));
    const body = await readBody(req, 1024);
    expect(body.length).toBe(1024);
  });
});
