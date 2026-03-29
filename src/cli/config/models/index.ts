import { Command } from 'commander';
import chalk from 'chalk';
import {
  listProviders,
  addProvider,
  removeProvider,
  providersStatus,
  showDefaults,
  showFallbacks,
} from '../../../core/models.js';

export function createConfigModelsCommand(): Command {
  const command = new Command('models')
    .description('Manage model providers and defaults');

  // Providers subcommands
  const providers = new Command('providers')
    .description('Manage AI providers');
  
  providers.command('list')
    .description('List all configured providers')
    .action(() => {
      const providerList = listProviders();
      console.log(chalk.bold('\nConfigured Providers:\n'));
      
      if (providerList.length === 0) {
        console.log(chalk.gray('  No providers configured.'));
        return;
      }

      providerList.forEach((p) => {
        const status = p.enabled ? chalk.green('●') : chalk.gray('○');
        const type = chalk.cyan(p.type);
        const local = p.local ? chalk.blue(' (local)') : '';
        console.log(`  ${p.name.padEnd(20)} ${type}${local} ${status}`);
      });
    });

  providers.command('add <name>')
    .description('Add a new provider')
    .requiredOption('-t, --type <type>', 'Provider type (anthropic, openai, google, ollama, llamacpp)')
    .requiredOption('-k, --api-key <key>', 'API key or op:// reference')
    .option('--base-url <url>', 'Base URL for local providers')
    .option('--local', 'Mark as local provider')
    .option('--gpu', 'Mark as GPU-enabled')
    .action((name, options) => {
      addProvider(name, options);
      console.log(chalk.green(`✓ Provider "${name}" added`));
    });

  providers.command('remove <name>')
    .description('Remove a provider')
    .action((name) => {
      removeProvider(name);
      console.log(chalk.green(`✓ Provider "${name}" removed`));
    });

  providers.command('status')
    .description('Health check all providers')
    .action(async () => {
      const results = await providersStatus();
      console.log(chalk.bold('\nProvider Health Status:\n'));
      
      results.forEach((r) => {
        const icon = r.status === 'healthy' ? chalk.green('●') : 
                        r.status === 'unhealthy' ? chalk.red('○') : chalk.gray('?');
        const local = r.local ? ' (local)' : '';
        console.log(`  ${r.name.padEnd(20)} ${icon} ${r.status}${local} ${r.error ? ` - ${r.error}` : ''}`);
      });
    });

  command.addCommand(providers);

  // Defaults subcommands
  const defaults = new Command('defaults')
    .description('Manage model defaults by role');
  
  defaults.command('show')
    .description('Show model defaults by role')
    .action(() => {
      const defaultsList = showDefaults();
      console.log(chalk.bold('\nModel Defaults by Role:\n'));
      
      Object.entries(defaultsList).forEach(([role, model]) => {
        console.log(chalk.cyan(`  ${role.padEnd(15)}: ${model}`));
      });
    });

  command.addCommand(defaults);

  // Fallbacks subcommands
  const fallbacks = new Command('fallbacks')
    .description('Manage fallback chains');
  
  fallbacks.command('show')
    .description('Show fallback chains')
    .action(() => {
      const fallbacksList = showFallbacks();
      console.log(chalk.bold('\nFallback Chains:\n'));
      
      if (Object.keys(fallbacksList).length === 0) {
        console.log(chalk.gray('  No fallback chains configured.'));
        return;
      }

      Object.entries(fallbacksList).forEach(([role, chain]) => {
        console.log(chalk.cyan(`  ${role.padEnd(15)}: ${chain.join(' -> ')}`));
      });
    });

  command.addCommand(fallbacks);

  return command;
}
