import { Command } from 'commander';
import chalk from 'chalk';
import { createFleetInitCommand, createFleetImportCommand } from './init.js';
import { createFleetStatusCommand, createFleetReconcileCommand } from './status.js';
import { startWatchdogDaemon, checkHealth, type HealthCheckResult } from '../../core/watchdog.js';
import { syncFleetStatus } from '../../core/fleet.js';
import { formatTable } from '../../util/output.js';
import { loadConfig } from '../../core/config.js';
import { withErrorHandler } from '../../util/errors.js';

function createFleetWatchdogCommand(): Command {
  return new Command('watchdog')
    .description('Start the health monitoring daemon')
    .option('-i, --interval <seconds>', 'Check interval in seconds', '30')
    .option('--max-restarts <n>', 'Max restarts per agent', '3')
    .option('--once', 'Run a single health check and exit')
    .action(async (options: { interval: string; maxRestarts: string; once?: boolean }) => {
      if (options.once) {
        const results = await checkHealth();
        const unhealthy = results.filter((r) => r.restartNeeded);
        if (results.length === 0) {
          console.log(chalk.dim('  No agents configured'));
        } else {
          for (const r of results) {
            const icon = r.status === 'healthy' ? chalk.green('✓') : chalk.red('✗');
            console.log(`  ${icon} ${r.name}: ${r.status} (${r.containerStatus})`);
          }
          if (unhealthy.length > 0) {
            console.log(chalk.yellow(`\n  ${unhealthy.length} agent(s) need attention`));
          } else {
            console.log(chalk.green('\n  All agents healthy'));
          }
        }
        return;
      }

      const interval = parseInt(options.interval, 10);
      const maxRestarts = parseInt(options.maxRestarts, 10);

      console.log(chalk.bold.cyan('\n🐕 BSCS Watchdog\n'));
      console.log(chalk.dim(`  Interval: ${interval}s`));
      console.log(chalk.dim(`  Max restarts: ${maxRestarts}`));
      console.log(chalk.dim('  Press Ctrl+C to stop\n'));

      const daemon = startWatchdogDaemon(
        { interval, maxRestarts, cooldownMs: 60000 },
        (results: HealthCheckResult[]) => {
          const healthy = results.filter((r) => r.status === 'healthy').length;
          const unhealthy = results.filter((r) => r.restartNeeded).length;
          const ts = new Date().toISOString().slice(11, 19);
          console.log(
            chalk.dim(`  [${ts}]`) +
            ` ${chalk.green(`${healthy} healthy`)}` +
            (unhealthy > 0 ? `, ${chalk.red(`${unhealthy} unhealthy`)}` : ''),
          );
        },
      );

      process.on('SIGINT', () => {
        daemon.stop();
        console.log(chalk.dim('\n  Watchdog stopped'));
        process.exit(0);
      });

      // Keep alive
      await new Promise(() => {});
    });
}

function createFleetSyncCommand(): Command {
  return new Command('sync')
    .description('Update agent statuses from live gateway state')
    .option('--dry-run', 'Show changes without writing config')
    .option('--json', 'Output as JSON')
    .action(async (options: { dryRun?: boolean; json?: boolean }) => {
      await withErrorHandler(async () => {
        const result = await syncFleetStatus({ dryRun: options.dryRun });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.updated.length === 0 && result.errors.length === 0) {
          console.log(chalk.green('\n✓ All agent statuses in sync\n'));
          return;
        }

        console.log();
        console.log(chalk.bold.cyan('🔄 Fleet Sync'));
        if (options.dryRun) console.log(chalk.dim('   (dry-run)'));
        console.log();

        if (result.updated.length > 0) {
          const config = loadConfig();
          const rows = result.updated.map((name) => {
            const currentStatus = config.agents?.[name]?.status || 'unknown';
            // In dry-run mode the config still has the old value
            return [name, currentStatus, chalk.green('live')];
          });
          console.log(formatTable(['Agent', 'Config Status', '→ Live Status'], rows));
          console.log();
        }

        if (result.unchanged.length > 0) {
          console.log(chalk.dim(`  ${result.unchanged.length} unchanged`));
        }

        if (result.errors.length > 0) {
          console.log();
          for (const err of result.errors) {
            console.log(chalk.yellow(`  ⚠ ${err}`));
          }
        }

        if (options.dryRun && result.updated.length > 0) {
          console.log(chalk.dim('\nRun without --dry-run to apply.\n'));
        } else if (result.updated.length > 0) {
          console.log(chalk.green(`\n✓ Updated ${result.updated.length} agent status(es)\n`));
        }
      });
    });
}

export function createFleetCommand(): Command {
  const command = new Command('fleet')
    .description('Manage the agent fleet');
  
  command.addCommand(createFleetInitCommand());
  command.addCommand(createFleetImportCommand());
  command.addCommand(createFleetStatusCommand());
  command.addCommand(createFleetReconcileCommand());
  command.addCommand(createFleetSyncCommand());
  command.addCommand(createFleetWatchdogCommand());
  
  return command;
}

// Re-export for use by other modules
export { getFleetStatus, type FleetStatusResult, type FleetAgentStatus } from './status.js';
