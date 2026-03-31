/**
 * Server-Sent Events (SSE) manager for broadcasting real-time events to clients.
 */
import type { ServerResponse } from 'http';

export type SSEEventType =
  | 'fleet-update'
  | 'agent-status-change'
  | 'action-complete'
  | 'ping';

export interface SSEEvent {
  type: SSEEventType;
  data: unknown;
}

export class SSEManager {
  private readonly clients: Set<ServerResponse> = new Set();

  /**
   * Register a new SSE client connection and send the required headers.
   */
  addClient(res: ServerResponse): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    this.clients.add(res);

    res.on('close', () => {
      this.clients.delete(res);
    });
  }

  /**
   * Remove a client from the set.
   */
  removeClient(res: ServerResponse): void {
    this.clients.delete(res);
  }

  /**
   * Broadcast an event to all connected clients.
   * Write errors are caught per-client to prevent one bad client from
   * disrupting others.
   */
  broadcast(event: SSEEvent): void {
    const payload = JSON.stringify({ type: event.type, data: event.data });
    const message = `event: ${event.type}\ndata: ${payload}\n\n`;

    for (const client of this.clients) {
      try {
        client.write(message);
      } catch {
        // Remove unresponsive client
        this.clients.delete(client);
      }
    }
  }

  /**
   * Number of currently connected SSE clients.
   */
  get clientCount(): number {
    return this.clients.size;
  }
}

/**
 * Singleton SSE manager instance.
 */
export const sseManager: SSEManager = new SSEManager();
