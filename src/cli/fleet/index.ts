import { Command } from 'commander';
import chalk from 'chalk';
import { createFleetInitCommand, createFleetImportCommand } from './init.js';
import { createFleetStatusCommand, createFleetReconcileCommand } from './status.js';
import { startWatchdogDaemon, checkHealth, type HealthCheckResult } from '../../core/watchdog.js';

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

export function createFleetCommand(): Command {
  const command = new Command('fleet')
    .description('Manage the agent fleet');
  
  command.addCommand(createFleetInitCommand());
  command.addCommand(createFleetImportCommand());
  command.addCommand(createFleetStatusCommand());
  command.addCommand(createFleetReconcileCommand());
  command.addCommand(createFleetWatchdogCommand());
  
  return command;
}

// Re-export for use by other modules
export { getFleetStatus, type FleetStatusResult, type FleetAgentStatus } from './status.js';
