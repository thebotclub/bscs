/**
 * Core fleet module — fleet init, status, reconcile, import.
 * Extracted from CLI files for independent testability.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { execFileSync } from 'child_process';
import { isLocalMachine } from '../util/network.js';
import { homedir, userInfo } from 'os';
import { loadConfig, saveConfig } from './config.js';
import { sshExec } from '../util/ssh.js';
import type { AgentConfig } from '../util/types.js';
import {
  listBscsContainers,
  type ContainerInfo,
} from './docker.js';
import { getRuntime } from './runtime/index.js';
import { createLogger } from '../util/logger.js';

const logger = createLogger('fleet');

// ── Types ────────────────────────────────────────────────────────────

export interface FleetAgentStatus {
  name: string;
  machine: string;
  status: string;
  containerId?: string;
  image?: string;
  role?: string;
  runtime?: string;
  ports?: { gateway?: number; remote?: number };
  created?: string;
  channels?: Array<{ type: string; accountId: string }>;
  cronCount?: number;
  skillsCount?: number;
  model?: string;
  modelFallbacks?: string[];
}

export interface FleetStatusResult {
  fleetName: string;
  controller: string;
  machines: Record<string, { host: string; agentCount: number; status: string; role?: string }>;
  agents: FleetAgentStatus[];
  summary: { total: number; running: number; stopped: number; unknown: number };
}

// ── SSH helpers ───────────────────────────────────────────────────────

interface RemoteContainerInfo {
  name: string;
  status: string;
  image: string;
}

async function getRemoteDockerContainers(
  host: string,
  user: string,
  sshAlias?: string,
): Promise<RemoteContainerInfo[]> {
  try {
    const result = sshExec(
      { host, user, sshAlias },
      'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; docker ps -a --format "{{.Names}}|{{.Status}}|{{.Image}}" 2>/dev/null',
      { timeoutMs: 10000 },
    );
    return result
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, rawStatus, image] = line.split('|');
        const status = rawStatus?.toLowerCase().startsWith('up')
          ? 'running'
          : rawStatus?.toLowerCase().startsWith('exited')
            ? 'stopped'
            : rawStatus?.toLowerCase().startsWith('created')
              ? 'created'
              : 'unknown';
        return { name: name || '', status, image: image || '' };
      });
  } catch (err) {
    logger.debug({ host, err: (err as Error).message }, 'Failed to get remote containers');
    return [];
  }
}

async function checkRemoteNativeAgent(
  host: string,
  user: string,
  port: number,
  sshAlias?: string,
): Promise<boolean> {
  try {
    const result = sshExec(
      { host, user, sshAlias },
      `curl -s --max-time 3 http://127.0.0.1:${port}/healthz 2>/dev/null`,
      { timeoutMs: 10000 },
    );
    return result.includes('"ok"') || result.includes('"live"');
  } catch {
    return false;
  }
}

export interface ReconcileChange {
  action: string;
  agent: string;
  reason: string;
}

export interface InitAnswers {
  fleetName: string;
  controller: string;
  image: string;
  portRangeStart: number;
  portRangeEnd: number;
}

// ── Fleet Status (SSH-aware) ──────────────────────────────────────────

export async function getFleetStatus(includeAll = true): Promise<FleetStatusResult> {
  const config = loadConfig();

  // Get local Docker containers
  let localContainers: ContainerInfo[] = [];
  try {
    localContainers = await listBscsContainers();
  } catch (err) {
    logger.warn({ err }, 'Could not list local Docker containers');
  }
  const localContainerMap = new Map(localContainers.map((c) => [c.name.replace('openclaw_', ''), c]));

  // Group agents by machine
  const machineAgents = new Map<string, Array<{ name: string; agentConfig: AgentConfig }>>();
  if (config.agents) {
    for (const [name, agentConfig] of Object.entries(config.agents)) {
      if (!agentConfig) continue;
      const machine = agentConfig.machine || 'localhost';
      if (!machineAgents.has(machine)) machineAgents.set(machine, []);
      machineAgents.get(machine)!.push({ name, agentConfig });
    }
  }

  // Fetch remote container status (parallel SSH)
  const remoteContainerCache = new Map<string, RemoteContainerInfo[]>();
  const machineStatus = new Map<string, string>();

  const remoteMachines = [...machineAgents.keys()].filter((m) => !isLocalMachine(m));
  await Promise.all(
    remoteMachines.map(async (machineHost) => {
      const machineConfig = config.machines?.[machineHost];
      const user = machineConfig?.user || userInfo().username;
      const sshAlias = machineConfig?.sshAlias;
      try {
        const containers = await getRemoteDockerContainers(machineHost, user, sshAlias);
        remoteContainerCache.set(machineHost, containers);
        machineStatus.set(machineHost, 'online');
      } catch {
        machineStatus.set(machineHost, 'offline');
      }
    }),
  );

  const agents: FleetAgentStatus[] = [];

  // Process all configured agents
  if (config.agents) {
    for (const [name, agentConfig] of Object.entries(config.agents)) {
      if (!agentConfig) continue;
      const machine = agentConfig.machine || 'localhost';
      const isLocal = isLocalMachine(machine);
      const runtime = agentConfig.runtime || 'docker';
      const containerName = agentConfig.container || `openclaw_${name}`;

      let status = 'unknown';
      let containerId: string | undefined;
      let image: string | undefined;
      let ports: { gateway?: number; remote?: number } | undefined;

      if (runtime === 'docker') {
        if (isLocal) {
          const container =
            localContainerMap.get(name) || localContainers.find((c) => c.name === containerName);
          if (container) {
            status = container.status;
            containerId = container.id;
            image = container.image;
            ports = container.ports || { gateway: agentConfig.ports?.gateway, remote: agentConfig.ports?.remote };
            localContainerMap.delete(name);
          } else {
            status = 'missing';
          }
        } else {
          const remoteContainers = remoteContainerCache.get(machine) || [];
          const match = remoteContainers.find(
            (c) => c.name === containerName || c.name === `openclaw_${name}` || c.name === name,
          );
          if (match) {
            status = match.status;
            image = match.image;
          } else if (machineStatus.get(machine) === 'online') {
            status = 'missing';
          } else {
            status = 'unreachable';
          }
          ports = { gateway: agentConfig.ports?.gateway, remote: agentConfig.ports?.remote };
        }
      } else if (runtime === 'native') {
        const gwPort = agentConfig.ports?.gateway || 18789;
        if (isLocal) {
          try {
            const res = execFileSync('curl', ['-s', '--max-time', '2', `http://127.0.0.1:${gwPort}/healthz`], {
              encoding: 'utf8',
              timeout: 5000,
            });
            status = res.includes('"ok"') || res.includes('"live"') ? 'running' : 'stopped';
          } catch {
            status = 'stopped';
          }
        } else {
          const nativeMachineConfig = config.machines?.[machine];
          const nativeUser = nativeMachineConfig?.user || userInfo().username;
          const nativeSshAlias = nativeMachineConfig?.sshAlias;
          const healthy = await checkRemoteNativeAgent(machine, nativeUser, gwPort, nativeSshAlias);
          if (healthy) {
            status = 'running';
          } else if (machineStatus.get(machine) === 'online') {
            status = 'stopped';
          } else {
            status = 'unreachable';
          }
        }
        ports = { gateway: agentConfig.ports?.gateway };
      } else if (runtime === 'openclaw') {
        // OpenClaw agents — check gateway health
        const gatewayUrl = agentConfig.openclaw?.gatewayUrl || `http://127.0.0.1:${agentConfig.ports?.gateway || 18777}`;
        try {
          const res = execFileSync('curl', ['-s', '--max-time', '3', `${gatewayUrl}/healthz`], {
            encoding: 'utf8',
            timeout: 5000,
          });
          status = (res.includes('"ok"') || res.includes('"live"') || res.includes('<!doctype') || res.includes('openclaw-app'))
            ? 'running'
            : 'stopped';
        } catch {
          status = 'stopped';
        }
        ports = { gateway: agentConfig.ports?.gateway };
      }

      agents.push({
        name,
        machine,
        status,
        containerId,
        image: image || agentConfig.image,
        role: agentConfig.role,
        runtime,
        ports: ports || { gateway: agentConfig.ports?.gateway, remote: agentConfig.ports?.remote },
        created: agentConfig.created,
        channels: agentConfig.openclaw?.channels as Array<{ type: string; accountId: string }> | undefined,
        cronCount: agentConfig.openclaw?.cronJobs?.length,
        skillsCount: agentConfig.openclaw?.skills?.length,
        model: agentConfig.model ?? agentConfig.openclaw?.model?.primary,
        modelFallbacks: agentConfig.openclaw?.model?.fallbacks as string[] | undefined,
      });
    }
  }

  // Add orphaned local containers
  if (includeAll) {
    for (const [name, container] of localContainerMap) {
      agents.push({
        name,
        machine: 'localhost',
        status: `orphaned-${container.status}`,
        containerId: container.id,
        image: container.image,
        ports: container.ports,
      });
    }
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));

  const summary = {
    total: agents.length,
    running: agents.filter((a) => a.status === 'running').length,
    stopped: agents.filter((a) => a.status === 'stopped' || a.status === 'created').length,
    unknown: agents.filter((a) => !['running', 'stopped', 'created'].includes(a.status)).length,
  };

  // Build machines summary
  const machinesResult: Record<string, { host: string; agentCount: number; status: string; role?: string }> = {};
  for (const [host, machineConfig] of Object.entries(config.machines || {})) {
    const agentCount = agents.filter((a) => a.machine === host).length;
    machinesResult[host] = {
      host,
      agentCount,
      status: isLocalMachine(host) ? 'online' : (machineStatus.get(host) || 'unknown'),
      role: machineConfig.role,
    };
  }
  // Add localhost if not already in machines
  const localAgentCount = agents.filter((a) => isLocalMachine(a.machine)).length;
  if (localAgentCount > 0 && !Object.values(machinesResult).some((m) => isLocalMachine(m.host))) {
    machinesResult['localhost'] = { host: 'localhost', agentCount: localAgentCount, status: 'online' };
  }

  return {
    fleetName: config.fleet?.name || 'unnamed-fleet',
    controller: config.fleet?.controller || 'localhost',
    machines: machinesResult,
    agents,
    summary,
  };
}

// ── Fleet Reconcile ──────────────────────────────────────────────────

export async function computeReconcileChanges(): Promise<ReconcileChange[]> {
  const config = loadConfig();
  const changes: ReconcileChange[] = [];

  // Docker agents — batch container comparison
  const dockerRuntime = getRuntime('docker');
  let containerStatuses: Array<{ name: string; status: string }> = [];
  try {
    containerStatuses = await dockerRuntime.list();
  } catch {
    throw new Error('Could not list containers');
  }

  const containerMap = new Map(
    containerStatuses.map((c) => [c.name, c]),
  );

  if (config.agents) {
    for (const [name, agentConfig] of Object.entries(config.agents)) {
      const runtime = agentConfig.runtime || 'docker';

      if (runtime === 'docker') {
        const container = containerMap.get(name);
        if (!container) {
          changes.push({ action: 'create', agent: name, reason: 'Missing container' });
        } else if (container.status === 'stopped') {
          changes.push({ action: 'start', agent: name, reason: 'Container stopped' });
        } else if (container.status === 'created') {
          changes.push({ action: 'start', agent: name, reason: 'Not started' });
        }
        containerMap.delete(name);
      } else if (runtime === 'native') {
        // Native agents — probe health
        try {
          const nativeRuntime = getRuntime('native', { port: agentConfig.ports?.gateway });
          const status = await nativeRuntime.status(name);
          if (agentConfig.status === 'running' && status.status !== 'running') {
            changes.push({ action: 'start', agent: name, reason: 'Native agent not responding' });
          }
        } catch {
          changes.push({ action: 'start', agent: name, reason: 'Health probe failed' });
        }
      } else if (runtime === 'openclaw') {
        // OpenClaw agents — check gateway reachability
        try {
          const ocRuntime = getRuntime('openclaw', {
            port: agentConfig.ports?.gateway,
            gatewayUrl: agentConfig.openclaw?.gatewayUrl,
          });
          const status = await ocRuntime.status(name);
          if (agentConfig.status === 'running' && status.status !== 'running') {
            changes.push({ action: 'start', agent: name, reason: 'OpenClaw agent not responding' });
          }
        } catch {
          changes.push({ action: 'start', agent: name, reason: 'Gateway probe failed' });
        }
      }
    }
  }

  // Orphaned Docker containers
  for (const [name, container] of containerMap) {
    changes.push({
      action: container.status === 'running' ? 'stop' : 'remove',
      agent: name,
      reason: 'Orphaned',
    });
  }

  return changes;
}

export async function applyReconcileChange(
  change: ReconcileChange,
): Promise<{ success: boolean; error?: string }> {
  const config = loadConfig();
  try {
    const agentConfig = config.agents?.[change.agent];
    const runtimeType = agentConfig?.runtime || 'docker';
    const runtime = getRuntime(runtimeType, {
      port: agentConfig?.ports?.gateway,
      gatewayUrl: agentConfig?.openclaw?.gatewayUrl,
    });
    const image =
      agentConfig?.image || config.defaults?.image || 'openclaw-fleet:latest';
    const ports = agentConfig?.ports || { gateway: 19000, remote: 19001 };

    if (change.action === 'create') {
      await runtime.create(change.agent, { image, ports });
      await runtime.start(change.agent);
    } else if (change.action === 'start') {
      await runtime.start(change.agent);
    } else if (change.action === 'stop') {
      await runtime.stop(change.agent);
    } else if (change.action === 'remove') {
      await runtime.destroy(change.agent);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ── Fleet Init ───────────────────────────────────────────────────────

function getConfigPath(): string {
  return process.env.BSCS_CONFIG_DIR
    ? `${process.env.BSCS_CONFIG_DIR}/config.json`
    : `${homedir()}/.config/bscs/config.json`;
}

export function initFleet(answers: InitAnswers): { configPath: string } {
  const configPath = getConfigPath();

  if (existsSync(configPath)) {
    throw new Error(`Configuration already exists at: ${configPath}`);
  }

  const config = {
    version: '1.0',
    fleet: {
      name: answers.fleetName,
      controller: answers.controller,
    },
    machines: {
      localhost: {
        host: 'localhost',
        user: process.env.USER || 'user',
        role: 'controller',
      },
    },
    docker: { image: answers.image },
    defaults: {
      image: answers.image,
      portRange: {
        start: answers.portRangeStart,
        end: answers.portRangeEnd,
      },
    },
    agents: {},
  };

  const configDir = dirname(configPath);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  logger.info({ configPath, fleetName: answers.fleetName }, 'Fleet initialized');
  return { configPath };
}

// ── Fleet Import ─────────────────────────────────────────────────────

export interface ImportResult {
  configPath: string;
  fleetName: string;
  image: string;
  agents: Record<string, { name: string; ports?: { gateway?: number; remote?: number } }>;
}

export function importFleetSh(fleetShPath: string): ImportResult {
  if (!existsSync(fleetShPath)) {
    throw new Error(`Fleet.sh config not found at ${fleetShPath}`);
  }

  const configFiles = [
    `${fleetShPath}/config`,
    `${fleetShPath}/config.sh`,
    `${fleetShPath}/.fleetrc`,
  ];

  let foundConfig = '';
  for (const f of configFiles) {
    if (existsSync(f)) {
      foundConfig = f;
      break;
    }
  }

  if (!foundConfig) {
    throw new Error('Could not find fleet.sh config file');
  }

  const configContent = readFileSync(foundConfig, 'utf-8');
  const agents: Record<
    string,
    { name: string; ports?: { gateway?: number; remote?: number } }
  > = {};

  const agentsMatch = configContent.match(/AGENTS=\(([^)]+)\)/);
  if (agentsMatch) {
    const agentNames = agentsMatch[1]!.match(/"([^"]+)"/g);
    if (agentNames) {
      for (let i = 0; i < agentNames.length; i++) {
        const name = agentNames[i]!.replace(/"/g, '');
        const basePort = 19000 + i * 2;
        agents[name] = {
          name,
          ports: { gateway: basePort, remote: basePort + 1 },
        };
      }
    }
  }

  const imageMatch = configContent.match(/IMAGE=["']?([^"'\n]+)["']?/);
  const image = imageMatch ? imageMatch[1]!.trim() : 'openclaw-fleet:latest';

  const fleetNameMatch = configContent.match(/FLEET_NAME=["']?([^"'\n]+)["']?/);
  const fleetName = fleetNameMatch
    ? fleetNameMatch[1]!.trim()
    : 'imported-fleet';

  const configPath = getConfigPath();
  const configDir = dirname(configPath);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const config = {
    version: '1.0',
    fleet: { name: fleetName, controller: 'localhost' },
    machines: {
      localhost: {
        host: 'localhost',
        user: process.env.USER || 'user',
        role: 'controller',
      },
    },
    docker: { image },
    defaults: { image, portRange: { start: 19000, end: 19999 } },
    agents,
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2));

  logger.info(
    { configPath, agentCount: Object.keys(agents).length },
    'Fleet imported',
  );
  return { configPath, fleetName, image, agents };
}

// =============================================================================
// Import from OpenClaw Gateway
// =============================================================================

export interface OpenClawImportResult {
  imported: string[];
  skipped: string[];
  errors: string[];
}

let _execCommand: typeof execFileSync = execFileSync;

/** Override exec for testing. */
export function setExecCommandForFleet(fn: typeof execFileSync): void {
  _execCommand = fn;
}

/**
 * Import agents from an OpenClaw gateway into BSCS config.
 * Queries `openclaw agents list --json` and populates config entries.
 */
export function importFromOpenClaw(
  gatewayUrl: string,
  options: { apply?: boolean } = {},
): OpenClawImportResult {
  const config = loadConfig();
  const result: OpenClawImportResult = { imported: [], skipped: [], errors: [] };

  // Query the gateway for agent list
  let agentsJson: string;
  try {
    agentsJson = _execCommand('openclaw', ['agents', 'list', '--json'], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, OPENCLAW_GATEWAY: gatewayUrl },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to query OpenClaw gateway at ${gatewayUrl}: ${msg}`);
  }

  let agents: Array<{
    name: string;
    workspace?: string;
    model?: string;
    channels?: Array<{ type: string; accountId: string }>;
    skills?: string[];
    cronJobs?: Array<{ id: string; cron: string; message: string; channel?: string }>;
  }>;

  try {
    agents = JSON.parse(agentsJson);
    if (!Array.isArray(agents)) {
      throw new Error('Expected an array of agents');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse agent list from OpenClaw gateway: ${msg}`);
  }

  config.agents = config.agents || {};

  for (const agent of agents) {
    if (!agent.name) {
      result.errors.push('Agent entry missing name — skipped');
      continue;
    }

    if (config.agents[agent.name]) {
      result.skipped.push(agent.name);
      continue;
    }

    const agentConfig: AgentConfig = {
      name: agent.name,
      role: 'custom',
      template: 'custom',
      machine: 'localhost',
      image: '',
      runtime: 'openclaw',
      created: new Date().toISOString(),
      status: 'running',
      openclaw: {
        gatewayUrl,
        workspace: agent.workspace || agent.name,
        channels: (agent.channels || []).map((ch) => ({
          type: ch.type as 'telegram' | 'discord',
          accountId: ch.accountId,
        })),
        model: agent.model ? { primary: agent.model } : undefined,
        skills: agent.skills,
        cronJobs: agent.cronJobs,
      },
    };

    if (options.apply) {
      config.agents[agent.name] = agentConfig;
    }

    result.imported.push(agent.name);
  }

  if (options.apply && result.imported.length > 0) {
    saveConfig(config);
    logger.info(
      { imported: result.imported.length, skipped: result.skipped.length },
      'OpenClaw agents imported',
    );
  }

  return result;
}
