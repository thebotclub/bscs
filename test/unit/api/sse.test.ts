import { describe, it, expect, beforeEach } from 'vitest';
import type { ServerResponse } from 'http';
import { SSEManager, type SSEEvent } from '../../../src/api/sse.js';

function mockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body = '';
  const closeHandlers: Array<() => void> = [];
  return {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    writeHead: (code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
    },
    end: (data?: string) => {
      body = data ?? '';
    },
    write: (data: string) => {
      body += data;
      return true;
    },
    on: (event: string, handler: () => void) => {
      if (event === 'close') closeHandlers.push(handler);
    },
    triggerClose: () => closeHandlers.forEach((h) => h()),
    get headers() {
      return headers;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
}

describe('SSEManager', () => {
  let manager: SSEManager;

  beforeEach(() => {
    manager = new SSEManager();
  });

  describe('addClient', () => {
    it('increments clientCount', () => {
      const res = mockRes();
      manager.addClient(res as unknown as ServerResponse);
      expect(manager.clientCount).toBe(1);
    });

    it('sends SSE headers (Content-Type: text/event-stream)', () => {
      const res = mockRes();
      manager.addClient(res as unknown as ServerResponse);
      expect(res.headers['Content-Type']).toBe('text/event-stream');
    });

    it('sends Cache-Control: no-cache', () => {
      const res = mockRes();
      manager.addClient(res as unknown as ServerResponse);
      expect(res.headers['Cache-Control']).toBe('no-cache');
    });

    it('sends Connection: keep-alive', () => {
      const res = mockRes();
      manager.addClient(res as unknown as ServerResponse);
      expect(res.headers['Connection']).toBe('keep-alive');
    });

    it('can add multiple clients', () => {
      manager.addClient(mockRes() as unknown as ServerResponse);
      manager.addClient(mockRes() as unknown as ServerResponse);
      expect(manager.clientCount).toBe(2);
    });
  });

  describe('removeClient', () => {
    it('decrements clientCount', () => {
      const res = mockRes() as unknown as ServerResponse;
      manager.addClient(res);
      manager.removeClient(res);
      expect(manager.clientCount).toBe(0);
    });

    it('does not throw when removing unknown client', () => {
      const res = mockRes() as unknown as ServerResponse;
      expect(() => manager.removeClient(res)).not.toThrow();
    });
  });

  describe('broadcast', () => {
    it('sends formatted SSE data to all connected clients', () => {
      const res1 = mockRes();
      const res2 = mockRes();
      manager.addClient(res1 as unknown as ServerResponse);
      manager.addClient(res2 as unknown as ServerResponse);

      const event: SSEEvent = { type: 'fleet-update', data: { count: 5 } };
      manager.broadcast(event);

      expect(res1.body).toContain('data:');
      expect(res1.body).toContain('fleet-update');
      expect(res2.body).toContain('data:');
    });

    it('includes event type in the message', () => {
      const res = mockRes();
      manager.addClient(res as unknown as ServerResponse);

      const event: SSEEvent = { type: 'ping', data: {} };
      manager.broadcast(event);

      expect(res.body).toContain('ping');
    });

    it('handles write errors gracefully (does not throw)', () => {
      const badRes = {
        setHeader: (_k: string, _v: string) => {},
        writeHead: (_c: number) => {},
        end: (_d?: string) => {},
        write: (_d: string): boolean => {
          throw new Error('write failed');
        },
        on: (_event: string, _handler: () => void) => {},
      } as unknown as ServerResponse;

      manager.addClient(badRes);
      const event: SSEEvent = { type: 'agent-status-change', data: {} };
      expect(() => manager.broadcast(event)).not.toThrow();
    });

    it('broadcasts to zero clients without error', () => {
      const event: SSEEvent = { type: 'action-complete', data: {} };
      expect(() => manager.broadcast(event)).not.toThrow();
    });
  });

  describe('clientCount', () => {
    it('starts at zero', () => {
      expect(manager.clientCount).toBe(0);
    });

    it('returns correct count after adding and removing', () => {
      const r1 = mockRes() as unknown as ServerResponse;
      const r2 = mockRes() as unknown as ServerResponse;
      manager.addClient(r1);
      manager.addClient(r2);
      expect(manager.clientCount).toBe(2);
      manager.removeClient(r1);
      expect(manager.clientCount).toBe(1);
    });
  });
});
