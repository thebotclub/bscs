/**
 * Core agent module — agent CRUD and lifecycle operations.
 * CLI files should be thin wrappers that call these functions.
 */
import { execFileSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getRuntime, isOpenClawRuntime } from './runtime/index.js';
import { loadConfig, saveConfig, type BscsConfig } from './config.js';
import { UserError } from '../util/errors.js';
import type { AgentConfig, AgentRole } from '../util/types.js';

// ── Runtime Helper ───────────────────────────────────────────────────

function getRuntimeForAgent(agentConfig: AgentConfig) {
  return getRuntime(agentConfig.runtime || 'docker', {
    port: agentConfig.ports?.gateway,
    gatewayUrl: agentConfig.openclaw?.gatewayUrl,
    containerNames: agentConfig.container
      ? new Map([[agentConfig.name, agentConfig.container]])
      : undefined,
  });
}

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
    const dockerRuntime = getRuntime('docker');
    const containers = await dockerRuntime.list();
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
  runtime?: 'docker' | 'native' | 'openclaw';
  gatewayUrl?: string;
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
  const runtimeType = options.runtime || 'docker';
  const config = loadConfig();
  const image = options.image || config.defaults?.image || 'openclaw-fleet:latest';
  const agentModel = options.model || getModelForRole(role, config);
  const resources = getResourcesForRole(role, config);

  if (config.agents?.[name]) {
    throw new Error(`Agent "${name}" already exists`);
  }

  const runtime = getRuntime(runtimeType, { gatewayUrl: options.gatewayUrl });

  if (runtimeType === 'docker') {
    const runtimeStatus = await runtime.status(name);
    if (runtimeStatus.status !== 'missing') {
      throw new Error(`Container "openclaw_${name}" already exists`);
    }
  }

  const ports = runtimeType === 'docker' ? await allocatePorts(config) : {};

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

  const createResult = await runtime.create(name, { image, ports });

  let tribunalResult: TribunalSetupResult | null = null;
  if (role === 'coding' && runtimeType === 'docker') {
    const agentPath = join(homedir(), '.config', 'bscs', 'agents', name);
    tribunalResult = await setupTribunal(name, agentPath);
  }

  config.agents = config.agents || {};
  config.agents[name] = {
    name,
    role,
    template: role === 'coding' ? 'coding' : 'custom',
    machine: 'localhost',
    image: runtimeType === 'docker' ? image : undefined,
    model: agentModel,
    ports: Object.keys(ports).length > 0 ? ports : undefined,
    runtime: runtimeType,
    created: new Date().toISOString(),
    status: 'created',
    ...(runtimeType === 'openclaw' && options.gatewayUrl
      ? { openclaw: { gatewayUrl: options.gatewayUrl } }
      : {}),
  };
  saveConfig(config);

  if (!noStart) {
    await runtime.start(name);
    config.agents[name]!.status = 'running';
    saveConfig(config);
  }

  return {
    name,
    id: createResult.id,
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

  const agentConfig = config.agents[name]!;
  const runtime = getRuntimeForAgent(agentConfig);

  // For openclaw agents, unbind channels before destroying
  if (agentConfig.runtime === 'openclaw' && isOpenClawRuntime(runtime)) {
    const channels = agentConfig.openclaw?.channels || [];
    for (const ch of channels) {
      try {
        await runtime.unbindChannel(name, ch.type);
      } catch {
        // Best-effort unbind — agent may already be partially removed
      }
    }
  }

  await runtime.destroy(name, { force: options.force, volumes: options.volumes });

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

  const agentConfig = config.agents[name]!;
  const runtime = getRuntimeForAgent(agentConfig);
  await runtime.start(name);

  config.agents[name]!.status = 'running';
  saveConfig(config);

  return { name, status: 'running' };
}

export async function stopAgent(name: string): Promise<{ name: string; status: string }> {
  const config = loadConfig();
  if (!config.agents?.[name]) {
    throw new Error(`Agent "${name}" not found in config`);
  }

  const agentConfig = config.agents[name]!;
  const runtime = getRuntimeForAgent(agentConfig);
  await runtime.stop(name);

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

  const agentConfig = config.agents[name]!;
  const runtime = getRuntimeForAgent(agentConfig);
  return runtime.logs(name, { follow: options.follow, tail: options.tail });
}

export function shellAgent(name: string): ChildProcess {
  const config = loadConfig();
  if (!config.agents?.[name]) {
    throw new Error(`Agent "${name}" not found in config`);
  }

  const agentConfig = config.agents[name]!;
  const runtime = getRuntimeForAgent(agentConfig);
  return runtime.shell(name);
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

  const runtime = getRuntimeForAgent(agentConfig);
  const runtimeStatus = await runtime.status(name);

  return {
    name,
    image: runtimeStatus.image || agentConfig.image || 'unknown',
    status: runtimeStatus.status === 'missing' ? 'unknown' : runtimeStatus.status,
    role: agentConfig.role,
    model: agentConfig.model,
    ports: (runtimeStatus.ports as { gateway?: number; remote?: number } | undefined) || agentConfig.ports,
    created: agentConfig.created,
    containerId: runtimeStatus.containerId,
  };
}

export async function getAllAgentStatuses(): Promise<AgentStatusResult[]> {
  const config = loadConfig();

  // Get Docker container statuses for quick lookup
  const dockerRuntime = getRuntime('docker');
  let dockerStatuses: Array<{ name: string; status: string; containerId?: string; image?: string; ports?: { gateway?: number; remote?: number } }> = [];
  try {
    dockerStatuses = await dockerRuntime.list();
  } catch {
    // Docker not available
  }
  const containerMap = new Map(
    dockerStatuses.map((c) => [c.name, c]),
  );

  const agents = Object.keys(config.agents || {});
  return agents.map((agentName) => {
    const agentConfig = config.agents![agentName]!;
    const runtime = agentConfig.runtime || 'docker';

    if (runtime === 'docker') {
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
    }

    // Non-docker runtimes use config info (live status checked via healthCheck)
    return {
      name: agentName,
      image: agentConfig.image || 'unknown',
      status: agentConfig.status || 'unknown',
      role: agentConfig.role,
      model: agentConfig.model,
      ports: agentConfig.ports,
      created: agentConfig.created,
    };
  });
}

// ── Channel Bind/Unbind ──────────────────────────────────────────────

import type { ChannelType } from '../util/types.js';

export async function bindChannel(
  name: string,
  channelType: ChannelType,
  accountId: string,
): Promise<void> {
  const config = loadConfig();
  const agentConfig = config.agents?.[name];
  if (!agentConfig) {
    throw new UserError(`Agent "${name}" not found`);
  }
  if (agentConfig.runtime !== 'openclaw') {
    throw new UserError(`Agent "${name}" uses runtime "${agentConfig.runtime || 'docker'}" — channel bind is only supported for openclaw agents`);
  }

  const runtime = getRuntimeForAgent(agentConfig);
  if (!isOpenClawRuntime(runtime)) {
    throw new UserError(`Runtime for "${name}" does not support channel binding`);
  }
  await runtime.bindChannel(name, channelType, accountId);

  // Update config
  config.agents![name]!.openclaw = config.agents![name]!.openclaw || {
    gatewayUrl: 'http://127.0.0.1:18777',
  };
  const channels = config.agents![name]!.openclaw!.channels || [];
  if (!channels.some((ch) => ch.type === channelType && ch.accountId === accountId)) {
    channels.push({ type: channelType, accountId });
  }
  config.agents![name]!.openclaw!.channels = channels;
  saveConfig(config);
}

export async function unbindChannel(
  name: string,
  channelType: ChannelType,
): Promise<void> {
  const config = loadConfig();
  const agentConfig = config.agents?.[name];
  if (!agentConfig) {
    throw new UserError(`Agent "${name}" not found`);
  }
  if (agentConfig.runtime !== 'openclaw') {
    throw new UserError(`Agent "${name}" uses runtime "${agentConfig.runtime || 'docker'}" — channel unbind is only supported for openclaw agents`);
  }

  const runtime = getRuntimeForAgent(agentConfig);
  if (!isOpenClawRuntime(runtime)) {
    throw new UserError(`Runtime for "${name}" does not support channel unbinding`);
  }
  await runtime.unbindChannel(name, channelType);

  // Update config
  if (config.agents![name]!.openclaw?.channels) {
    config.agents![name]!.openclaw!.channels = config.agents![name]!.openclaw!.channels!.filter(
      (ch) => ch.type !== channelType,
    );
  }
  saveConfig(config);
}

// ── Cron CRUD ────────────────────────────────────────────────────────

export function addCronJob(name: string, job: { id: string; cron: string; message: string; channel?: string }): void {
  const config = loadConfig();
  const agentConfig = config.agents?.[name];
  if (!agentConfig) throw new UserError(`Agent "${name}" not found`);
  if (agentConfig.runtime !== 'openclaw') {
    throw new UserError(`Cron jobs are only supported for openclaw agents`);
  }

  config.agents![name]!.openclaw = config.agents![name]!.openclaw || { gatewayUrl: '' };
  const cronJobs = config.agents![name]!.openclaw!.cronJobs || [];
  if (cronJobs.some((j) => j.id === job.id)) {
    throw new UserError(`Cron job with id "${job.id}" already exists`);
  }
  cronJobs.push(job);
  config.agents![name]!.openclaw!.cronJobs = cronJobs;
  saveConfig(config);
}

export function removeCronJob(name: string, jobId: string): void {
  const config = loadConfig();
  const agentConfig = config.agents?.[name];
  if (!agentConfig) throw new UserError(`Agent "${name}" not found`);

  const cronJobs = agentConfig.openclaw?.cronJobs || [];
  const idx = cronJobs.findIndex((j) => j.id === jobId);
  if (idx === -1) {
    throw new UserError(`Cron job "${jobId}" not found`);
  }
  cronJobs.splice(idx, 1);
  config.agents![name]!.openclaw!.cronJobs = cronJobs;
  saveConfig(config);
}

export function listCronJobs(name: string): Array<{ id: string; cron: string; message: string; channel?: string }> {
  const config = loadConfig();
  const agentConfig = config.agents?.[name];
  if (!agentConfig) throw new UserError(`Agent "${name}" not found`);
  return (agentConfig.openclaw?.cronJobs) || [];
}

// ── Agent Config Set ─────────────────────────────────────────────────

export async function setAgentConfig(
  name: string,
  path: string,
  value: string,
): Promise<void> {
  const config = loadConfig();
  const agentConfig = config.agents?.[name];
  if (!agentConfig) throw new UserError(`Agent "${name}" not found`);
  if (agentConfig.runtime !== 'openclaw') {
    throw new UserError(`Config set is only supported for openclaw agents`);
  }

  if (!/^[a-z0-9][a-z0-9._-]*$/.test(path)) {
    throw new UserError(`Invalid config path: "${path}". Only lowercase alphanumeric, dots, hyphens, and underscores allowed.`);
  }

  const runtime = getRuntimeForAgent(agentConfig);
  if (!isOpenClawRuntime(runtime)) {
    throw new UserError(`Runtime for "${name}" does not support config set`);
  }
  await runtime.setConfig(path, value);
}

// ── Skills CRUD ──────────────────────────────────────────────────────

export function addSkill(name: string, skill: string): void {
  const config = loadConfig();
  const agentConfig = config.agents?.[name];
  if (!agentConfig) throw new UserError(`Agent "${name}" not found`);
  if (agentConfig.runtime !== 'openclaw') {
    throw new UserError(`Skills are only supported for openclaw agents`);
  }

  config.agents![name]!.openclaw = config.agents![name]!.openclaw || { gatewayUrl: '' };
  const skills = config.agents![name]!.openclaw!.skills || [];
  if (skills.includes(skill)) {
    throw new UserError(`Skill "${skill}" already exists on agent "${name}"`);
  }
  skills.push(skill);
  config.agents![name]!.openclaw!.skills = skills;
  saveConfig(config);
}

export function removeSkill(name: string, skill: string): void {
  const config = loadConfig();
  const agentConfig = config.agents?.[name];
  if (!agentConfig) throw new UserError(`Agent "${name}" not found`);

  const skills = agentConfig.openclaw?.skills || [];
  const idx = skills.indexOf(skill);
  if (idx === -1) {
    throw new UserError(`Skill "${skill}" not found on agent "${name}"`);
  }
  skills.splice(idx, 1);
  config.agents![name]!.openclaw!.skills = skills;
  saveConfig(config);
}

export function listSkills(name: string): string[] {
  const config = loadConfig();
  const agentConfig = config.agents?.[name];
  if (!agentConfig) throw new UserError(`Agent "${name}" not found`);
  return agentConfig.openclaw?.skills || [];
}

// ── Identity ─────────────────────────────────────────────────────────

export function setIdentity(name: string, displayName: string, emoji: string): void {
  const config = loadConfig();
  const agentConfig = config.agents?.[name];
  if (!agentConfig) throw new UserError(`Agent "${name}" not found`);
  if (agentConfig.runtime !== 'openclaw') {
    throw new UserError(`Identity is only supported for openclaw agents`);
  }

  config.agents![name]!.openclaw = config.agents![name]!.openclaw || { gatewayUrl: '' };
  config.agents![name]!.openclaw!.identity = { name: displayName, emoji };
  saveConfig(config);
}
