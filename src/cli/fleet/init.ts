import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '../../util/logger.js';
import { withErrorHandler } from '../../util/errors.js';

const logger = createLogger('fleet');

interface InitAnswers {
  fleetName: string;
  controller: string;
  image: string;
  portRangeStart: number;
  portRangeEnd: number;
}

function getConfigPath(): string {
  return process.env.BSCS_CONFIG_DIR 
    ? `${process.env.BSCS_CONFIG_DIR}/config.json`
    : `${homedir()}/.config/bscs/config.json`;
}

async function prompt(rl: ReturnType<typeof createInterface>, question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const promptText = defaultValue 
      ? `${question} [${chalk.dim(defaultValue)}]: `
      : `${question}: `;
    rl.question(promptText, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

async function promptNumber(rl: ReturnType<typeof createInterface>, question: string, defaultValue: number): Promise<number> {
  const answer = await prompt(rl, question, String(defaultValue));
  const num = parseInt(answer, 10);
  return isNaN(num) ? defaultValue : num;
}

// Reserved for future use
// async function promptYesNo(rl: ReturnType<typeof createInterface>, question: string, defaultValue: boolean): Promise<boolean> {
//   const defaultStr = defaultValue ? 'Y/n' : 'y/N';
//   const answer = await prompt(rl, question, defaultStr);
//   if (!answer) return defaultValue;
//   return answer.toLowerCase().startsWith('y');
// }

export function createFleetInitCommand(): Command {
  return new Command('init')
    .description('Initialize BSCS configuration with first-run wizard')
    .option('--non-interactive', 'Use defaults without prompting')
    .option('--fleet-name <name>', 'Fleet name')
    .option('--image <image>', 'Default Docker image')
    .action(async (options: { nonInteractive?: boolean; fleetName?: string; image?: string }) => {
      await withErrorHandler(async () => {
      logger.debug({ options }, 'Initializing fleet');
      
      const configPath = getConfigPath();
      
      // Check if config already exists
      if (existsSync(configPath)) {
        console.log(chalk.yellow('Configuration already exists at:'), configPath);
        console.log(chalk.dim('Run "bscs fleet status" to see your fleet.'));
        return;
      }
      
      let answers: InitAnswers;
      
      if (options.nonInteractive) {
        // Use defaults or provided options
        answers = {
          fleetName: options.fleetName || 'my-fleet',
          controller: 'localhost',
          image: options.image || 'openclaw-fleet:latest',
          portRangeStart: 19000,
          portRangeEnd: 19999,
        };
      } else {
        // Interactive wizard
        console.log(chalk.bold.cyan('\n🚀 BSCS Fleet Initialization\n'));
        console.log(chalk.dim('This wizard will help you set up your fleet configuration.\n'));
        
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        
        try {
          const fleetName = await prompt(rl, chalk.white('Fleet name'), 'my-fleet');
          const controller = await prompt(rl, chalk.white('Controller machine hostname'), 'localhost');
          const image = await prompt(rl, chalk.white('Default Docker image'), 'openclaw-fleet:latest');
          
          console.log(chalk.dim('\nPort range for agent containers:'));
          const portRangeStart = await promptNumber(rl, chalk.white('Start port'), 19000);
          const portRangeEnd = await promptNumber(rl, chalk.white('End port'), 19999);
          
          answers = {
            fleetName,
            controller,
            image,
            portRangeStart,
            portRangeEnd,
          };
        } finally {
          rl.close();
        }
      }
      
      // Build config
      const config = {
        version: '1.0',
        fleet: {
          name: answers.fleetName,
          controller: answers.controller,
        },
        machines: {
          localhost: {
            host: 'localhost',
            user: process.env.USER || 'user',
            role: 'controller',
          },
        },
        docker: {
          image: answers.image,
        },
        defaults: {
          image: answers.image,
          portRange: {
            start: answers.portRangeStart,
            end: answers.portRangeEnd,
          },
        },
        agents: {},
      };
      
      // Create config directory
      const configDir = dirname(configPath);
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
        console.log(chalk.dim(`\nCreated config directory: ${configDir}`));
      }
      
      // Write config
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      
      console.log(chalk.green('\n✓ Fleet initialized successfully!\n'));
      console.log(chalk.bold('Configuration:'), configPath);
      console.log(chalk.bold('Fleet name:'), answers.fleetName);
      console.log(chalk.bold('Default image:'), answers.image);
      console.log(chalk.bold('Port range:'), `${answers.portRangeStart}-${answers.portRangeEnd}`);
      console.log();
      console.log(chalk.dim('Next steps:'));
      console.log(chalk.dim('  1. Run "bscs agent create <name>" to create your first agent'));
      console.log(chalk.dim('  2. Run "bscs fleet status" to see your fleet'));
      console.log(chalk.dim('  3. Run "bscs dashboard" to launch the web UI'));
      
      logger.info({ configPath, fleetName: answers.fleetName }, 'Fleet initialized');
      });
    });
}

export function createFleetImportCommand(): Command {
  return new Command('import')
    .description('Import configuration from legacy fleet.sh')
    .option('--from-fleet-sh <path>', 'Path to fleet.sh config directory')
    .option('--dry-run', 'Show what would be imported without making changes')
    .action(async (options: { fromFleetSh?: string; dryRun?: boolean }) => {
      await withErrorHandler(async () => {
      logger.debug({ options }, 'Importing from fleet.sh');
      
      if (!options.fromFleetSh) {
        console.error(chalk.red('Error: --from-fleet-sh path is required'));
        console.log(chalk.dim('\nUsage: bscs fleet import --from-fleet-sh ~/.fleet'));
        process.exit(1);
      }
      
      const fleetShPath = options.fromFleetSh;
      
      // Check if fleet.sh config exists
      if (!existsSync(fleetShPath)) {
        console.error(chalk.red(`Error: Fleet.sh config not found at ${fleetShPath}`));
        process.exit(1);
      }
      
      // Try to parse fleet.sh config (it's typically bash with variables)
      // We'll look for common patterns
      const configFiles = [
        `${fleetShPath}/config`,
        `${fleetShPath}/config.sh`,
        `${fleetShPath}/.fleetrc`,
      ];
      
      let foundConfig = '';
      for (const f of configFiles) {
        if (existsSync(f)) {
          foundConfig = f;
          break;
        }
      }
      
      if (!foundConfig) {
        console.error(chalk.red('Error: Could not find fleet.sh config file'));
        console.log(chalk.dim('Expected one of: ' + configFiles.join(', ')));
        process.exit(1);
      }
      
      console.log(chalk.dim(`Found config at: ${foundConfig}`));
      
      // Parse bash config - extract AGENTS array and other variables
      const configContent = readFileSync(foundConfig, 'utf-8');
      
      // Simple parsing for common fleet.sh patterns
      const agents: Record<string, { name: string; image?: string; ports?: { gateway?: number; remote?: number } }> = {};
      
      // Look for AGENTS=("agent1" "agent2") pattern
      const agentsMatch = configContent.match(/AGENTS=\(([^)]+)\)/);
      if (agentsMatch) {
        const agentNames = agentsMatch[1]!.match(/"([^"]+)"/g);
        if (agentNames) {
          for (let i = 0; i < agentNames.length; i++) {
            const name = agentNames[i]!.replace(/"/g, '');
            const basePort = 19000 + (i * 2);
            agents[name] = {
              name,
              ports: { gateway: basePort, remote: basePort + 1 },
            };
          }
        }
      }
      
      // Look for IMAGE= pattern
      const imageMatch = configContent.match(/IMAGE=["']?([^"'\n]+)["']?/);
      const image = imageMatch ? imageMatch[1]!.trim() : 'openclaw-fleet:latest';
      
      // Look for FLEET_NAME= pattern
      const fleetNameMatch = configContent.match(/FLEET_NAME=["']?([^"'\n]+)["']?/);
      const fleetName = fleetNameMatch ? fleetNameMatch[1]!.trim() : 'imported-fleet';
      
      const config = {
        version: '1.0',
        fleet: {
          name: fleetName,
          controller: 'localhost',
        },
        machines: {
          localhost: {
            host: 'localhost',
            user: process.env.USER || 'user',
            role: 'controller',
          },
        },
        docker: {
          image,
        },
        defaults: {
          image,
          portRange: {
            start: 19000,
            end: 19999,
          },
        },
        agents,
      };
      
      if (options.dryRun) {
        console.log(chalk.bold('\n📋 Import Preview (dry-run)\n'));
        console.log(chalk.dim('Fleet name:'), fleetName);
        console.log(chalk.dim('Default image:'), image);
        console.log(chalk.dim('Agents found:'), Object.keys(agents).length);
        console.log();
        console.log(chalk.bold('Agents:'));
        for (const [name, agent] of Object.entries(agents)) {
          console.log(`  - ${name}${agent.ports ? ` (ports: ${agent.ports.gateway}/${agent.ports.remote})` : ''}`);
        }
        console.log();
        console.log(chalk.dim('Run without --dry-run to apply changes.'));
        console.log(chalk.dim('\nGenerated config:'));
        console.log(JSON.stringify(config, null, 2));
        return;
      }
      
      // Write config
      const configPath = getConfigPath();
      const configDir = dirname(configPath);
      
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }
      
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      
      console.log(chalk.green('\n✓ Fleet configuration imported!\n'));
      console.log(chalk.bold('Configuration:'), configPath);
      console.log(chalk.bold('Agents imported:'), Object.keys(agents).length);
      console.log();
      console.log(chalk.dim('Note: Containers were not created. Run "bscs fleet reconcile" to create them.'));
      
      logger.info({ configPath, agentCount: Object.keys(agents).length }, 'Fleet imported');
      });
    });
}
