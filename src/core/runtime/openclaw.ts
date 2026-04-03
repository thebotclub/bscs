/**
 * OpenClawRuntime — AgentRuntime implementation for OpenClaw shared-gateway agents.
 * Manages agents through the `openclaw` CLI and gateway HTTP API.
 * Uses execFileSync (injection-safe) and HTTP with timeouts.
 */
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { UserError } from '../../util/errors.js';
import { createLogger } from '../../util/logger.js';
import type {
  OpenClawAgentRuntime,
  AgentRuntimeConfig,
  CreateResult,
  RuntimeStatus,
  HealthCheckResult,
} from './types.js';

const logger = createLogger('openclaw-runtime');

/** Consistent timeout for all health/status probes (ms). */
const HEALTH_TIMEOUT_MS = 3000;

// Injectable types for testing
export type ExecFn = (file: string, args: string[], opts?: object) => string;
export type HttpFn = (url: string, opts?: { timeout?: number; signal?: AbortSignal }) => Promise<{ ok: boolean; body: string; status: number }>;

const defaultExec: ExecFn = (file, args, opts) => execFileSync(file, args, { encoding: 'utf8', ...opts });

async function defaultHttp(url: string, opts?: { timeout?: number; signal?: AbortSignal }): Promise<{ ok: boolean; body: string; status: number }> {
  try {
    const timeout = opts?.timeout || HEALTH_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    // Allow external signal (e.g. from parent context) to also abort
    const combinedSignal = opts?.signal
      ? AbortSignal.any([opts.signal, controller.signal])
      : controller.signal;
    try {
      const res = await fetch(url, { signal: combinedSignal });
      const body = await res.text();
      return { ok: res.ok, body, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, body: '', status: 0 };
  }
}

export class OpenClawRuntime implements OpenClawAgentRuntime {
  private gatewayUrl: string;
  private exec: ExecFn;
  private http: HttpFn;

  constructor(gatewayUrl?: string, exec?: ExecFn, http?: HttpFn) {
    this.gatewayUrl = gatewayUrl || 'http://127.0.0.1:18777';
    this.exec = exec || defaultExec;
    this.http = http || defaultHttp;
  }

  async create(name: string, _config: AgentRuntimeConfig): Promise<CreateResult> {
    try {
      this.exec('openclaw', ['agents', 'add', name], { timeout: 15000 });
      logger.info({ name }, 'OpenClaw agent created');
      return { name, status: 'created' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create OpenClaw agent "${name}": ${message}`);
    }
  }

  async start(name: string): Promise<void> {
    try {
      this.exec('openclaw', ['config', 'set', `agent.${name}.enabled`, 'true'], { timeout: 10000 });
      logger.info({ name }, 'OpenClaw agent enabled');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to start OpenClaw agent "${name}": ${message}`);
    }
  }

  async stop(name: string): Promise<void> {
    try {
      this.exec('openclaw', ['config', 'set', `agent.${name}.enabled`, 'false'], { timeout: 10000 });
      logger.info({ name }, 'OpenClaw agent disabled');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to stop OpenClaw agent "${name}": ${message}`);
    }
  }

  async restart(name: string): Promise<void> {
    await this.stop(name);
    await this.start(name);
  }

  async destroy(name: string): Promise<void> {
    try {
      this.exec('openclaw', ['agents', 'delete', name], { timeout: 15000 });
      logger.info({ name }, 'OpenClaw agent deleted');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to destroy OpenClaw agent "${name}": ${message}`);
    }
  }

  async status(name: string): Promise<RuntimeStatus> {
    // Try gateway healthz first
    const res = await this.http(`${this.gatewayUrl}/healthz`, { timeout: HEALTH_TIMEOUT_MS });
    if (!res.ok) {
      return { name, status: 'unknown' };
    }

    // Try to get agent-specific status from agent list
    try {
      const output = this.exec('openclaw', ['agents', 'list', '--json'], { timeout: 10000 });
      const agents = JSON.parse(output);
      const agent = Array.isArray(agents)
        ? agents.find((a: { id?: string; name?: string }) => (a.id || a.name) === name)
        : null;

      if (!agent) {
        return { name, status: 'missing' };
      }

      const enabled = agent.enabled !== false;
      return {
        name,
        status: enabled ? 'running' : 'stopped',
      };
    } catch {
      // Fallback: if gateway is up, assume agent is running
      return { name, status: res.ok ? 'running' : 'unknown' };
    }
  }

  logs(name: string, opts?: { tail?: number; follow?: boolean }): ChildProcess {
    const args = ['gateway', 'logs', '--agent', name];
    if (opts?.tail !== undefined) args.push('--tail', String(opts.tail));
    if (opts?.follow) args.push('-f');
    return spawn('openclaw', args, { stdio: 'inherit' });
  }

  shell(_name: string): ChildProcess {
    throw new UserError(
      'OpenClaw agents on shared gateway do not support shell access',
      'Use "openclaw" CLI directly to interact with the gateway',
    );
  }

  async list(): Promise<RuntimeStatus[]> {
    try {
      const output = this.exec('openclaw', ['agents', 'list', '--json'], { timeout: 10000 });
      const agents = JSON.parse(output);
      if (!Array.isArray(agents)) return [];
      return agents.map((a: { id: string; name?: string; enabled?: boolean }) => ({
        name: a.id || a.name || 'unknown',
        status: (a.enabled !== false ? 'running' : 'stopped') as RuntimeStatus['status'],
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, 'Failed to list agents — gateway may be returning non-JSON content');
      return [];
    }
  }

  async healthCheck(name: string): Promise<HealthCheckResult> {
    const now = new Date().toISOString();

    // Check gateway health first
    const healthRes = await this.http(`${this.gatewayUrl}/healthz`, { timeout: HEALTH_TIMEOUT_MS });
    if (!healthRes.ok) {
      return {
        name,
        status: 'unhealthy',
        containerStatus: 'gateway-down',
        restartNeeded: true,
        lastCheck: now,
        error: `Gateway unreachable at ${this.gatewayUrl}`,
      };
    }

    // Check agent-specific status
    const runtimeStatus = await this.status(name);
    if (runtimeStatus.status === 'running') {
      return {
        name,
        status: 'healthy',
        containerStatus: 'running',
        restartNeeded: false,
        lastCheck: now,
      };
    }

    if (runtimeStatus.status === 'missing') {
      return {
        name,
        status: 'unhealthy',
        containerStatus: 'missing',
        restartNeeded: true,
        lastCheck: now,
        error: 'Agent not registered in gateway',
      };
    }

    return {
      name,
      status: 'unhealthy',
      containerStatus: runtimeStatus.status,
      restartNeeded: true,
      lastCheck: now,
      error: `Agent is ${runtimeStatus.status}`,
    };
  }

  async isAvailable(): Promise<boolean> {
    // Check CLI exists
    try {
      this.exec('command', ['-v', 'openclaw'], { timeout: 5000 });
    } catch {
      return false;
    }

    // Check gateway is reachable
    const res = await this.http(`${this.gatewayUrl}/healthz`, { timeout: HEALTH_TIMEOUT_MS });
    return res.ok;
  }

  // ── OpenClaw-specific operations ─────────────────────────────────

  async bindChannel(name: string, channelType: string, accountId: string): Promise<void> {
    try {
      this.exec('openclaw', ['agents', 'bind', '--agent', name, '--bind', `${channelType}:${accountId}`], { timeout: 10000 });
      logger.info({ name, channelType, accountId }, 'Channel bound');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to bind channel for "${name}": ${message}`);
    }
  }

  async unbindChannel(name: string, channelType: string): Promise<void> {
    try {
      this.exec('openclaw', ['agents', 'unbind', '--agent', name, '--channel', channelType], { timeout: 10000 });
      logger.info({ name, channelType }, 'Channel unbound');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to unbind channel for "${name}": ${message}`);
    }
  }

  async setConfig(path: string, value: string): Promise<void> {
    try {
      this.exec('openclaw', ['config', 'set', path, value], { timeout: 10000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to set config "${path}": ${message}`);
    }
  }

  async listAgents(): Promise<Array<{ name: string; enabled: boolean; channels?: Array<{ type: string; accountId: string }>; model?: string }>> {
    try {
      const output = this.exec('openclaw', ['agents', 'list', '--json'], { timeout: 10000 });
      const raw: Array<Record<string, unknown>> = JSON.parse(output);
      if (!Array.isArray(raw)) return [];
      return raw.map((a) => ({
        name: (a.id as string) || (a.name as string) || 'unknown',
        enabled: a.enabled !== false,
        channels: Array.isArray(a.channels)
          ? a.channels.map((c: { type: string; accountId?: string; id?: string }) => ({
              type: c.type,
              accountId: c.accountId || c.id || '',
            }))
          : undefined,
        model: typeof a.model === 'string' ? a.model : undefined,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, 'Failed to list agents — gateway may be returning non-JSON content');
      return [];
    }
  }

  async restartGateway(): Promise<void> {
    try {
      this.exec('openclaw', ['gateway', 'restart'], { timeout: 30000 });
      logger.info('OpenClaw gateway restarted');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to restart gateway: ${message}`);
    }
  }
}
