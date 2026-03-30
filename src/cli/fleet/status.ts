import { Command } from 'commander';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { loadConfig } from '../../core/config.js';
import { listBscsContainers, type ContainerInfo } from '../../core/docker.js';
import { createLogger } from '../../util/logger.js';
import { pullImage, createContainer, startContainer, stopContainer, removeContainer } from '../../core/docker.js';

const logger = createLogger('fleet');

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
}

export interface FleetStatusResult {
  fleetName: string;
  controller: string;
  machines: Record<string, { host: string; agentCount: number; status: string; role?: string }>;
  agents: FleetAgentStatus[];
  summary: { total: number; running: number; stopped: number; unknown: number };
}

interface RemoteContainerInfo {
  name: string;
  status: string;
  image: string;
}

function getLocalIps(): string[] {
  try {
    const result = execSync("/sbin/ifconfig 2>/dev/null | grep 'inet ' | awk '{print $2}' || ip -4 addr show 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1", { encoding: 'utf8', timeout: 3000 });
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return ['127.0.0.1'];
  }
}

function isLocalMachine(host: string): boolean {
  const localIps = getLocalIps();
  return host === 'localhost' || host === '127.0.0.1' || localIps.includes(host);
}

async function getRemoteDockerContainers(host: string, user: string, sshAlias?: string): Promise<RemoteContainerInfo[]> {
  try {
    const target = sshAlias || `${user}@${host}`;
    const cmd = `ssh -o ConnectTimeout=5 -o BatchMode=yes ${target} 'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; docker ps -a --format "{{.Names}}|{{.Status}}|{{.Image}}" 2>/dev/null'`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
    return result.trim().split('\n').filter(Boolean).map(line => {
      const [name, rawStatus, image] = line.split('|');
      const status = rawStatus?.toLowerCase().startsWith('up') ? 'running' :
                     rawStatus?.toLowerCase().startsWith('exited') ? 'stopped' :
                     rawStatus?.toLowerCase().startsWith('created') ? 'created' : 'unknown';
      return { name: name || '', status, image: image || '' };
    });
  } catch (err) {
    logger.debug({ host, err: (err as Error).message }, 'Failed to get remote containers');
    return [];
  }
}

async function checkRemoteNativeAgent(host: string, user: string, port: number, sshAlias?: string): Promise<boolean> {
  try {
    const target = sshAlias || `${user}@${host}`;
    const cmd = `ssh -o ConnectTimeout=5 -o BatchMode=yes ${target} 'curl -s --max-time 3 http://127.0.0.1:${port}/healthz 2>/dev/null'`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
    return result.includes('"ok"') || result.includes('"live"');
  } catch {
    return false;
  }
}

export async function getFleetStatus(includeAll = true): Promise<FleetStatusResult> {
  const config = loadConfig();
  
  // Get local Docker containers
  let localContainers: ContainerInfo[] = [];
  try {
    localContainers = await listBscsContainers();
  } catch (err) {
    logger.warn({ err }, 'Could not list local Docker containers');
  }
  const localContainerMap = new Map(localContainers.map(c => [c.name.replace('openclaw_', ''), c]));
  
  // Group agents by machine
  const machineAgents = new Map<string, Array<{ name: string; agentConfig: any }>>();
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
  
  const remoteMachines = [...machineAgents.keys()].filter(m => !isLocalMachine(m));
  const remoteChecks = remoteMachines.map(async (machineHost) => {
    const machineConfig = (config.machines as any)?.[machineHost] || {};
    const user = machineConfig.user || 'hani';
    const sshAlias = machineConfig.sshAlias;
    try {
      const containers = await getRemoteDockerContainers(machineHost, user, sshAlias);
      remoteContainerCache.set(machineHost, containers);
      machineStatus.set(machineHost, 'online');
    } catch {
      machineStatus.set(machineHost, 'offline');
    }
  });
  
  await Promise.all(remoteChecks);
  
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
          // Check local Docker
          const container = localContainerMap.get(name) || 
            localContainers.find(c => c.name === containerName);
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
          // Check remote Docker
          const remoteContainers = remoteContainerCache.get(machine) || [];
          const match = remoteContainers.find(c => 
            c.name === containerName || c.name === `openclaw_${name}` || c.name === name
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
        // For native agents, check gateway health
        const gwPort = agentConfig.ports?.gateway || 18789;
        if (isLocal) {
          try {
            const res = execSync(`curl -s --max-time 2 http://127.0.0.1:${gwPort}/healthz`, { encoding: 'utf8', timeout: 5000 });
            status = (res.includes('"ok"') || res.includes('"live"')) ? 'running' : 'stopped';
          } catch {
            status = 'stopped';
          }
        } else {
          const nativeMachineConfig = (config.machines as any)?.[machine] || {};
          const nativeUser = nativeMachineConfig.user || 'hani';
          const nativeSshAlias = nativeMachineConfig.sshAlias;
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
    running: agents.filter(a => a.status === 'running').length,
    stopped: agents.filter(a => a.status === 'stopped' || a.status === 'created').length,
    unknown: agents.filter(a => !['running', 'stopped', 'created'].includes(a.status)).length,
  };
  
  // Build machines summary
  const machinesResult: Record<string, { host: string; agentCount: number; status: string; role?: string }> = {};
  for (const [host, machineConfig] of Object.entries(config.machines || {})) {
    const agentCount = agents.filter(a => a.machine === host).length;
    machinesResult[host] = {
      host,
      agentCount,
      status: isLocalMachine(host) ? 'online' : (machineStatus.get(host) || 'unknown'),
      role: machineConfig.role,
    };
  }
  // Add localhost if not in machines
  const localAgentCount = agents.filter(a => isLocalMachine(a.machine)).length;
  if (localAgentCount > 0 && !Object.values(machinesResult).some(m => isLocalMachine(m.host))) {
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

export function createFleetStatusCommand(): Command {
  return new Command('status')
    .description('Show fleet status - all agents across machines')
    .option('--all', 'Include all containers')
    .option('--json', 'Output as JSON')
    .action(async (options: { all?: boolean; json?: boolean }) => {
      try {
        const status = await getFleetStatus(options.all !== false);
        
        if (options.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }
        
        console.log();
        console.log(chalk.bold.cyan(`🚀 Fleet: ${status.fleetName}`));
        console.log(chalk.dim(`   Controller: ${status.controller}`));
        console.log();
        console.log(chalk.bold(`   Summary:`) +
          chalk.green(`${status.summary.running} running`) + ', ' +
          chalk.red(`${status.summary.stopped} stopped`) + ', ' +
          chalk.gray(`${status.summary.unknown} other`));
        console.log();
        
        if (status.agents.length === 0) {
          console.log(chalk.dim('   No agents configured'));
          console.log(chalk.dim('   Run "bscs fleet init" to get started'));
          return;
        }
        
        console.log(chalk.bold('   Agents:'));
        for (const agent of status.agents) {
          const icon = agent.status === 'running' ? chalk.green('●') :
                       agent.status === 'stopped' ? chalk.red('○') :
                       chalk.gray('?');
          const ports = agent.ports ? `${agent.ports.gateway || '-'}/${agent.ports.remote || '-'}` : '-';
          console.log(`   ${icon} ${agent.name} ${agent.status} ${ports}`);
        }
      } catch (err) {
        console.error(chalk.red('Failed to get fleet status'), err);
        process.exit(1);
      }
    });
}

export function createFleetReconcileCommand(): Command {
  const cmd = new Command('reconcile')
    .description('Ensure running containers match configuration')
    .option('--dry-run', 'Show changes without applying')
    .option('--json', 'Output as JSON')
    .action(async (options: { dryRun?: boolean; json?: boolean }) => {
      const config = loadConfig();
      const changes: Array<{ action: string; agent: string; reason: string }> = [];
      
      let containers: ContainerInfo[] = [];
      try {
        containers = await listBscsContainers();
      } catch (err) {
        console.error(chalk.red('Could not list containers'), err);
        process.exit(1);
      }
      
      const containerMap = new Map(containers.map(c => [c.name.replace('openclaw_', ''), c]));
      
      // Check configured agents
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
      
      // Check orphaned containers
      for (const [name, container] of containerMap) {
        changes.push({ 
          action: container.status === 'running' ? 'stop' : 'remove', 
          agent: name, 
          reason: 'Orphaned' 
        });
      }
      
      if (options.json) {
        console.log(JSON.stringify({ changes }, null, 2));
        return;
      }
      
      if (changes.length === 0) {
        console.log(chalk.green('\n✓ Fleet in sync\n'));
        return;
      }
      
      console.log();
      console.log(chalk.bold.cyan('🔄 Fleet Reconciliation'));
      if (options.dryRun) console.log(chalk.dim('   (dry-run)'));
      console.log();
      
      for (const c of changes) {
        const icon = c.action === 'create' ? chalk.dim('+') :
                     c.action === 'start' ? chalk.dim('▶') :
                     chalk.red('■');
        console.log(`   ${icon} ${c.action} ${c.agent}`);
      }
      
      if (options.dryRun) {
        console.log(chalk.dim('\nRun without --dry-run to apply.\n'));
        return;
      }
      
      console.log(chalk.bold('\nApplying changes...\n'));
      
      for (const change of changes) {
        try {
          const agentConfig = config.agents?.[change.agent];
          const image = agentConfig?.image || config.defaults?.image || 'openclaw-fleet:latest';
          const ports = agentConfig?.ports || { gateway: 19000, remote: 19001 };
          
          if (change.action === 'create') {
            console.log(chalk.dim(`Creating ${change.agent}...`));
            await pullImage(image);
            await createContainer({ name: change.agent, image, ports });
            await startContainer(change.agent);
            console.log(chalk.green(`  ✓ Created ${change.agent}`));
          } else if (change.action === 'start') {
            console.log(chalk.dim(`Starting ${change.agent}...`));
            await startContainer(change.agent);
            console.log(chalk.green(`  ✓ Started ${change.agent}`));
          } else if (change.action === 'stop') {
            console.log(chalk.dim(`Stopping ${change.agent}...`));
            await stopContainer(change.agent);
            console.log(chalk.green(`  ✓ Stopped ${change.agent}`));
          } else if (change.action === 'remove') {
            console.log(chalk.dim(`Removing ${change.agent}...`));
            await removeContainer(change.agent);
            console.log(chalk.green(`  ✓ Removed ${change.agent}`));
          }
        } catch (err) {
          console.log(chalk.red(`  ✗ Failed: ${err}`));
        }
      }
      
      console.log(chalk.green('\n✓ Reconciliation complete\n'));
    });
  
  return cmd;
}
