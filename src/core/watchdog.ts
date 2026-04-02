/**
 * Core watchdog module — agent health monitoring and restart logic.
 * Dispatches through runtime interface for multi-runtime support.
 */
import { getRuntime } from './runtime/index.js';
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
// Guard against concurrent restart of the same key
const restartInFlight = new Set<string>();

// ── Health Check ─────────────────────────────────────────────────────

export async function checkHealth(): Promise<HealthCheckResult[]> {
  const config = loadConfig();
  const results: HealthCheckResult[] = [];
  const agents = config.agents || {};

  // Group agents by runtime for efficient batch queries
  const dockerAgents: string[] = [];
  const otherAgents: Array<{ name: string; runtime: string; port?: number; gatewayUrl?: string }> = [];

  for (const [name, agentConfig] of Object.entries(agents)) {
    const runtime = agentConfig.runtime || 'docker';
    if (runtime === 'docker') {
      dockerAgents.push(name);
    } else {
      otherAgents.push({
        name,
        runtime,
        port: agentConfig.ports?.gateway,
        gatewayUrl: agentConfig.openclaw?.gatewayUrl,
      });
    }
  }

  // Docker agents — batch query via list() then match (efficient)
  if (dockerAgents.length > 0) {
    const dockerRuntime = getRuntime('docker');
    let containerStatuses: Array<{ name: string; status: string }> = [];
    try {
      containerStatuses = await dockerRuntime.list();
    } catch (err) {
      logger.error({ err }, 'Failed to list containers for health check');
    }

    const containerMap = new Map(containerStatuses.map((c) => [c.name, c]));

    for (const name of dockerAgents) {
      const agentConfig = agents[name]!;
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
  }

  // Non-Docker agents — per-agent health check via runtime
  // Deduplicate gateway checks for openclaw agents sharing the same gateway
  const gatewayHealthCache = new Map<string, HealthCheckResult>();

  for (const { name, runtime: runtimeType, port, gatewayUrl } of otherAgents) {
    try {
      // For openclaw agents, reuse cached result if gateway already checked
      if (runtimeType === 'openclaw' && gatewayUrl) {
        const cached = gatewayHealthCache.get(gatewayUrl);
        if (cached) {
          results.push({ ...cached, name });
          continue;
        }
      }

      const runtime = getRuntime(runtimeType, { port, gatewayUrl });
      const check = await runtime.healthCheck(name);

      // Cache openclaw gateway results for dedup
      if (runtimeType === 'openclaw' && gatewayUrl) {
        gatewayHealthCache.set(gatewayUrl, check);
      }

      results.push(check);
    } catch (err) {
      results.push({
        name,
        status: 'unknown',
        containerStatus: 'error',
        restartNeeded: false,
        lastCheck: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

// ── Restart Logic ────────────────────────────────────────────────────

export async function restartUnhealthy(
  watchdogConfig: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG,
): Promise<Array<{ name: string; restarted: boolean; error?: string }>> {
  const config = loadConfig();
  const results: Array<{ name: string; restarted: boolean; error?: string }> = [];
  const healthChecks = await checkHealth();
  const now = Date.now();

  // Separate openclaw agents from others for gateway-aware restart logic
  const unhealthy = healthChecks.filter((c) => c.restartNeeded);
  const gatewayAgents = new Map<string, string[]>(); // gatewayUrl → agent names
  const nonGatewayUnhealthy: typeof unhealthy = [];

  for (const check of unhealthy) {
    const agentConfig = config.agents?.[check.name];
    const runtimeType = agentConfig?.runtime || 'docker';
    const gw = runtimeType === 'openclaw' ? agentConfig?.openclaw?.gatewayUrl : undefined;
    if (gw) {
      const list = gatewayAgents.get(gw) || [];
      list.push(check.name);
      gatewayAgents.set(gw, list);
    } else {
      nonGatewayUnhealthy.push(check);
    }
  }

  // Gateway-level restarts: one restart per gateway, cooldown = cooldownMs * 3
  const gatewayCooldown = watchdogConfig.cooldownMs * 3;

  for (const [gatewayUrl, agentNames] of gatewayAgents) {
    const gwKey = `gateway:${gatewayUrl}`;

    // Prevent concurrent restart of the same gateway
    if (restartInFlight.has(gwKey)) {
      for (const name of agentNames) {
        results.push({ name, restarted: false, error: 'Gateway restart already in progress' });
      }
      continue;
    }

    const tracker = restartCounts.get(gwKey) || { count: 0, lastRestart: 0 };

    if (now - tracker.lastRestart < gatewayCooldown) {
      for (const name of agentNames) {
        results.push({ name, restarted: false, error: 'Gateway in cooldown period' });
      }
      continue;
    }

    if (tracker.count >= watchdogConfig.maxRestarts) {
      for (const name of agentNames) {
        results.push({ name, restarted: false, error: `Gateway max restarts (${watchdogConfig.maxRestarts}) exceeded` });
      }
      continue;
    }

    restartInFlight.add(gwKey);
    try {
      const runtime = getRuntime('openclaw', { gatewayUrl });
      await runtime.start(agentNames[0]!); // one restart for the gateway
      restartCounts.set(gwKey, { count: tracker.count + 1, lastRestart: now });
      logger.info({ gatewayUrl, agents: agentNames, attempt: tracker.count + 1 }, 'Gateway restarted');
      for (const name of agentNames) {
        results.push({ name, restarted: true });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ gatewayUrl, err }, 'Failed to restart gateway');
      for (const name of agentNames) {
        results.push({ name, restarted: false, error: message });
      }
    } finally {
      restartInFlight.delete(gwKey);
    }
  }

  // Non-gateway (docker/native) agents — per-agent restart
  for (const check of nonGatewayUnhealthy) {
    // Prevent concurrent restart of the same agent
    if (restartInFlight.has(check.name)) {
      results.push({ name: check.name, restarted: false, error: 'Restart already in progress' });
      continue;
    }

    const tracker = restartCounts.get(check.name) || { count: 0, lastRestart: 0 };

    if (now - tracker.lastRestart < watchdogConfig.cooldownMs) {
      results.push({ name: check.name, restarted: false, error: 'In cooldown period' });
      continue;
    }

    if (tracker.count >= watchdogConfig.maxRestarts) {
      results.push({ name: check.name, restarted: false, error: `Max restarts (${watchdogConfig.maxRestarts}) exceeded` });
      continue;
    }

    restartInFlight.add(check.name);
    try {
      const agentConfig = config.agents?.[check.name];
      const runtimeType = agentConfig?.runtime || 'docker';
      const runtime = getRuntime(runtimeType, {
        port: agentConfig?.ports?.gateway,
        gatewayUrl: agentConfig?.openclaw?.gatewayUrl,
      });
      await runtime.start(check.name);
      restartCounts.set(check.name, { count: tracker.count + 1, lastRestart: now });
      logger.info({ name: check.name, attempt: tracker.count + 1 }, 'Agent restarted');
      results.push({ name: check.name, restarted: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ name: check.name, err }, 'Failed to restart agent');
      results.push({ name: check.name, restarted: false, error: message });
    } finally {
      restartInFlight.delete(check.name);
    }
  }

  return results;
}

// ── Reset ────────────────────────────────────────────────────────────

export function resetRestartCounts(name?: string): void {
  if (name) {
    restartCounts.delete(name);
    restartInFlight.delete(name);
  } else {
    restartCounts.clear();
    restartInFlight.clear();
  }
}

// ── Daemon Loop ──────────────────────────────────────────────────────

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

export interface WatchdogDaemon {
  running: boolean;
  stop: () => void;
}

/**
 * Start the watchdog daemon loop.
 * Runs checkHealth + restartUnhealthy on a configurable interval.
 */
export function startWatchdogDaemon(
  config: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG,
  onCycle?: (results: HealthCheckResult[]) => void,
): WatchdogDaemon {
  if (watchdogTimer) {
    logger.warn('Watchdog daemon already running');
    return { running: true, stop: () => stopWatchdogDaemon() };
  }

  logger.info({ interval: config.interval }, 'Starting watchdog daemon');

  const runCycle = async () => {
    try {
      const health = await checkHealth();
      const unhealthy = health.filter((h) => h.restartNeeded);

      if (unhealthy.length > 0) {
        logger.warn({ unhealthy: unhealthy.length }, 'Unhealthy agents detected');
        await restartUnhealthy(config);
      }

      onCycle?.(health);
    } catch (err) {
      logger.error({ err }, 'Watchdog cycle error');
    }
  };

  // Run immediately, then on interval
  runCycle();
  watchdogTimer = setInterval(runCycle, config.interval * 1000);

  return {
    running: true,
    stop: () => stopWatchdogDaemon(),
  };
}

/**
 * Stop the watchdog daemon loop.
 */
export function stopWatchdogDaemon(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    logger.info('Watchdog daemon stopped');
  }
}

export { DEFAULT_WATCHDOG_CONFIG };
