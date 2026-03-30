import { Command } from 'commander';
import chalk from 'chalk';
import { execSync } from 'child_process';
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
} from '../../core/docker.js';
import { loadConfig, saveConfig, type BscsConfig } from '../../core/config.js';
import { createLogger } from '../../util/logger.js';
import type { AgentRole } from '../../util/types.js';

const logger = createLogger('agent');

// Allocate ports for a new agent
async function allocatePorts(config: BscsConfig): Promise<{ gateway?: number; remote?: number }> {
  const start = config.defaults?.portRange?.start || 19000;
  const end = config.defaults?.portRange?.end || 19999;
  const usedPorts = new Set<number>();
  
  // Collect used ports from existing agents in config
  if (config.agents) {
    for (const agent of Object.values(config.agents)) {
      if (agent.ports) {
        if (agent.ports.gateway) usedPorts.add(agent.ports.gateway);
        if (agent.ports.remote) usedPorts.add(agent.ports.remote);
      }
    }
  }
  
  // Also check running Docker containers
  try {
    const { listBscsContainers } = await import('../../core/docker.js');
    const containers = await listBscsContainers();
    for (const c of containers) {
      if (c.ports?.gateway) usedPorts.add(c.ports.gateway);
      if (c.ports?.remote) usedPorts.add(c.ports.remote);
    }
  } catch {
    // Docker not available, continue with config-only check
  }
  
  // Find next available port pair
  for (let port = start; port <= end - 1; port += 2) {
    if (!usedPorts.has(port) && !usedPorts.has(port + 1)) {
      return { gateway: port, remote: port + 1 };
    }
  }
  
  throw new Error('No available ports in configured range');
}

// Tribunal installation for coding agents
interface TribunalSetupResult {
  installed: boolean;
  path?: string;
  error?: string;
}

async function setupTribunal(agentName: string, agentPath: string): Promise<TribunalSetupResult> {
  try {
    // Check if pip/pipx is available
    let pipCmd = 'pip';
    try {
      execSync('command -v pipx', { stdio: 'ignore' });
      pipCmd = 'pipx';
    } catch {
      try {
        execSync('command -v pip3', { stdio: 'ignore' });
        pipCmd = 'pip3';
      } catch {
        // Fall back to pip
      }
    }
    
    // Install tribunal
    console.log(chalk.dim(`  Installing Tribunal via ${pipCmd}...`));
    execSync(`${pipCmd} install tribunal`, { stdio: 'inherit' });
    
    // Create .tribunal directory
    const tribunalDir = join(agentPath, '.tribunal');
    if (!existsSync(tribunalDir)) {
      mkdirSync(tribunalDir, { recursive: true });
    }
    
    // Create tribunal config
    const tribunalConfig = {
      version: '1.0',
      agent: {
        name: agentName,
        type: 'coding',
      },
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
    
    writeFileSync(join(tribunalDir, 'config.json'), JSON.stringify(tribunalConfig, null, 2));
    
    // Create .claude directory and settings
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
    
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(claudeSettings, null, 2));
    
    return { installed: true, path: tribunalDir };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { installed: false, error: message };
  }
}

// Get resources for a role
function getResourcesForRole(role: AgentRole, config: BscsConfig): { memory: string; pidsLimit: number } {
  // Map role to resource key (security, marketing, custom fall back to default)
  const resourceKey: 'coding' | 'review' | 'brain' | 'ops' | 'default' = 
    (['coding', 'review', 'brain', 'ops'] as const).includes(role as 'coding' | 'review' | 'brain' | 'ops')
      ? role as 'coding' | 'review' | 'brain' | 'ops'
      : 'default';
  const resources = config.docker?.resources?.[resourceKey] || config.docker?.resources?.default;
  return {
    memory: resources?.memory || '2g',
    pidsLimit: resources?.pidsLimit || 256,
  };
}

// Get model for a role
function getModelForRole(role: AgentRole, config: BscsConfig): string {
  return config.models?.defaults?.[role] || 'claude-sonnet-4';
}

export function createAgentCreateCommand(): Command {
  return new Command('create')
    .description('Create a new agent container')
    .argument('<name>', 'Agent name')
    .option('-i, --image <image>', 'Docker image to use')
    .option('-r, --role <role>', 'Agent role (coding, brain, review, security, ops, custom)', 'custom')
    .option('-m, --model <model>', 'Model to use (overrides role default)')
    .option('--no-start', 'Create without starting')
    .option('--dry-run', 'Preview what would be created without making changes')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { 
      image?: string; 
      role: AgentRole;
      model?: string;
      noStart?: boolean; 
      dryRun?: boolean;
      json?: boolean;
    }) => {
      const { role, model, noStart, dryRun, json } = options;
      
      logger.debug({ name, options }, 'Creating agent');
      
      const config = loadConfig();
      const image = options.image || config.defaults?.image || 'openclaw-fleet:latest';
      const agentModel = model || getModelForRole(role, config);
      const resources = getResourcesForRole(role, config);
      
      // Check if agent already exists
      if (config.agents?.[name]) {
        console.error(chalk.red(`Agent "${name}" already exists`));
        console.log(chalk.dim('Use "bscs agent destroy" first to replace it'));
        process.exit(1);
      }
      
      // Check if container exists
      const existing = await getContainer(name);
      if (existing) {
        console.error(chalk.red(`Container "openclaw_${name}" already exists`));
        console.log(chalk.dim('Use "bscs agent destroy" first to remove it'));
        process.exit(1);
      }
      
      // Allocate ports
      const ports = await allocatePorts(config);
      
      if (dryRun) {
        console.log(chalk.cyan('\n🔍 Dry run - preview of agent creation:\n'));
        console.log(chalk.dim(`Name:       ${name}`));
        console.log(chalk.dim(`Role:       ${role}`));
        console.log(chalk.dim(`Image:      ${image}`));
        console.log(chalk.dim(`Model:      ${agentModel}`));
        console.log(chalk.dim(`Ports:      ${ports.gateway} (gateway), ${ports.remote} (remote)`));
        console.log(chalk.dim(`Memory:     ${resources.memory}`));
        console.log(chalk.dim(`PIDs Limit: ${resources.pidsLimit}`));
        
        if (role === 'coding') {
          console.log();
          console.log(chalk.yellow('Tribunal Setup (for coding role):'));
          console.log(chalk.dim('  - pip install tribunal'));
          console.log(chalk.dim('  - Create .tribunal/config.json'));
          console.log(chalk.dim('  - Create .claude/settings.json with hooks'));
        }
        
        console.log();
        console.log(chalk.green('To actually create, run without --dry-run'));
        return;
      }
      
      console.log(chalk.dim(`Creating agent "${name}"...`));
      console.log(chalk.dim(`  Role: ${role}`));
      console.log(chalk.dim(`  Image: ${image}`));
      console.log(chalk.dim(`  Model: ${agentModel}`));
      console.log(chalk.dim(`  Ports: ${ports.gateway} (gateway), ${ports.remote} (remote)`));
      
      try {
        // Pull image if needed
        await pullImage(image);
        
        // Create container
        const containerInfo = await createContainer({
          name,
          image,
          ports,
        });
        
        // Setup Tribunal for coding agents
        let tribunalResult: TribunalSetupResult | null = null;
        if (role === 'coding') {
          console.log();
          console.log(chalk.dim('Setting up Tribunal for coding agent...'));
          const agentPath = join(homedir(), '.config', 'bscs', 'agents', name);
          tribunalResult = await setupTribunal(name, agentPath);
          
          if (tribunalResult.installed) {
            console.log(chalk.green('  ✓ Tribunal installed and configured'));
          } else {
            console.log(chalk.yellow(`  ⚠ Tribunal setup failed: ${tribunalResult.error}`));
            console.log(chalk.dim('    Agent will continue without Tribunal protection'));
          }
        }
        
        // Update config
        config.agents = config.agents || {};
        config.agents[name] = {
          name,
          role,
          template: role === 'coding' ? 'coding' : 'custom',
          machine: 'localhost',
          image,
          model: agentModel,
          runtime: 'docker' as const,
          ports,
          created: new Date().toISOString(),
          status: 'created',
        };
        saveConfig(config);
        
        // Start if requested
        if (!noStart) {
          await startContainer(name);
          config.agents[name]!.status = 'running';
          saveConfig(config);
        }
        
        const result = {
          name,
          id: containerInfo.id,
          image,
          role,
          model: agentModel,
          ports,
          status: noStart ? 'created' : 'running',
          tribunal: tribunalResult?.installed || false,
        };
        
        if (json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log();
          console.log(chalk.green(`✓ Agent "${name}" created`));
          console.log(`  Container ID: ${containerInfo.id.slice(0, 12)}`);
          console.log(`  Status: ${result.status}`);
          if (tribunalResult?.installed) {
            console.log(`  Tribunal: Enabled`);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to create agent: ${message}`));
        
        // Provide hints based on common errors
        if (message.includes('permission denied')) {
          console.log(chalk.dim('Hint: Check Docker permissions or run with appropriate privileges'));
        } else if (message.includes('image not found')) {
          console.log(chalk.dim(`Hint: Pull the image first: docker pull ${image}`));
        } else if (message.includes('port')) {
          console.log(chalk.dim('Hint: Ports may be in use. Try a different range in config'));
        }
        
        logger.error({ err }, 'Failed to create agent');
        process.exit(1);
      }
    });
}

export function createAgentDestroyCommand(): Command {
  return new Command('destroy')
    .description('Destroy an agent container')
    .argument('<name>', 'Agent name')
    .option('-f, --force', 'Force removal even if running')
    .option('--volumes', 'Remove associated volumes')
    .option('--dry-run', 'Preview what would be destroyed without making changes')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { 
      force?: boolean; 
      volumes?: boolean; 
      dryRun?: boolean;
      json?: boolean;
    }) => {
      const { volumes, dryRun, json } = options;
      // Note: force is implicitly handled by Docker - containers are force-stopped if running
      
      logger.debug({ name, options }, 'Destroying agent');
      
      const config = loadConfig();
      
      // Check if agent exists in config
      if (!config.agents?.[name]) {
        console.error(chalk.red(`Agent "${name}" not found in config`));
        console.log(chalk.dim('Use "bscs agent status" to see available agents'));
        process.exit(1);
      }
      
      const agentConfig = config.agents[name];
      
      if (dryRun) {
        console.log(chalk.cyan('\n🔍 Dry run - preview of agent destruction:\n'));
        console.log(chalk.dim(`Name:       ${name}`));
        console.log(chalk.dim(`Image:      ${agentConfig.image}`));
        console.log(chalk.dim(`Status:     ${agentConfig.status}`));
        console.log(chalk.dim(`Created:    ${agentConfig.created}`));
        if (agentConfig.ports) {
          console.log(chalk.dim(`Ports:      ${agentConfig.ports.gateway}/${agentConfig.ports.remote}`));
        }
        console.log();
        console.log(chalk.yellow('Actions that would be performed:'));
        console.log(chalk.dim('  - Stop container (if running)'));
        console.log(chalk.dim('  - Remove container'));
        if (volumes) {
          console.log(chalk.dim('  - Remove volumes'));
        }
        console.log(chalk.dim('  - Remove from fleet config'));
        console.log();
        console.log(chalk.green('To actually destroy, run without --dry-run'));
        return;
      }
      
      try {
        // Stop and remove container
        await stopContainer(name);
        await removeContainer(name, volumes);
        
        // Remove from config
        delete config.agents![name];
        saveConfig(config);
        
        if (json) {
          console.log(JSON.stringify({ name, destroyed: true }, null, 2));
        } else {
          console.log(chalk.green(`✓ Agent "${name}" destroyed`));
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to destroy agent: ${message}`));
        
        if (message.includes('no such container')) {
          console.log(chalk.dim('Hint: Container may already be removed. Removing from config.'));
          delete config.agents![name];
          saveConfig(config);
          process.exit(0);
        } else if (message.includes('permission denied')) {
          console.log(chalk.dim('Hint: Check Docker permissions'));
        }
        
        logger.error({ err }, 'Failed to destroy agent');
        process.exit(1);
      }
    });
}

export function createAgentStatusCommand(): Command {
  return new Command('status')
    .description('Show agent status')
    .argument('[name]', 'Agent name (omit for all agents)')
    .option('--json', 'Output as JSON')
    .action(async (name?: string, options?: { json?: boolean }) => {
      logger.debug({ name }, 'Checking agent status');
      
      const config = loadConfig();
      
      if (name) {
        // Single agent status
        const agentConfig = config.agents?.[name];
        if (!agentConfig) {
          console.error(chalk.red(`Agent "${name}" not found`));
          console.log(chalk.dim('Use "bscs agent status" to see available agents'));
          process.exit(1);
        }
        
        const container = await getContainer(name);
        
        const result = {
          name,
          image: container?.image || agentConfig.image,
          status: container?.status || 'unknown',
          role: agentConfig.role,
          model: agentConfig.model,
          ports: container?.ports || agentConfig.ports,
          created: agentConfig.created,
          containerId: container?.id,
        };
        
        if (options?.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.bold(`\nAgent: ${name}\n`));
          console.log(`  Status:     ${formatStatus(result.status)}`);
          console.log(`  Role:       ${result.role}`);
          console.log(`  Model:      ${result.model || 'default'}`);
          console.log(`  Image:      ${result.image}`);
          if (result.ports) {
            console.log(`  Ports:      ${result.ports.gateway} (gateway), ${result.ports.remote} (remote)`);
          }
          if (result.containerId) {
            console.log(`  Container:  ${result.containerId.slice(0, 12)}`);
          }
          if (result.created) {
            console.log(`  Created:    ${result.created}`);
          }
        }
      } else {
        // All agents status
        const containers = await listBscsContainers();
        const containerMap = new Map(containers.map(c => [c.name.replace('openclaw_', ''), c]));
        
        const agents = Object.keys(config.agents || {});
        
        if (agents.length === 0) {
          if (options?.json) {
            console.log('[]');
          } else {
            console.log(chalk.dim('No agents configured'));
            console.log(chalk.dim('Create one with: bscs agent create <name> --role coding'));
          }
          return;
        }
        
        const results = agents.map(agentName => {
          const agentConfig = config.agents![agentName]!;
          const container = containerMap.get(agentName);
          
          return {
            name: agentName,
            image: container?.image || agentConfig.image,
            status: container?.status || 'unknown',
            role: agentConfig.role,
            model: agentConfig.model,
            ports: container?.ports || agentConfig.ports,
            created: agentConfig.created,
          };
        });
        
        if (options?.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          console.log(chalk.bold('\nAgents:\n'));
          for (const agent of results) {
            const statusStr = formatStatus(agent.status);
            console.log(`  ${statusStr} ${agent.name} (${agent.role})`);
            console.log(chalk.dim(`       model: ${agent.model || 'default'}, image: ${agent.image}`));
            if (agent.ports) {
              console.log(chalk.dim(`       ports: ${agent.ports.gateway}/${agent.ports.remote}`));
            }
          }
        }
      }
    });
}

function formatStatus(status: string): string {
  switch (status) {
    case 'running':
      return chalk.green('●');
    case 'stopped':
      return chalk.red('○');
    case 'created':
      return chalk.yellow('◐');
    default:
      return chalk.gray('?');
  }
}

// ── Agent Lifecycle Commands ──────────────────────────────────────────

export function createAgentStartCommand(): Command {
  return new Command('start')
    .description('Start an agent container')
    .argument('<name>', 'Agent name')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      const config = loadConfig();
      if (!config.agents?.[name]) {
        console.error(chalk.red(`Agent "${name}" not found in config`));
        process.exit(1);
      }
      try {
        await startContainer(name);
        config.agents[name]!.status = 'running';
        saveConfig(config);
        if (options.json) {
          console.log(JSON.stringify({ name, status: 'running' }));
        } else {
          console.log(chalk.green(`✓ Agent "${name}" started`));
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to start agent: ${message}`));
        process.exit(1);
      }
    });
}

export function createAgentStopCommand(): Command {
  return new Command('stop')
    .description('Stop an agent container')
    .argument('<name>', 'Agent name')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      const config = loadConfig();
      if (!config.agents?.[name]) {
        console.error(chalk.red(`Agent "${name}" not found in config`));
        process.exit(1);
      }
      try {
        await stopContainer(name);
        config.agents[name]!.status = 'stopped';
        saveConfig(config);
        if (options.json) {
          console.log(JSON.stringify({ name, status: 'stopped' }));
        } else {
          console.log(chalk.green(`✓ Agent "${name}" stopped`));
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to stop agent: ${message}`));
        process.exit(1);
      }
    });
}

export function createAgentRestartCommand(): Command {
  return new Command('restart')
    .description('Restart an agent container')
    .argument('<name>', 'Agent name')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      const config = loadConfig();
      if (!config.agents?.[name]) {
        console.error(chalk.red(`Agent "${name}" not found in config`));
        process.exit(1);
      }
      try {
        await stopContainer(name);
        await startContainer(name);
        config.agents[name]!.status = 'running';
        saveConfig(config);
        if (options.json) {
          console.log(JSON.stringify({ name, status: 'running' }));
        } else {
          console.log(chalk.green(`✓ Agent "${name}" restarted`));
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to restart agent: ${message}`));
        process.exit(1);
      }
    });
}

export function createAgentLogsCommand(): Command {
  return new Command('logs')
    .description('Show agent container logs')
    .argument('<name>', 'Agent name')
    .option('-f, --follow', 'Follow log output')
    .option('--tail <lines>', 'Number of lines to show from end', '100')
    .action(async (name: string, options: { follow?: boolean; tail: string }) => {
      const config = loadConfig();
      if (!config.agents?.[name]) {
        console.error(chalk.red(`Agent "${name}" not found in config`));
        process.exit(1);
      }
      try {
        const { spawn } = await import('child_process');
        const args = ['logs'];
        if (options.follow) args.push('-f');
        args.push('--tail', options.tail);
        args.push(`openclaw_${name}`);
        const child = spawn('docker', args, { stdio: 'inherit' });
        child.on('exit', (code) => process.exit(code || 0));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to get logs: ${message}`));
        process.exit(1);
      }
    });
}

export function createAgentShellCommand(): Command {
  return new Command('shell')
    .description('Open a shell in an agent container')
    .argument('<name>', 'Agent name')
    .action(async (name: string) => {
      const config = loadConfig();
      if (!config.agents?.[name]) {
        console.error(chalk.red(`Agent "${name}" not found in config`));
        process.exit(1);
      }
      try {
        const { spawn } = await import('child_process');
        const child = spawn('docker', ['exec', '-it', `openclaw_${name}`, '/bin/sh'], {
          stdio: 'inherit',
        });
        child.on('exit', (code) => process.exit(code || 0));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to open shell: ${message}`));
        process.exit(1);
      }
    });
}

// Create the agent command group
export function createAgentCommand(): Command {
  const command = new Command('agent')
    .description('Manage agent containers');
  
  command.addCommand(createAgentCreateCommand());
  command.addCommand(createAgentDestroyCommand());
  command.addCommand(createAgentStatusCommand());
  command.addCommand(createAgentStartCommand());
  command.addCommand(createAgentStopCommand());
  command.addCommand(createAgentRestartCommand());
  command.addCommand(createAgentLogsCommand());
  command.addCommand(createAgentShellCommand());
  
  return command;
}
