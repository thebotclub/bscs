/**
 * NativeRuntime — AgentRuntime implementation for native (non-Docker) agents.
 * Uses HTTP health probes and launchctl for lifecycle management.
 * Extracted from patterns in fleet.ts and doctor.ts.
 */
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { UserError } from '../../util/errors.js';
import { createLogger } from '../../util/logger.js';
import type {
  AgentRuntime,
  AgentRuntimeConfig,
  CreateResult,
  RuntimeStatus,
  HealthCheckResult,
} from './types.js';

const logger = createLogger('native-runtime');

// Injectable exec for testing
export type ExecFn = (file: string, args: string[], opts?: object) => string;
const defaultExec: ExecFn = (file, args, opts) => execFileSync(file, args, { encoding: 'utf8', ...opts });

export class NativeRuntime implements AgentRuntime {
  private port: number;
  private exec: ExecFn;

  constructor(port?: number, exec?: ExecFn) {
    this.port = port || 18789;
    this.exec = exec || defaultExec;
  }

  async create(_name: string, _config: AgentRuntimeConfig): Promise<CreateResult> {
    throw new UserError(
      'Native agents cannot be created through BSCS',
      'Install and configure the agent natively, then add it to the BSCS config with runtime: "native"',
    );
  }

  async start(name: string): Promise<void> {
    try {
      this.exec('launchctl', ['kickstart', '-k', `gui/${this.getUid()}/ai.openclaw.${name}`]);
      logger.info({ name }, 'Native agent started via launchctl');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to start native agent "${name}": ${message}`);
    }
  }

  async stop(name: string): Promise<void> {
    try {
      this.exec('launchctl', ['kill', 'SIGTERM', `gui/${this.getUid()}/ai.openclaw.${name}`]);
      logger.info({ name }, 'Native agent stopped via launchctl');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug({ name, err: message }, 'Failed to stop native agent (may already be stopped)');
    }
  }

  async restart(name: string): Promise<void> {
    await this.stop(name);
    await this.start(name);
  }

  async destroy(_name: string): Promise<void> {
    throw new UserError(
      'Native agents cannot be destroyed through BSCS',
      'Uninstall the agent natively, then remove it from the BSCS config',
    );
  }

  async status(name: string): Promise<RuntimeStatus> {
    const healthy = this.probeHealth(name);
    return {
      name,
      status: healthy ? 'running' : 'stopped',
    };
  }

  logs(name: string, opts?: { tail?: number; follow?: boolean }): ChildProcess {
    const args = ['gateway', 'logs', '--agent', name];
    if (opts?.tail !== undefined) args.push('--tail', String(opts.tail));
    if (opts?.follow) args.push('-f');
    return spawn('openclaw', args, { stdio: 'inherit' });
  }

  shell(_name: string): ChildProcess {
    throw new UserError(
      'Native agents do not support shell access',
      'Connect to the agent host directly via SSH',
    );
  }

  async list(): Promise<RuntimeStatus[]> {
    // Native agents can't be discovered globally — return empty.
    // Fleet status uses config to find them.
    return [];
  }

  async healthCheck(name: string): Promise<HealthCheckResult> {
    const now = new Date().toISOString();
    const healthy = this.probeHealth(name);

    if (healthy) {
      return {
        name,
        status: 'healthy',
        containerStatus: 'running',
        restartNeeded: false,
        lastCheck: now,
      };
    }

    return {
      name,
      status: 'unhealthy',
      containerStatus: 'stopped',
      restartNeeded: true,
      lastCheck: now,
      error: 'Health probe failed',
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      this.exec('which', ['openclaw'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  private probeHealth(_name: string): boolean {
    try {
      const res = this.exec('curl', ['-s', '--max-time', '2', `http://127.0.0.1:${this.port}/healthz`], { timeout: 5000 });
      return res.includes('"ok"') || res.includes('"live"');
    } catch {
      return false;
    }
  }

  private getUid(): string {
    try {
      return this.exec('id', ['-u'], { timeout: 3000 }).trim();
    } catch {
      return '501'; // macOS default
    }
  }
}
