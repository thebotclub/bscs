import { Command } from 'commander';
import chalk from 'chalk';
import {
  listSecrets,
  checkSecretsHealth,
  syncSecrets,
} from '../../core/secrets.js';

export function createSecretsCommand(): Command {
  const command = new Command('secrets')
    .description('Manage API keys and secrets');

  command.addCommand(createSecretsListCommand());
  command.addCommand(createSecretsSyncCommand());
  command.addCommand(createSecretsHealthCommand());

  return command;
}

function createSecretsListCommand(): Command {
  return new Command('list')
    .description('List configured secrets (redacted)')
    .option('--json', 'Output as JSON')
    .action((options: { json?: boolean }) => {
      const secrets = listSecrets();
      
      if (options.json) {
        console.log(JSON.stringify(secrets, null, 2));
        return;
      }
      console.log(chalk.bold('\nConfigured Secrets:\n'));
      
      if (secrets.length === 0) {
        console.log(chalk.gray('  No secrets configured.'));
        return;
      }

      secrets.forEach((s) => {
        const type = s.status === 'op-reference' ? chalk.blue('[1Password]') : chalk.gray('[inline]');
        const icon = s.status === 'op-reference' ? '🔗' : '⚠️';
        console.log(`  ${icon} ${s.ref.padEnd(40)} ${type}`);
      });
      
      console.log(chalk.gray('\nNote: Values are redacted for security.'));
    });
}

function createSecretsSyncCommand(): Command {
  return new Command('sync')
    .description('Sync secrets from 1Password')
    .action(async () => {
      console.log(chalk.cyan('\nSyncing secrets from 1Password...'));
      
      try {
        const results = await syncSecrets();
        console.log(chalk.green('\n✓ Secrets synced successfully!\n'));
        
        results.forEach((r) => {
          if (r.success) {
            console.log(chalk.green(`  ✓ ${r.ref}`));
          } else {
            console.log(chalk.red(`  ✗ ${r.ref}: ${r.error}`));
          }
        });
      } catch (err) {
        console.error(chalk.red(`\nFailed to sync secrets: ${err}`));
        process.exit(1);
      }
    });
}

function createSecretsHealthCommand(): Command {
  return new Command('health')
    .description('Check health of all secrets')
    .action(async () => {
      console.log(chalk.cyan('\nChecking secret health...'));
      
      const results = await checkSecretsHealth();
      const valid = results.filter((r) => r.status === 'valid');
      const invalid = results.filter((r) => r.status !== 'valid');
      
      console.log(chalk.bold('\nSecret Health Check:\n'));
      console.log(chalk.green(`  ✓ ${valid.length} healthy`));
      
      if (invalid.length > 0) {
        console.log(chalk.red(`  ✗ ${invalid.length} unhealthy`));
        invalid.forEach((r) => {
          console.log(chalk.red(`    - ${r.ref}: ${r.error}`));
        });
      }
    });
}
