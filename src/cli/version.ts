import { Command } from 'commander';
import chalk from 'chalk';

const VERSION = '0.1.0';

const ASCII_LOGO = `
 ██████╗ ███████╗ ██████╗███████╗
 ██╔══██╗██╔════╝██╔════╝██╔════╝
 ██████╔╝███████╗██║     ███████╗
 ██╔══██╗╚════██║██║     ╚════██║
 ██████╔╝███████║╚██████╗███████║
 ╚═════╝ ╚══════╝ ╚═════╝╚══════╝
  Command your AI fleet.
`;

export function createVersionCommand(): Command {
  const command = new Command('version')
    .description('Print version information with ASCII art')
    .action(() => {
      console.log(chalk.cyan(ASCII_LOGO));
      console.log(chalk.bold(`  v${VERSION} — Command your AI fleet.`));
      console.log(chalk.gray('  Bot Squad Command Suite'));
      console.log();
    });

  return command;
}
