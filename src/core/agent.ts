/**
 * Core agent module — agent CRUD and lifecycle operations.
 * CLI files should be thin wrappers that call these functions.
 */
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  createContainer,
  startContainer,
  stopContainer,
  removeContainer,
  getContainer,
  listBscsContainers,
  pullImage,
} from './docker.js';
import { loadConfig, saveConfig, type BscsConfig } from './config.js';
import { UserError } from '../util/errors.js';
import type { AgentRole } from '../util/types.js';

// ── Port Allocation ──────────────────────────────────────────────────

export async function allocatePorts(config: BscsConfig): Promise<{ gateway?: number; remote?: number }> {
  const start = config.defaults?.portRange?.start || 19000;
  const end = config.defaults?.portRange?.end || 19999;
  const usedPorts = new Set<number>();

  if (config.agents) {
    for (const agent of Object.values(config.agents)) {
      if (agent.ports) {
        if (agent.ports.gateway) usedPorts.add(agent.ports.gateway);
        if (agent.ports.remote) usedPorts.add(agent.ports.remote);
      }
    }
  }

  try {
    const containers = await listBscsContainers();
    for (const c of containers) {
      if (c.ports?.gateway) usedPorts.add(c.ports.gateway);
      if (c.ports?.remote) usedPorts.add(c.ports.remote);
    }
  } catch {
    // Docker not available
  }

  for (let port = start; port <= end - 1; port += 2) {
    if (!usedPorts.has(port) && !usedPorts.has(port + 1)) {
      return { gateway: port, remote: port + 1 };
    }
  }

  throw new UserError(
    `No available ports in range ${start}-${end}`,
    'Consider:\n  • Remove stopped agents: bscs agent destroy <name>\n  • Expand the port range in ~/.config/bscs/config.json',
  );
}

// ── Resource / Model Helpers ─────────────────────────────────────────

export function getResourcesForRole(
  role: AgentRole,
  config: BscsConfig,
): { memory: string; pidsLimit: number } {
  const resourceKey: 'coding' | 'review' | 'brain' | 'ops' | 'default' =
    (['coding', 'review', 'brain', 'ops'] as const).includes(
      role as 'coding' | 'review' | 'brain' | 'ops',
    )
      ? (role as 'coding' | 'review' | 'brain' | 'ops')
      : 'default';
  const resources =
    config.docker?.resources?.[resourceKey] || config.docker?.resources?.default;
  return {
    memory: resources?.memory || '2g',
    pidsLimit: resources?.pidsLimit || 256,
  };
}

export function getModelForRole(role: AgentRole, config: BscsConfig): string {
  return config.models?.defaults?.[role] || 'claude-sonnet-4';
}

// ── Tribunal Setup ───────────────────────────────────────────────────

export interface TribunalSetupResult {
  installed: boolean;
  path?: string;
  error?: string;
}

export async function setupTribunal(
  agentName: string,
  agentPath: string,
): Promise<TribunalSetupResult> {
  try {
    let pipCmd = 'pip';
    try {
      execFileSync('which', ['pipx'], { stdio: 'ignore' });
      pipCmd = 'pipx';
    } catch {
      try {
        execFileSync('which', ['pip3'], { stdio: 'ignore' });
        pipCmd = 'pip3';
      } catch {
        // Fall back to pip
      }
    }

    execFileSync(pipCmd, ['install', 'tribunal'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 });

    const tribunalDir = join(agentPath, '.tribunal');
    if (!existsSync(tribunalDir)) {
      mkdirSync(tribunalDir, { recursive: true });
    }

    const tribunalConfig = {
      version: '1.0',
      agent: { name: agentName, type: 'coding' },
      hooks: {
        preToolUse: ['tribunal check'],
        postToolUse: ['tribunal log'],
      },
      rules: {
        preventFileDeletion: true,
        preventCommandExecution: ['rm -rf', 'sudo'],
        requireApprovalFor: ['npm publish', 'git push'],
      },
    };
    writeFileSync(
      join(tribunalDir, 'config.json'),
      JSON.stringify(tribunalConfig, null, 2),
    );

    const claudeDir = join(agentPath, '.claude');
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }
    const claudeSettings = {
      permissions: {
        allow: ['Read', 'Edit', 'Write', 'Bash(npm *)', 'Bash(git *)'],
        deny: ['Bash(rm -rf /*)', 'Bash(sudo *)'],
      },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'tribunal check --hook bash' }],
          },
        ],
      },
    };
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify(claudeSettings, null, 2),
    );

    return { installed: true, path: tribunalDir };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { installed: false, error: message };
  }
}

// ── Agent CRUD ───────────────────────────────────────────────────────

export interface CreateAgentOptions {
  name: string;
  role: AgentRole;
  image?: string;
  model?: string;
  noStart?: boolean;
  dryRun?: boolean;
}

export interface CreateAgentResult {
  name: string;
  id?: string;
  image: string;
  role: AgentRole;
  model: string;
  ports: { gateway?: number; remote?: number };
  status: string;
  tribunal: boolean;
  dryRun: boolean;
  resources: { memory: string; pidsLimit: number };
}

export async function createAgent(options: CreateAgentOptions): Promise<CreateAgentResult> {
  const { name, role, noStart, dryRun } = options;
  const config = loadConfig();
  const image = options.image || config.defaults?.image || 'openclaw-fleet:latest';
  const agentModel = options.model || getModelForRole(role, config);
  const resources = getResourcesForRole(role, config);

  if (config.agents?.[name]) {
    throw new Error(`Agent "${name}" already exists`);
  }

  const existing = await getContainer(name);
  if (existing) {
    throw new Error(`Container "openclaw_${name}" already exists`);
  }

  const ports = await allocatePorts(config);

  if (dryRun) {
    return {
      name,
      image,
      role,
      model: agentModel,
      ports,
      status: 'dry-run',
      tribunal: role === 'coding',
      dryRun: true,
      resources,
    };
  }

  await pullImage(image);
  const containerInfo = await createContainer({ name, image, ports });

  let tribunalResult: TribunalSetupResult | null = null;
  if (role === 'coding') {
    const agentPath = join(homedir(), '.config', 'bscs', 'agents', name);
    tribunalResult = await setupTribunal(name, agentPath);
  }

  config.agents = config.agents || {};
  config.agents[name] = {
    name,
    role,
    template: role === 'coding' ? 'coding' : 'custom',
    machine: 'localhost',
    image,
    model: agentModel,
    ports,
    runtime: 'docker' as const,
    created: new Date().toISOString(),
    status: 'created',
  };
  saveConfig(config);

  if (!noStart) {
    await startContainer(name);
    config.agents[name]!.status = 'running';
    saveConfig(config);
  }

  return {
    name,
    id: containerInfo.id,
    image,
    role,
    model: agentModel,
    ports,
    status: noStart ? 'created' : 'running',
    tribunal: tribunalResult?.installed || false,
    dryRun: false,
    resources,
  };
}

export async function destroyAgent(
  name: string,
  options: { force?: boolean; volumes?: boolean } = {},
): Promise<{ name: string; destroyed: boolean }> {
  const config = loadConfig();

  if (!config.agents?.[name]) {
    throw new Error(`Agent "${name}" not found in config`);
  }

  await stopContainer(name);
  await removeContainer(name, options.volumes);

  delete config.agents![name];
  saveConfig(config);

  return { name, destroyed: true };
}

// ── Agent Lifecycle ──────────────────────────────────────────────────

export async function startAgent(name: string): Promise<{ name: string; status: string }> {
  const config = loadConfig();
  if (!config.agents?.[name]) {
    throw new Error(`Agent "${name}" not found in config`);
  }

  await startContainer(name);

  config.agents[name]!.status = 'running';
  saveConfig(config);

  return { name, status: 'running' };
}

export async function stopAgent(name: string): Promise<{ name: string; status: string }> {
  const config = loadConfig();
  if (!config.agents?.[name]) {
    throw new Error(`Agent "${name}" not found in config`);
  }

  await stopContainer(name);

  config.agents[name]!.status = 'stopped';
  saveConfig(config);

  return { name, status: 'stopped' };
}

export async function restartAgent(name: string): Promise<{ name: string; status: string }> {
  await stopAgent(name);
  return startAgent(name);
}

export function logsAgent(
  name: string,
  options: { follow?: boolean; tail?: number } = {},
): ChildProcess {
  const config = loadConfig();
  if (!config.agents?.[name]) {
    throw new Error(`Agent "${name}" not found in config`);
  }

  const args = ['logs'];
  if (options.follow) args.push('-f');
  if (options.tail !== undefined) args.push('--tail', String(options.tail));
  args.push(`openclaw_${name}`);

  return spawn('docker', args, { stdio: 'inherit' });
}

export function shellAgent(name: string): ChildProcess {
  const config = loadConfig();
  if (!config.agents?.[name]) {
    throw new Error(`Agent "${name}" not found in config`);
  }

  return spawn('docker', ['exec', '-it', `openclaw_${name}`, '/bin/sh'], {
    stdio: 'inherit',
  });
}

// ── Agent Status ─────────────────────────────────────────────────────

export interface AgentStatusResult {
  name: string;
  image: string;
  status: string;
  role: string;
  model?: string;
  ports?: { gateway?: number; remote?: number };
  created?: string;
  containerId?: string;
}

export async function getAgentStatus(name: string): Promise<AgentStatusResult> {
  const config = loadConfig();
  const agentConfig = config.agents?.[name];
  if (!agentConfig) {
    throw new Error(`Agent "${name}" not found`);
  }

  const container = await getContainer(name);

  return {
    name,
    image: container?.image || agentConfig.image || 'unknown',
    status: container?.status || 'unknown',
    role: agentConfig.role,
    model: agentConfig.model,
    ports: (container?.ports as { gateway?: number; remote?: number } | undefined) || agentConfig.ports,
    created: agentConfig.created,
    containerId: container?.id,
  };
}

export async function getAllAgentStatuses(): Promise<AgentStatusResult[]> {
  const config = loadConfig();
  const containers = await listBscsContainers();
  const containerMap = new Map(
    containers.map((c) => [c.name.replace('openclaw_', ''), c]),
  );

  const agents = Object.keys(config.agents || {});
  return agents.map((agentName) => {
    const agentConfig = config.agents![agentName]!;
    const container = containerMap.get(agentName);

    return {
      name: agentName,
      image: container?.image || agentConfig.image || 'unknown',
      status: container?.status || 'unknown',
      role: agentConfig.role,
      model: agentConfig.model,
      ports: (container?.ports as { gateway?: number; remote?: number } | undefined) || agentConfig.ports,
      created: agentConfig.created,
    };
  });
}
