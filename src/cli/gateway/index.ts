import { Command } from 'commander';
import chalk from 'chalk';
import { startGateway } from '../../core/gateway.js';
import { formatOutput } from '../../util/output.js';

export function createGatewayStartCommand(): Command {
  return new Command('start')
    .description('Start the LLM Gateway proxy')
    .option('-p, --port <port>', 'Port to listen on', '18999')
    .option('-b, --bind <address>', 'Address to bind to', '127.0.0.1')
    .option('--json', 'JSON output')
    .action(async (options: { port: string; bind: string; json?: boolean }) => {
      const port = parseInt(options.port, 10);

      if (options.json) {
        const gw = await startGateway(port, options.bind);
        console.log(formatOutput({ status: 'running', port: gw.port, bind: options.bind }, { json: true }));
      } else {
        console.log(chalk.bold.cyan('\n⚡ BSCS LLM Gateway\n'));
        console.log(chalk.dim(`  Binding: ${options.bind}:${port}`));
        console.log(chalk.dim('  Endpoint: POST /v1/chat/completions'));
        console.log(chalk.dim('  Health:   GET  /health'));
        console.log();

        const gw = await startGateway(port, options.bind);
        console.log(
          chalk.green(`  ✓ Gateway running on http://${options.bind}:${gw.port}\n`)
        );
        console.log(chalk.dim('  Configure agents to use:'));
        console.log(chalk.white(`    OPENAI_BASE_URL=http://127.0.0.1:${gw.port}/v1\n`));
        console.log(chalk.dim('  Press Ctrl+C to stop\n'));
      }

      // Keep process alive
      process.on('SIGINT', () => {
        console.log(chalk.dim('\n  Gateway stopped'));
        process.exit(0);
      });
    });
}

export function createGatewayStatusCommand(): Command {
  return new Command('status')
    .description('Check if the gateway is running')
    .option('-p, --port <port>', 'Port to check', '18999')
    .option('--json', 'JSON output')
    .action(async (options: { port: string; json?: boolean }) => {
      const port = parseInt(options.port, 10);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          if (options.json) {
            console.log(formatOutput({ running: true, port, ...data }, { json: true }));
          } else {
            console.log(chalk.green(`\n  ✓ Gateway running on port ${port}\n`));
          }
        } else {
          throw new Error('Unhealthy');
        }
      } catch {
        if (options.json) {
          console.log(formatOutput({ running: false, port }, { json: true }));
        } else {
          console.log(chalk.red(`\n  ✗ Gateway not running on port ${port}\n`));
        }
        process.exitCode = 1;
      }
    });
}

export function createGatewayCommand(): Command {
  const command = new Command('gateway')
    .description('LLM Gateway — proxy for routing, retries, fallbacks, and cost logging');

  command.addCommand(createGatewayStartCommand());
  command.addCommand(createGatewayStatusCommand());

  return command;
}
