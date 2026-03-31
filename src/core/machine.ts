/**
 * Core machine module — machine add, remove, bootstrap, status.
 */
import { execSync } from 'child_process';
import { loadConfig, saveConfig } from './config.js';
import { createLogger } from '../util/logger.js';
import { sshExec } from '../util/ssh.js';
import type { MachineRole, Machine } from '../util/types.js';

const logger = createLogger('machine');

// ── Types ────────────────────────────────────────────────────────────

export interface MachineStatusResult {
  name: string;
  host: string;
  role: MachineRole;
  user: string;
  port: number;
  reachable: boolean;
  dockerRunning?: boolean;
  agentCount: number;
}

export interface BootstrapStep {
  name: string;
  command: string;
  description: string;
}

// ── Machine CRUD ─────────────────────────────────────────────────────

export function addMachine(
  name: string,
  options: { host: string; user?: string; role?: MachineRole; port?: number },
): void {
  const config = loadConfig();
  config.machines = config.machines || {};

  if (config.machines[name]) {
    throw new Error(`Machine "${name}" already exists`);
  }

  config.machines[name] = {
    host: options.host,
    user: options.user || 'root',
    role: options.role || 'worker',
    port: options.port || 22,
  };

  saveConfig(config);
  logger.info({ name, host: options.host }, 'Machine added');
}

export function removeMachine(name: string): void {
  const config = loadConfig();

  if (!config.machines?.[name]) {
    throw new Error(`Machine "${name}" not found`);
  }

  // Check if any agents are assigned to this machine
  if (config.agents) {
    const assignedAgents = Object.entries(config.agents)
      .filter(([, a]) => a.machine === name)
      .map(([n]) => n);
    if (assignedAgents.length > 0) {
      throw new Error(
        `Machine "${name}" has agents assigned: ${assignedAgents.join(', ')}`,
      );
    }
  }

  delete config.machines[name];
  saveConfig(config);
  logger.info({ name }, 'Machine removed');
}

// ── Machine Status ───────────────────────────────────────────────────

export async function getMachineStatus(
  name?: string,
): Promise<MachineStatusResult[]> {
  const config = loadConfig();
  const machines = config.machines || {};
  const results: MachineStatusResult[] = [];

  const targets = name ? { [name]: machines[name] } : machines;

  for (const [machineName, machine] of Object.entries(targets)) {
    if (!machine) continue;

    const agentCount = config.agents
      ? Object.values(config.agents).filter((a) => a.machine === machineName).length
      : 0;

    let reachable = false;
    let dockerRunning: boolean | undefined;

    if (machineName === 'localhost' || machine.host === 'localhost') {
      reachable = true;
      try {
        execSync('docker info', { stdio: 'ignore' });
        dockerRunning = true;
      } catch {
        dockerRunning = false;
      }
    } else {
      try {
        sshExec(
          { host: machine.host, user: machine.user, port: machine.port },
          'true',
          { timeoutMs: 5000, stdio: 'ignore' },
        );
        reachable = true;
        try {
          sshExec(
            { host: machine.host, user: machine.user, port: machine.port },
            'docker info',
            { timeoutMs: 5000, stdio: 'ignore' },
          );
          dockerRunning = true;
        } catch {
          dockerRunning = false;
        }
      } catch {
        reachable = false;
      }
    }

    results.push({
      name: machineName,
      host: machine.host,
      role: machine.role,
      user: machine.user,
      port: machine.port,
      reachable,
      dockerRunning,
      agentCount,
    });
  }

  return results;
}

// ── Bootstrap ────────────────────────────────────────────────────────

export function getBootstrapSteps(machine: Machine): BootstrapStep[] {
  return [
    {
      name: 'docker',
      // Use distro-signed package instead of curl-pipe-to-sh
      command: 'apt-get update -qq && apt-get install -y docker.io && systemctl enable --now docker',
      description: 'Install Docker',
    },
    {
      name: 'docker-group',
      command: `usermod -aG docker ${machine.user}`,
      description: 'Add user to docker group',
    },
    {
      name: 'node',
      // NodeSource signed .deb repository — no pipe-to-sh
      command: 'apt-get update -qq && apt-get install -y ca-certificates curl gnupg && mkdir -p /etc/apt/keyrings && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && apt-get update -qq && apt-get install -y nodejs',
      description: 'Install Node.js 22',
    },
    {
      name: 'firewall',
      command: 'ufw allow 22/tcp && ufw enable',
      description: 'Configure firewall',
    },
    {
      name: 'fail2ban',
      command: 'apt-get install -y fail2ban && systemctl enable fail2ban',
      description: 'Install fail2ban',
    },
  ];
}

export async function bootstrapMachine(
  name: string,
  options: { dryRun?: boolean } = {},
): Promise<{ steps: BootstrapStep[]; executed: boolean }> {
  const config = loadConfig();
  const machine = config.machines?.[name];

  if (!machine) {
    throw new Error(`Machine "${name}" not found`);
  }

  const steps = getBootstrapSteps(machine);

  if (options.dryRun) {
    return { steps, executed: false };
  }

  if (name === 'localhost' || machine.host === 'localhost') {
    throw new Error('Cannot bootstrap localhost remotely');
  }

  for (const step of steps) {
    logger.info({ step: step.name }, step.description);
    sshExec(
      { host: machine.host, user: machine.user, port: machine.port },
      step.command,
      { timeoutMs: 120000, stdio: 'inherit' },
    );
  }

  return { steps, executed: true };
}
