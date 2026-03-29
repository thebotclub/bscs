import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, saveConfig, getConfigPathString } from '../../core/config.js';
import { createConfigModelsCommand } from './models/index.js';

export function createConfigShowCommand(): Command {
  return new Command('show')
    .description('Show current configuration')
    .option('--json', 'Output as JSON')
    .action((options) => {
      const config = loadConfig();
      
      if (options.json) {
        console.log(JSON.stringify(config, null, 2));
      } else {
        console.log(chalk.bold('\nBSCS Configuration\n'));
        console.log(JSON.stringify(config, null, 2));
      }
    });
}

export function createConfigPathCommand(): Command {
  return new Command('path')
    .description('Print configuration file path')
    .action(() => {
      console.log(getConfigPathString());
    });
}

export function createConfigSetCommand(): Command {
  return new Command('set')
    .description('Set a configuration value')
    .argument('<key>', 'Configuration key (dot-notation)')
    .argument('[value]', 'Value to set')
    .action((key: string, value?: string) => {
      const config = loadConfig();
      
      // Parse the key path
      const keys = key.split('.');
      
      // Navigate to the parent object
      let current: Record<string, unknown> = config as Record<string, unknown>;
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (!k) continue;
        if (!(k in current)) {
          current[k] = {};
        }
        current = current[k] as Record<string, unknown>;
      }
      
      // Set the value
      const lastKey = keys[keys.length - 1];
      if (!lastKey) {
        console.error(chalk.red('Invalid key'));
        process.exit(1);
      }
      
      // Try to parse as JSON, otherwise use as string
      let parsedValue: unknown = value;
      if (value !== undefined) {
        try {
          parsedValue = JSON.parse(value);
        } catch {
          // Keep as string
        }
      }
      
      current[lastKey] = parsedValue;
      
      saveConfig(config);
      console.log(chalk.green(`✓ Set ${key} = ${JSON.stringify(parsedValue)}`));
    });
}

// Create the config command group
export function createConfigCommand(): Command {
  const command = new Command('config')
    .description('Manage BSCS configuration');
  
  command.addCommand(createConfigShowCommand());
  command.addCommand(createConfigPathCommand());
  command.addCommand(createConfigSetCommand());
  
  // Add models subcommand (Phase 3)
  command.addCommand(createConfigModelsCommand());
  
  return command;
}
