import { Command } from 'commander';
import chalk from 'chalk';
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
import { loadConfig, saveConfig } from '../../core/config.js';
import {
  allocatePorts,
  setupTribunal,
  type TribunalSetupResult,
  getResourcesForRole,
  getModelForRole,
  addCronJob,
  removeCronJob,
  listCronJobs,
  addSkill,
  removeSkill,
  listSkills,
  setIdentity,
} from '../../core/agent.js';
import { createLogger } from '../../util/logger.js';
import { withErrorHandler } from '../../util/errors.js';
import { requireDocker } from '../../util/docker-check.js';
import type { AgentRole } from '../../util/types.js';

const logger = createLogger('agent');

export function createAgentCreateCommand(): Command {
  return new Command('create')
    .description('Create a new agent container')
    .argument('<name>', 'Agent name')
    .option('-i, --image <image>', 'Docker image to use')
    .option('-r, --role <role>', 'Agent role (coding, brain, review, security, ops, custom)', 'custom')
    .option('-m, --model <model>', 'Model to use (overrides role default)')
    .option('--runtime <runtime>', 'Runtime type (docker, native, openclaw)', 'docker')
    .option('--bind <bindings...>', 'Channel bindings for openclaw (format: type:accountId)')
    .option('--gateway-url <url>', 'OpenClaw gateway URL (for --runtime openclaw)')
    .option('--no-start', 'Create without starting')
    .option('--dry-run', 'Preview what would be created without making changes')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { 
      image?: string; 
      role: AgentRole;
      model?: string;
      runtime: string;
      bind?: string[];
      gatewayUrl?: string;
      noStart?: boolean; 
      dryRun?: boolean;
      json?: boolean;
    }) => {
      await withErrorHandler(async () => {
      const { role, model, runtime, noStart, dryRun, json } = options;

      // ── OpenClaw runtime path ──
      if (runtime === 'openclaw') {
        const gatewayUrl = options.gatewayUrl || 'http://127.0.0.1:18777';

        // Validate gateway URL
        try {
          const parsed = new URL(gatewayUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            console.error(chalk.red(`Invalid gateway URL protocol "${parsed.protocol}". Only http: and https: are supported.`));
            process.exit(1);
          }
        } catch {
          console.error(chalk.red(`Invalid gateway URL "${gatewayUrl}". Must be a valid URL.`));
          process.exit(1);
        }
        const bindings = (options.bind || []).map((b) => {
          const [type, ...rest] = b.split(':');
          const accountId = rest.join(':');
          if (!type || !accountId || (type !== 'telegram' && type !== 'discord')) {
            console.error(chalk.red(`Invalid binding "${b}". Format: telegram:accountId or discord:accountId`));
            process.exit(1);
          }
          return { type: type as 'telegram' | 'discord', accountId };
        });

        logger.debug({ name, role, model, gatewayUrl, bindings }, 'Creating openclaw agent');

        const config = loadConfig();
        if (config.agents?.[name]) {
          console.error(chalk.red(`Agent "${name}" already exists`));
          process.exit(1);
        }

        if (dryRun) {
          console.log(chalk.cyan('\n🔍 Dry run - preview of openclaw agent creation:\n'));
          console.log(chalk.dim(`Name:       ${name}`));
          console.log(chalk.dim(`Role:       ${role}`));
          console.log(chalk.dim(`Runtime:    openclaw`));
          console.log(chalk.dim(`Gateway:    ${gatewayUrl}`));
          console.log(chalk.dim(`Model:      ${model || 'default'}`));
          if (bindings.length > 0) {
            console.log(chalk.dim(`Channels:   ${bindings.map((b) => `${b.type}:${b.accountId}`).join(', ')}`));
          }
          console.log(chalk.green('\nTo actually create, run without --dry-run'));
          return;
        }

        try {
          const { getRuntime: getRT } = await import('../../core/runtime/index.js');
          const rt = getRT('openclaw', { gatewayUrl }) as import('../../core/runtime/openclaw.js').OpenClawRuntime;
          await rt.create(name, { image: '' });

          // Bind channels
          for (const binding of bindings) {
            await rt.bindChannel(name, binding.type, binding.accountId);
          }

          // Save to config
          config.agents = config.agents || {};
          config.agents[name] = {
            name,
            role,
            template: role === 'coding' ? 'coding' : 'custom',
            machine: 'localhost',
            image: '',
            runtime: 'openclaw',
            created: new Date().toISOString(),
            status: 'running',
            openclaw: {
              gatewayUrl,
              workspace: name,
              channels: bindings,
              model: model ? { primary: model } : undefined,
            },
          };
          if (model) {
            config.agents[name]!.model = model;
          }
          saveConfig(config);

          const result = { name, runtime: 'openclaw', role, model, gatewayUrl, channels: bindings, status: 'running' };
          if (json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(chalk.green(`✓ OpenClaw agent "${name}" created`));
            if (bindings.length > 0) {
              console.log(chalk.dim(`  Channels: ${bindings.map((b) => `${b.type}:${b.accountId}`).join(', ')}`));
            }
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Failed to create openclaw agent: ${message}`));
          process.exit(1);
        }
        return;
      }

      // ── Docker runtime path (existing logic) ──
      await requireDocker();
      
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
      await withErrorHandler(async () => {
      await requireDocker();
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
    });
}

export function createAgentStatusCommand(): Command {
  return new Command('status')
    .description('Show agent status')
    .argument('[name]', 'Agent name (omit for all agents)')
    .option('--json', 'Output as JSON')
    .action(async (name?: string, options?: { json?: boolean }) => {
      await withErrorHandler(async () => {
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
      await withErrorHandler(async () => {
      await requireDocker();
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
    });
}

export function createAgentStopCommand(): Command {
  return new Command('stop')
    .description('Stop an agent container')
    .argument('<name>', 'Agent name')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      await withErrorHandler(async () => {
      await requireDocker();
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
    });
}

export function createAgentRestartCommand(): Command {
  return new Command('restart')
    .description('Restart an agent container')
    .argument('<name>', 'Agent name')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      await withErrorHandler(async () => {
      await requireDocker();
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
    });
}

export function createAgentLogsCommand(): Command {
  return new Command('logs')
    .description('Show agent container logs')
    .argument('<name>', 'Agent name')
    .option('-f, --follow', 'Follow log output')
    .option('--tail <lines>', 'Number of lines to show from end', '100')
    .action(async (name: string, options: { follow?: boolean; tail: string }) => {
      await withErrorHandler(async () => {
      await requireDocker();
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
    });
}

export function createAgentShellCommand(): Command {
  return new Command('shell')
    .description('Open a shell in an agent container')
    .argument('<name>', 'Agent name')
    .action(async (name: string) => {
      await withErrorHandler(async () => {
      await requireDocker();
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
    });
}

// ── Channel Bind/Unbind Commands ──────────────────────────────────────

export function createAgentBindCommand(): Command {
  return new Command('bind')
    .description('Bind a channel to an OpenClaw agent')
    .argument('<name>', 'Agent name')
    .requiredOption('--channel <type>', 'Channel type (telegram, discord)')
    .requiredOption('--account-id <id>', 'Channel account ID')
    .action(async (name: string, options: { channel: string; accountId: string }) => {
      await withErrorHandler(async () => {
      const channelType = options.channel;
      if (channelType !== 'telegram' && channelType !== 'discord') {
        console.error(chalk.red(`Invalid channel type "${channelType}". Must be "telegram" or "discord".`));
        process.exit(1);
      }

      const { bindChannel } = await import('../../core/agent.js');
      await bindChannel(name, channelType, options.accountId);
      console.log(chalk.green(`✓ Bound ${channelType} channel to agent "${name}"`));
      });
    });
}

export function createAgentUnbindCommand(): Command {
  return new Command('unbind')
    .description('Unbind a channel from an OpenClaw agent')
    .argument('<name>', 'Agent name')
    .requiredOption('--channel <type>', 'Channel type (telegram, discord)')
    .action(async (name: string, options: { channel: string }) => {
      await withErrorHandler(async () => {
      const channelType = options.channel;
      if (channelType !== 'telegram' && channelType !== 'discord') {
        console.error(chalk.red(`Invalid channel type "${channelType}". Must be "telegram" or "discord".`));
        process.exit(1);
      }

      const { unbindChannel } = await import('../../core/agent.js');
      await unbindChannel(name, channelType);
      console.log(chalk.green(`✓ Unbound ${channelType} channel from agent "${name}"`));
      });
    });
}

// Create the agent command group
export function createAgentCronCommand(): Command {
  const command = new Command('cron')
    .description('Manage cron jobs for an openclaw agent');

  command.addCommand(
    new Command('add')
      .description('Add a cron job')
      .argument('<name>', 'Agent name')
      .requiredOption('--id <id>', 'Unique cron job identifier')
      .requiredOption('--cron <expression>', 'Cron expression')
      .requiredOption('--message <message>', 'Message to send on schedule')
      .option('--channel <channel>', 'Target channel')
      .action(async (name: string, options: { id: string; cron: string; message: string; channel?: string }) => {
        await withErrorHandler(async () => {
          addCronJob(name, { id: options.id, cron: options.cron, message: options.message, channel: options.channel });
          console.log(chalk.green(`✓ Cron job "${options.id}" added to agent "${name}"`));
        });
      }),
  );

  command.addCommand(
    new Command('list')
      .description('List cron jobs for an agent')
      .argument('<name>', 'Agent name')
      .option('--json', 'Output as JSON')
      .action(async (name: string, options: { json?: boolean }) => {
        await withErrorHandler(async () => {
          const jobs = listCronJobs(name);
          if (options.json) {
            console.log(JSON.stringify(jobs, null, 2));
          } else if (jobs.length === 0) {
            console.log(chalk.dim('No cron jobs configured'));
          } else {
            for (const job of jobs) {
              console.log(`  ${chalk.cyan(job.id)}  ${chalk.dim(job.cron)}  ${job.message}${job.channel ? chalk.dim(` → ${job.channel}`) : ''}`);
            }
          }
        });
      }),
  );

  command.addCommand(
    new Command('remove')
      .description('Remove a cron job')
      .argument('<name>', 'Agent name')
      .requiredOption('--id <id>', 'Cron job identifier to remove')
      .action(async (name: string, options: { id: string }) => {
        await withErrorHandler(async () => {
          removeCronJob(name, options.id);
          console.log(chalk.green(`✓ Cron job "${options.id}" removed from agent "${name}"`));
        });
      }),
  );

  return command;
}

export function createAgentSkillsCommand(): Command {
  const command = new Command('skills')
    .description('Manage skills for an openclaw agent');

  command.addCommand(
    new Command('add')
      .description('Add a skill to an agent')
      .argument('<name>', 'Agent name')
      .argument('<skill>', 'Skill name')
      .action(async (name: string, skill: string) => {
        await withErrorHandler(async () => {
          addSkill(name, skill);
          console.log(chalk.green(`✓ Skill "${skill}" added to agent "${name}"`));
        });
      }),
  );

  command.addCommand(
    new Command('list')
      .description('List skills for an agent')
      .argument('<name>', 'Agent name')
      .option('--json', 'Output as JSON')
      .action(async (name: string, options: { json?: boolean }) => {
        await withErrorHandler(async () => {
          const skills = listSkills(name);
          if (options.json) {
            console.log(JSON.stringify(skills, null, 2));
          } else if (skills.length === 0) {
            console.log(chalk.dim('No skills configured'));
          } else {
            for (const skill of skills) {
              console.log(`  ${chalk.cyan('•')} ${skill}`);
            }
          }
        });
      }),
  );

  command.addCommand(
    new Command('remove')
      .description('Remove a skill from an agent')
      .argument('<name>', 'Agent name')
      .argument('<skill>', 'Skill name')
      .action(async (name: string, skill: string) => {
        await withErrorHandler(async () => {
          removeSkill(name, skill);
          console.log(chalk.green(`✓ Skill "${skill}" removed from agent "${name}"`));
        });
      }),
  );

  return command;
}

export function createAgentIdentityCommand(): Command {
  return new Command('identity')
    .description('Set agent identity (display name + emoji)')
    .argument('<name>', 'Agent name')
    .requiredOption('--name <displayName>', 'Display name')
    .requiredOption('--emoji <emoji>', 'Emoji character')
    .action(async (agentName: string, options: { name: string; emoji: string }) => {
      await withErrorHandler(async () => {
        setIdentity(agentName, options.name, options.emoji);
        console.log(chalk.green(`✓ Identity set for agent "${agentName}": ${options.emoji} ${options.name}`));
      });
    });
}

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
  command.addCommand(createAgentBindCommand());
  command.addCommand(createAgentUnbindCommand());
  command.addCommand(createAgentCronCommand());
  command.addCommand(createAgentSkillsCommand());
  command.addCommand(createAgentIdentityCommand());
  
  return command;
}
