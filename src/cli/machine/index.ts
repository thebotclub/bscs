import { Command } from 'commander';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { hostname, platform, arch, freemem, totalmem, cpus, uptime as osUptime } from 'os';
import { createLogger } from '../../util/logger.js';
import { loadConfig, saveConfig } from '../../core/config.js';
import { isDockerRunning } from '../../core/docker.js';
import type { Machine, MachineRole } from '../../util/types.js';

const logger = createLogger('machine');

export interface MachineStatus {
  hostname: string;
  platform: string;
  arch: string;
  uptime: number;
  cpuCount: number;
  cpuModel: string;
  totalMemory: number;
  freeMemory: number;
  usedMemoryPercent: number;
  dockerRunning: boolean;
  dockerVersion?: string;
  nodeVersion: string;
  agentCount: number;
  role: string;
}

export async function getMachineStatus(): Promise<MachineStatus> {
  const config = loadConfig();
  const machineConfig = config.machines?.localhost;
  
  // Get CPU info
  const cpuList = cpus();
  const cpuModel = cpuList[0]?.model || 'Unknown';
  const cpuCount = cpuList.length;
  
  // Get memory info
  const totalMemory = totalmem();
  const freeMemory = freemem();
  const usedMemoryPercent = ((totalMemory - freeMemory) / totalMemory) * 100;
  
  // Get Docker status
  let dockerRunning = false;
  let dockerVersion: string | undefined;
  try {
    dockerRunning = await isDockerRunning();
    if (dockerRunning) {
      try {
        dockerVersion = execSync('docker --version', { encoding: 'utf-8' }).trim();
      } catch {
        // Ignore
      }
    }
  } catch {
    // Docker not available
  }
  
  // Count agents
  const agentCount = Object.keys(config.agents || {}).length;
  
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    uptime: osUptime(),
    cpuCount,
    cpuModel,
    totalMemory,
    freeMemory,
    usedMemoryPercent,
    dockerRunning,
    dockerVersion,
    nodeVersion: process.version,
    agentCount,
    role: machineConfig?.role || 'controller',
  };
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) {
    return `${gb.toFixed(1)} GB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);
  
  return parts.join(' ');
}

// SSH helper for remote commands
function sshExec(host: string, command: string, options: { user?: string; port?: number } = {}): { stdout: string; stderr: string; code: number } {
  const user = options.user || 'root';
  const port = options.port || 22;
  const sshCmd = `ssh -p ${port} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 ${user}@${host} "${command.replace(/"/g, '\\"')}"`;
  
  try {
    const stdout = execSync(sshCmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { stdout: stdout.trim(), stderr: '', code: 0 };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; status?: number };
    return { 
      stdout: (error.stdout || '').trim(), 
      stderr: (error.stderr || '').trim(), 
      code: error.status || 1 
    };
  }
}

// Bootstrap steps
interface BootstrapStep {
  name: string;
  check: string;
  install: string;
  verify: string;
}

const BOOTSTRAP_STEPS: BootstrapStep[] = [
  {
    name: 'Docker',
    check: 'command -v docker >/dev/null 2>&1 && echo "installed"',
    // Use distro-signed packages instead of curl-pipe-to-sh
    install: 'apt-get update -qq && apt-get install -y docker.io && systemctl enable --now docker',
    verify: 'docker --version',
  },
  {
    name: 'Node.js',
    check: 'command -v node >/dev/null 2>&1 && echo "installed"',
    // NodeSource signed .deb repository — no pipe-to-sh
    install: 'apt-get update -qq && apt-get install -y ca-certificates curl gnupg && mkdir -p /etc/apt/keyrings && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && apt-get update -qq && apt-get install -y nodejs',
    verify: 'node --version',
  },
  {
    name: 'OpenClaw',
    check: 'command -v openclaw >/dev/null 2>&1 && echo "installed"',
    install: 'npm install -g openclaw',
    verify: 'openclaw --version',
  },
];

function createMachineStatusCommand(): Command {
  return new Command('status')
    .description('Show machine health information')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      logger.debug({}, 'Getting machine status');
      
      try {
        const status = await getMachineStatus();
        
        if (options.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }
        
        // Human-readable output
        console.log();
        console.log(chalk.bold.cyan(`🖥️  Machine: ${status.hostname}`));
        console.log();
        
        // System info
        console.log(chalk.bold('   System:'));
        console.log(chalk.dim(`     Platform:   ${status.platform} (${status.arch})`));
        console.log(chalk.dim(`     Uptime:     ${formatUptime(status.uptime)}`));
        console.log(chalk.dim(`     Node.js:    ${status.nodeVersion}`));
        console.log();
        
        // Hardware info
        console.log(chalk.bold('   Hardware:'));
        console.log(chalk.dim(`     CPU:        ${status.cpuCount}x ${status.cpuModel.split(' ')[0]}`));
        console.log(chalk.dim(`     Memory:     ${formatBytes(status.totalMemory)} (${(100 - status.usedMemoryPercent).toFixed(0)}% free)`));
        console.log();
        
        // Docker info
        console.log(chalk.bold('   Docker:'));
        if (status.dockerRunning) {
          console.log(chalk.green(`     Status:     Running`));
          if (status.dockerVersion) {
            console.log(chalk.dim(`     Version:    ${status.dockerVersion}`));
          }
        } else {
          console.log(chalk.red(`     Status:     Not running`));
        }
        console.log();
        
        // Fleet info
        console.log(chalk.bold('   Fleet:'));
        console.log(chalk.dim(`     Role:       ${status.role}`));
        console.log(chalk.dim(`     Agents:     ${status.agentCount}`));
        console.log();
        
      } catch (err) {
        logger.error({ err }, 'Failed to get machine status');
        console.error(chalk.red('Failed to get machine status'));
        process.exit(1);
      }
    });
}

function createMachineBootstrapCommand(): Command {
  return new Command('bootstrap')
    .description('Bootstrap a remote machine with Docker, Node.js, and OpenClaw')
    .argument('<host>', 'Hostname or IP address of the machine')
    .option('-u, --user <user>', 'SSH user', 'root')
    .option('-p, --port <port>', 'SSH port', '22')
    .option('-r, --role <role>', 'Machine role (controller, worker, gpu)', 'worker')
    .option('--dry-run', 'Preview what would be done without making changes')
    .option('--json', 'Output as JSON')
    .action(async (host: string, options: { user: string; port: string; role: MachineRole; dryRun?: boolean; json?: boolean }) => {
      const port = parseInt(options.port, 10);
      const { user, role, dryRun, json } = options;
      
      logger.debug({ host, user, port, role, dryRun }, 'Bootstrapping machine');
      
      if (dryRun) {
        console.log(chalk.cyan('\n🔍 Dry run - preview of bootstrap operations:\n'));
        console.log(chalk.dim(`Host: ${user}@${host}:${port}`));
        console.log(chalk.dim(`Role: ${role}`));
        console.log();
        console.log(chalk.bold('Steps that would be performed:'));
        console.log();
        
        for (const step of BOOTSTRAP_STEPS) {
          console.log(chalk.yellow(`  1. Check ${step.name}`));
          console.log(chalk.dim(`     Command: ssh ${user}@${host} "${step.check}"`));
          console.log(chalk.dim(`     If not installed:`));
          console.log(chalk.dim(`       ${step.install}`));
          console.log();
        }
        
        console.log(chalk.yellow(`  4. Configure OpenClaw`));
        console.log(chalk.dim(`     Create ~/.config/openclaw/config.json`));
        console.log();
        
        console.log(chalk.yellow(`  5. Add to local fleet config`));
        console.log(chalk.dim(`     Add machine "${host}" to ~/.config/bscs/config.json`));
        console.log();
        
        console.log(chalk.green('To actually bootstrap, run without --dry-run'));
        return;
      }
      
      console.log(chalk.cyan(`\n🚀 Bootstrapping ${host}...\n`));
      
      const results: { step: string; status: 'ok' | 'skipped' | 'failed'; message?: string }[] = [];
      
      // Step 1-3: Install dependencies
      for (const step of BOOTSTRAP_STEPS) {
        process.stdout.write(chalk.dim(`  Checking ${step.name}... `));
        
        const checkResult = sshExec(host, step.check, { user, port });
        
        if (checkResult.code === 0 && checkResult.stdout.includes('installed')) {
          console.log(chalk.green('✓ already installed'));
          const verifyResult = sshExec(host, step.verify, { user, port });
          results.push({ step: step.name, status: 'skipped', message: verifyResult.stdout || 'installed' });
          continue;
        }
        
        // Need to install
        console.log(chalk.yellow('installing...'));
        console.log(chalk.dim(`    Running: ${step.install}`));
        
        const installResult = sshExec(host, step.install, { user, port });
        
        if (installResult.code !== 0) {
          console.log(chalk.red(`✗ Failed to install ${step.name}`));
          if (installResult.stderr) {
            console.log(chalk.red(`    Error: ${installResult.stderr}`));
          }
          results.push({ step: step.name, status: 'failed', message: installResult.stderr || 'install failed' });
          continue;
        }
        
        // Verify
        const verifyResult = sshExec(host, step.verify, { user, port });
        if (verifyResult.code === 0) {
          console.log(chalk.green(`✓ ${step.name} installed: ${verifyResult.stdout}`));
          results.push({ step: step.name, status: 'ok', message: verifyResult.stdout });
        } else {
          console.log(chalk.red(`✗ ${step.name} installation could not be verified`));
          results.push({ step: step.name, status: 'failed', message: 'verification failed' });
        }
      }
      
      // Step 4: Create OpenClaw config
      process.stdout.write(chalk.dim(`  Creating OpenClaw config... `));
      const configDir = '~/.config/openclaw';
      const configCmd = `mkdir -p ${configDir} && printf '%s\\n' '{"version":"1.0"}' > ${configDir}/config.json`;
      const configResult = sshExec(host, configCmd, { user, port });
      
      if (configResult.code === 0) {
        console.log(chalk.green('✓'));
        results.push({ step: 'OpenClaw Config', status: 'ok' });
      } else {
        console.log(chalk.red('✗'));
        results.push({ step: 'OpenClaw Config', status: 'failed', message: configResult.stderr });
      }
      
      // Step 5: Add to local fleet config
      process.stdout.write(chalk.dim(`  Adding to fleet config... `));
      try {
        const config = loadConfig();
        config.machines = config.machines || {};
        config.machines[host] = {
          host,
          user,
          role,
          port,
        };
        saveConfig(config);
        console.log(chalk.green('✓'));
        results.push({ step: 'Fleet Config', status: 'ok' });
      } catch (err) {
        console.log(chalk.red('✗'));
        results.push({ step: 'Fleet Config', status: 'failed', message: String(err) });
      }
      
      // Summary
      console.log();
      const failed = results.filter(r => r.status === 'failed');
      if (failed.length === 0) {
        console.log(chalk.green('✓ Bootstrap complete!\n'));
      } else {
        console.log(chalk.yellow(`⚠ Bootstrap completed with ${failed.length} failures:\n`));
        for (const f of failed) {
          console.log(chalk.red(`  - ${f.step}: ${f.message}`));
        }
        console.log();
      }
      
      if (json) {
        console.log(JSON.stringify({ host, results, success: failed.length === 0 }, null, 2));
      }
      
      process.exit(failed.length > 0 ? 2 : 0);
    });
}

function createMachineAddCommand(): Command {
  return new Command('add')
    .description('Add an existing machine to the fleet config')
    .argument('<host>', 'Hostname or IP address')
    .option('-u, --user <user>', 'SSH user', 'root')
    .option('-p, --port <port>', 'SSH port', '22')
    .option('-r, --role <role>', 'Machine role (controller, worker, gpu)', 'worker')
    .option('--dry-run', 'Preview without saving')
    .option('--json', 'Output as JSON')
    .action((host: string, options: { user: string; port: string; role: MachineRole; dryRun?: boolean; json?: boolean }) => {
      const port = parseInt(options.port, 10);
      const { user, role, dryRun, json } = options;
      
      logger.debug({ host, user, port, role, dryRun }, 'Adding machine');
      
      const machine: Machine = { host, user, role, port };
      
      if (dryRun) {
        console.log(chalk.cyan('\n🔍 Dry run - would add machine:\n'));
        console.log(JSON.stringify(machine, null, 2));
        console.log();
        return;
      }
      
      try {
        const config = loadConfig();
        
        if (config.machines?.[host]) {
          console.error(chalk.red(`Machine "${host}" already exists in fleet config`));
          console.log(chalk.dim('Use "bscs machine remove" first to replace it'));
          process.exit(1);
        }
        
        config.machines = config.machines || {};
        config.machines[host] = machine;
        saveConfig(config);
        
        if (json) {
          console.log(JSON.stringify({ host, added: true, machine }, null, 2));
        } else {
          console.log(chalk.green(`✓ Machine "${host}" added to fleet`));
          console.log(chalk.dim(`  Role: ${role}`));
          console.log(chalk.dim(`  SSH:  ${user}@${host}:${port}`));
        }
      } catch (err) {
        logger.error({ err }, 'Failed to add machine');
        console.error(chalk.red('Failed to add machine to fleet config'));
        process.exit(1);
      }
    });
}

function createMachineRemoveCommand(): Command {
  return new Command('remove')
    .description('Remove a machine from the fleet config')
    .argument('<host>', 'Hostname or IP address')
    .option('--dry-run', 'Preview without saving')
    .option('--json', 'Output as JSON')
    .option('-f, --force', 'Remove even if agents are assigned', false)
    .action((host: string, options: { dryRun?: boolean; json?: boolean; force?: boolean }) => {
      const { dryRun, json, force } = options;
      
      logger.debug({ host, dryRun, force }, 'Removing machine');
      
      try {
        const config = loadConfig();
        
        if (!config.machines?.[host]) {
          console.error(chalk.red(`Machine "${host}" not found in fleet config`));
          process.exit(1);
        }
        
        // Check for assigned agents
        const assignedAgents = Object.entries(config.agents || {})
          .filter(([_, agent]) => agent.machine === host)
          .map(([name]) => name);
        
        if (assignedAgents.length > 0 && !force) {
          console.error(chalk.red(`Machine "${host}" has ${assignedAgents.length} agent(s) assigned:`));
          for (const name of assignedAgents) {
            console.error(chalk.dim(`  - ${name}`));
          }
          console.error(chalk.dim('\nUse --force to remove anyway'));
          process.exit(1);
        }
        
        if (dryRun) {
          console.log(chalk.cyan('\n🔍 Dry run - would remove machine:\n'));
          console.log(JSON.stringify(config.machines[host], null, 2));
          if (assignedAgents.length > 0) {
            console.log(chalk.yellow('\nWarning: Agents would be orphaned:'));
            for (const name of assignedAgents) {
              console.log(chalk.dim(`  - ${name}`));
            }
          }
          console.log();
          return;
        }
        
        const removed = config.machines[host];
        delete config.machines[host];
        saveConfig(config);
        
        if (json) {
          console.log(JSON.stringify({ host, removed: true, machine: removed, orphanedAgents: assignedAgents }, null, 2));
        } else {
          console.log(chalk.green(`✓ Machine "${host}" removed from fleet`));
          if (assignedAgents.length > 0) {
            console.log(chalk.yellow(`  Warning: ${assignedAgents.length} agent(s) orphaned`));
          }
        }
      } catch (err) {
        logger.error({ err }, 'Failed to remove machine');
        console.error(chalk.red('Failed to remove machine from fleet config'));
        process.exit(1);
      }
    });
}

export function createMachineCommand(): Command {
  const command = new Command('machine')
    .description('Machine management commands');
  
  command.addCommand(createMachineStatusCommand());
  command.addCommand(createMachineBootstrapCommand());
  command.addCommand(createMachineAddCommand());
  command.addCommand(createMachineRemoveCommand());
  
  return command;
}
