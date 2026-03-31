/**
 * @deprecated This module is superseded by src/api/server.ts which serves both
 * the API and the dashboard static files. Only the createDashboardCommand(),
 * buildWsFrame, and broadcastUpdate exports remain, everything else has been
 * removed. This file will be deleted in the next major release.
 */
import { Command } from 'commander';
import { createLogger } from '../util/logger.js';
import { getFleetStatus } from '../core/fleet.js';
import { loadConfig } from '../core/config.js';
import type { BscsConfig } from '../util/types.js';

const logger = createLogger('dashboard');

// WebSocket clients (raw net.Socket instances managed by the legacy WS upgrade)
const wsClients: Set<import('net').Socket> = new Set();

export interface DashboardServer {
  port: number;
  token: string;
  close: () => void;
}

// ── Helpers ─────────────────────────────────────────────────────────

function getMachineName(ip: string, config: BscsConfig): string {
  const machine = config.machines?.[ip];
  return machine?.sshAlias || ip;
}

// ── WebSocket frame builder ─────────────────────────────────────────

/**
 * Build a RFC 6455 WebSocket text frame (server → client, unmasked).
 * Handles all three payload length ranges per the spec:
 *   0–125    : 1-byte length
 *   126–65535: 2-byte (uint16) length (preceded by 0x7e)
 *   65536+   : 8-byte (uint64) length (preceded by 0x7f)
 */
export function buildWsFrame(message: string): Buffer {
  const payload = Buffer.from(message, 'utf8');
  const len = payload.length;

  let header: Buffer;
  if (len <= 125) {
    header = Buffer.from([0x81, len]);
  } else if (len <= 65535) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x81;
    header[1] = 0x7e;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x81;
    header[1] = 0x7f;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }

  return Buffer.concat([header, payload]);
}

// ── WebSocket broadcast ─────────────────────────────────────────────

export async function broadcastUpdate(): Promise<void> {
  if (wsClients.size === 0) return;

  try {
    const config = loadConfig();
    const status = await getFleetStatus(true);
    for (const agent of status.agents) {
      (agent as unknown as Record<string, unknown>).machineName = getMachineName(agent.machine, config);
    }
    const message = JSON.stringify({ type: 'fleet-update', data: status });
    const frame = buildWsFrame(message);

    for (const client of wsClients) {
      try {
        client.write(frame);
      } catch {
        wsClients.delete(client);
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to broadcast update');
  }
}

// ── CLI command ─────────────────────────────────────────────────────

export function createDashboardCommand(): Command {
  const command = new Command('dashboard')
    .description('Launch the BSCS dashboard')
    .option('-p, --port <port>', 'Port', '3200')
    .option('-b, --bind <address>', 'Bind address', '127.0.0.1')
    .option('-o, --open', 'Open in browser')
    .action(async (options) => {
      const port = parseInt(options.port, 10);
      const bind = options.bind || '127.0.0.1';

      try {
        const { startApiServer } = await import('../api/server.js');
        const server = await startApiServer(port, bind);

        console.log(`Dashboard: http://localhost:${port}`);
        console.log(`Auth token: ${server.token}`);

        if (options.open) {
          const { execFileSync } = await import('child_process');
          const url = `http://localhost:${port}`;
          try {
            if (process.platform === 'darwin') {
              execFileSync('open', [url]);
            } else if (process.platform === 'linux') {
              execFileSync('xdg-open', [url]);
            }
          } catch {
            // Failed to open browser — not critical
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to start dashboard: ${message}`);
        process.exitCode = 1;
      }
    });

  return command;
}
