/**
 * Core fleet module — fleet init, status, reconcile, import.
 * Extracted from CLI files for independent testability.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';
import { loadConfig } from './config.js';
import {
  listBscsContainers,
  pullImage,
  createContainer,
  startContainer,
  stopContainer,
  removeContainer,
  type ContainerInfo,
} from './docker.js';
import { createLogger } from '../util/logger.js';

const logger = createLogger('fleet');

// ── Types ────────────────────────────────────────────────────────────

export interface FleetAgentStatus {
  name: string;
  machine: string;
  status: string;
  containerId?: string;
  image?: string;
  ports?: { gateway?: number; remote?: number };
  created?: string;
}

export interface FleetStatusResult {
  fleetName: string;
  controller: string;
  machines: Record<string, { host: string; agentCount: number; status: string }>;
  agents: FleetAgentStatus[];
  summary: { total: number; running: number; stopped: number; unknown: number };
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

// ── Fleet Status ─────────────────────────────────────────────────────

export async function getFleetStatus(includeAll = true): Promise<FleetStatusResult> {
  const config = loadConfig();

  let containers: ContainerInfo[] = [];
  try {
    containers = await listBscsContainers();
  } catch (err) {
    logger.warn({ err }, 'Could not list Docker containers');
  }

  const containerMap = new Map(
    containers.map((c) => [c.name.replace('openclaw_', ''), c]),
  );
  const agents: FleetAgentStatus[] = [];

  if (config.agents) {
    for (const name of Object.keys(config.agents)) {
      const agentConfig = config.agents[name];
      if (!agentConfig) continue;

      const container = containerMap.get(name);
      if (container) {
        agents.push({
          name,
          machine: 'localhost',
          status: container.status,
          containerId: container.id,
          image: container.image,
          ports: container.ports || agentConfig.ports,
          created: agentConfig.created,
        });
        containerMap.delete(name);
      } else {
        agents.push({
          name,
          machine: 'localhost',
          status: 'missing',
          image: agentConfig.image,
          ports: agentConfig.ports,
          created: agentConfig.created,
        });
      }
    }
  }

  if (includeAll) {
    for (const [name, container] of containerMap) {
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
    stopped: agents.filter((a) => a.status === 'stopped').length,
    unknown: agents.filter(
      (a) => a.status !== 'running' && a.status !== 'stopped',
    ).length,
  };

  return {
    fleetName: config.fleet?.name || 'unnamed-fleet',
    controller: config.fleet?.controller || 'localhost',
    machines: {
      localhost: {
        host: 'localhost',
        agentCount: agents.length,
        status: 'online',
      },
    },
    agents,
    summary,
  };
}

// ── Fleet Reconcile ──────────────────────────────────────────────────

export async function computeReconcileChanges(): Promise<ReconcileChange[]> {
  const config = loadConfig();
  const changes: ReconcileChange[] = [];

  let containers: ContainerInfo[] = [];
  try {
    containers = await listBscsContainers();
  } catch {
    throw new Error('Could not list containers');
  }

  const containerMap = new Map(
    containers.map((c) => [c.name.replace('openclaw_', ''), c]),
  );

  if (config.agents) {
    for (const name of Object.keys(config.agents)) {
      const container = containerMap.get(name);
      if (!container) {
        changes.push({ action: 'create', agent: name, reason: 'Missing container' });
      } else if (container.status === 'stopped') {
        changes.push({ action: 'start', agent: name, reason: 'Container stopped' });
      } else if (container.status === 'created') {
        changes.push({ action: 'start', agent: name, reason: 'Not started' });
      }
      containerMap.delete(name);
    }
  }

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
    const image =
      agentConfig?.image || config.defaults?.image || 'openclaw-fleet:latest';
    const ports = agentConfig?.ports || { gateway: 19000, remote: 19001 };

    if (change.action === 'create') {
      await pullImage(image);
      await createContainer({ name: change.agent, image, ports });
      await startContainer(change.agent);
    } else if (change.action === 'start') {
      await startContainer(change.agent);
    } else if (change.action === 'stop') {
      await stopContainer(change.agent);
    } else if (change.action === 'remove') {
      await removeContainer(change.agent);
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
