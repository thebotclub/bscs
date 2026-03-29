/**
 * Core watchdog module — container health monitoring and restart logic.
 */
import { listBscsContainers, startContainer, type ContainerInfo } from './docker.js';
import { loadConfig } from './config.js';
import { createLogger } from '../util/logger.js';

const logger = createLogger('watchdog');

// ── Types ────────────────────────────────────────────────────────────

export interface HealthCheckResult {
  name: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  containerStatus: string;
  restartNeeded: boolean;
  lastCheck: string;
  error?: string;
}

export interface WatchdogConfig {
  interval: number;       // seconds between checks
  maxRestarts: number;    // max restarts before giving up
  cooldownMs: number;     // cooldown between restarts
}

const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  interval: 30,
  maxRestarts: 3,
  cooldownMs: 60000,
};

// Track restart attempts
const restartCounts = new Map<string, { count: number; lastRestart: number }>();

// ── Health Check ─────────────────────────────────────────────────────

export async function checkHealth(): Promise<HealthCheckResult[]> {
  const config = loadConfig();
  const results: HealthCheckResult[] = [];

  let containers: ContainerInfo[] = [];
  try {
    containers = await listBscsContainers();
  } catch (err) {
    logger.error({ err }, 'Failed to list containers for health check');
    return results;
  }

  const containerMap = new Map(
    containers.map((c) => [c.name.replace('openclaw_', ''), c]),
  );

  const agents = config.agents || {};

  for (const [name, agentConfig] of Object.entries(agents)) {
    const container = containerMap.get(name);

    if (!container) {
      results.push({
        name,
        status: 'unhealthy',
        containerStatus: 'missing',
        restartNeeded: true,
        lastCheck: new Date().toISOString(),
        error: 'Container not found',
      });
      continue;
    }

    const shouldBeRunning = agentConfig.status === 'running';
    const isRunning = container.status === 'running';

    if (shouldBeRunning && !isRunning) {
      results.push({
        name,
        status: 'unhealthy',
        containerStatus: container.status,
        restartNeeded: true,
        lastCheck: new Date().toISOString(),
        error: `Expected running, found ${container.status}`,
      });
    } else if (isRunning) {
      results.push({
        name,
        status: 'healthy',
        containerStatus: 'running',
        restartNeeded: false,
        lastCheck: new Date().toISOString(),
      });
    } else {
      results.push({
        name,
        status: 'unknown',
        containerStatus: container.status,
        restartNeeded: false,
        lastCheck: new Date().toISOString(),
      });
    }
  }

  return results;
}

// ── Restart Logic ────────────────────────────────────────────────────

export async function restartUnhealthy(
  watchdogConfig: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG,
): Promise<Array<{ name: string; restarted: boolean; error?: string }>> {
  const results: Array<{ name: string; restarted: boolean; error?: string }> = [];
  const healthChecks = await checkHealth();
  const now = Date.now();

  for (const check of healthChecks) {
    if (!check.restartNeeded) continue;

    const tracker = restartCounts.get(check.name) || { count: 0, lastRestart: 0 };

    // Check cooldown
    if (now - tracker.lastRestart < watchdogConfig.cooldownMs) {
      results.push({
        name: check.name,
        restarted: false,
        error: 'In cooldown period',
      });
      continue;
    }

    // Check max restarts
    if (tracker.count >= watchdogConfig.maxRestarts) {
      results.push({
        name: check.name,
        restarted: false,
        error: `Max restarts (${watchdogConfig.maxRestarts}) exceeded`,
      });
      continue;
    }

    try {
      await startContainer(check.name);
      tracker.count++;
      tracker.lastRestart = now;
      restartCounts.set(check.name, tracker);
      logger.info({ name: check.name, attempt: tracker.count }, 'Container restarted');
      results.push({ name: check.name, restarted: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ name: check.name, err }, 'Failed to restart container');
      results.push({ name: check.name, restarted: false, error: message });
    }
  }

  return results;
}

// ── Reset ────────────────────────────────────────────────────────────

export function resetRestartCounts(name?: string): void {
  if (name) {
    restartCounts.delete(name);
  } else {
    restartCounts.clear();
  }
}

export { DEFAULT_WATCHDOG_CONFIG };
