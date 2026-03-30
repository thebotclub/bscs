import { Command } from 'commander';
import { createVersionCommand } from './version.js';
import { createDoctorCommand } from './doctor/index.js';
import { createAgentCommand } from './agent/index.js';
import { createConfigCommand } from './config/index.js';
import { createFleetCommand } from './fleet/index.js';
import { createMachineCommand } from './machine/index.js';
import { createDashboardCommand } from '../dashboard/server.js';
import { createSecretsCommand } from './secrets/index.js';
import { createCostCommand } from './cost/index.js';
import { createSecurityCommand } from './security/index.js';
import { createMcpCommand } from './mcp/index.js';

// Version is embedded at build time — do NOT replace with a runtime package.json read.
const VERSION = '0.1.0';

// ASCII art logo for --version
const ASCII_LOGO = `
 ██████╗ ███████╗ ██████╗███████╗
 ██╔══██╗██╔════╝██╔════╝██╔════╝
 ██████╔╝███████╗██║     ███████╗
 ██╔══██╗╚════██║██║     ╚════██║
 ██████╔╝███████║╚██████╗███████║
 ╚═════╝ ╚══════╝ ╚═════╝╚══════╝
  Command your AI fleet.
`;

export function createProgram(): Command {
  const program = new Command('bscs')
    .option('--quiet', 'Minimal output')
    .option('--no-color', 'Disable colors')
    .description('Bot Squad Command Suite — CLI for managing fleets of OpenClaw AI agents')
    .hook('preAction', (thisCommand) => {
      // Handle global flags
      const opts = thisCommand.opts();
      if (opts.noColor) {
        process.env.FORCE_COLOR = '0';
      }
    })
    // Enable positional options so subcommands can have their own --json flag
    .enablePositionalOptions()
    .addHelpText('after', `
Examples:
  $ bscs doctor                    Check environment health
  $ bscs agent create my-coder --role coding    Create a coding agent with Tribunal
  $ bscs fleet status --json       Show fleet as JSON
  $ bscs machine bootstrap mini1   Bootstrap a remote machine

Documentation: https://github.com/thebotclub/bscs
`);

  // Custom --version that shows ASCII art
  program.version(VERSION, '-V, --version');
  program.configureOutput({
    writeOut: (str: string) => {
      // Intercept version output
      if (str.trim() === VERSION) {
        console.log(ASCII_LOGO);
        console.log(`  v${VERSION} — Command your AI fleet.\n`);
      } else {
        process.stdout.write(str);
      }
    },
  });

  // Register commands
  program.addCommand(createVersionCommand());
  program.addCommand(createDoctorCommand());
  program.addCommand(createAgentCommand());
  program.addCommand(createConfigCommand());
  program.addCommand(createFleetCommand());
  program.addCommand(createMachineCommand());
  program.addCommand(createDashboardCommand());
  
  // Phase 3 commands
  program.addCommand(createSecretsCommand());
  program.addCommand(createCostCommand());
  
  // Phase 5 commands
  program.addCommand(createSecurityCommand());
  program.addCommand(createMcpCommand());

  return program;
}

export { createVersionCommand };
export { createDoctorCommand };
export { createAgentCommand };
export { createConfigCommand };
export { createFleetCommand };
export { createMachineCommand };
export { createDashboardCommand };
export { createSecretsCommand };
export { createCostCommand };
export { createSecurityCommand };
export { createMcpCommand };
