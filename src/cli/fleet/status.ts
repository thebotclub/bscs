import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../core/config.js';
import { listBscsContainers, type ContainerInfo } from '../../core/docker.js';
import {
  pullImage,
  createContainer,
  startContainer,
  stopContainer,
  removeContainer,
} from '../../core/docker.js';
import { withErrorHandler } from '../../util/errors.js';

// Import the SSH-aware getFleetStatus from core — single implementation for both CLI and dashboard.
import {
  getFleetStatus,
  type FleetAgentStatus,
  type FleetStatusResult,
} from '../../core/fleet.js';

// Re-export so existing callers continue to work.
export { getFleetStatus, type FleetAgentStatus, type FleetStatusResult };

export function createFleetStatusCommand(): Command {
  return new Command('status')
    .description('Show fleet status - all agents across machines')
    .option('--all', 'Include all containers')
    .option('--json', 'Output as JSON')
    .action(async (options: { all?: boolean; json?: boolean }) => {
      await withErrorHandler(async () => {
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
        console.log(
          chalk.bold(`   Summary:`) +
            chalk.green(`${status.summary.running} running`) +
            ', ' +
            chalk.red(`${status.summary.stopped} stopped`) +
            ', ' +
            chalk.gray(`${status.summary.unknown} other`),
        );
        console.log();

        if (status.agents.length === 0) {
          console.log(chalk.dim('   No agents configured'));
          console.log(chalk.dim('   Run "bscs fleet init" to get started'));
          return;
        }

        console.log(chalk.bold('   Agents:'));
        for (const agent of status.agents) {
          const icon =
            agent.status === 'running'
              ? chalk.green('●')
              : agent.status === 'stopped'
                ? chalk.red('○')
                : chalk.gray('?');
          const ports = agent.ports
            ? `${agent.ports.gateway || '-'}/${agent.ports.remote || '-'}`
            : '-';
          console.log(`   ${icon} ${agent.name} ${agent.status} ${ports}`);
        }
      } catch (err) {
        console.error(chalk.red('Failed to get fleet status'), err);
        process.exit(1);
      }
      });
    });
}

export function createFleetReconcileCommand(): Command {
  const cmd = new Command('reconcile')
    .description('Ensure running containers match configuration')
    .option('--dry-run', 'Show changes without applying')
    .option('--json', 'Output as JSON')
    .action(async (options: { dryRun?: boolean; json?: boolean }) => {
      await withErrorHandler(async () => {
      const config = loadConfig();
      const changes: Array<{ action: string; agent: string; reason: string }> = [];

      let containers: ContainerInfo[] = [];
      try {
        containers = await listBscsContainers();
      } catch (err) {
        console.error(chalk.red('Could not list containers'), err);
        process.exit(1);
      }

      const containerMap = new Map(containers.map((c) => [c.name.replace('openclaw_', ''), c]));

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
          reason: 'Orphaned',
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
        const icon =
          c.action === 'create' ? chalk.dim('+') : c.action === 'start' ? chalk.dim('▶') : chalk.red('■');
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
    });

  return cmd;
}
