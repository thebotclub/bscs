import { Command } from 'commander';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { createLogger } from '../../util/logger.js';

const logger = createLogger('doctor');

interface CheckResult {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
  details?: string;
}

function checkDocker(): CheckResult {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    const version = execSync('docker --version', { encoding: 'utf-8' }).trim();
    return {
      name: 'Docker',
      status: 'ok',
      message: 'Docker is running',
      details: version,
    };
  } catch {
    return {
      name: 'Docker',
      status: 'error',
      message: 'Docker is not running or not installed',
      details: 'Run "docker info" to diagnose',
    };
  }
}

function checkNode(): CheckResult {
  const nodeVersion = process.version;
  const parts = nodeVersion.slice(1).split('.');
  const major = parseInt(parts[0] || '0', 10);
  
  if (major >= 20) {
    return {
      name: 'Node.js',
      status: 'ok',
      message: `Node.js ${nodeVersion}`,
      details: 'Version 20+ required',
    };
  } else {
    return {
      name: 'Node.js',
      status: 'error',
      message: `Node.js ${nodeVersion} is too old`,
      details: 'Version 20+ required',
    };
  }
}

function check1Password(): CheckResult {
  try {
    const version = execSync('op --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    return {
      name: '1Password CLI',
      status: 'ok',
      message: `1Password CLI v${version}`,
      details: 'Optional - used for secrets management',
    };
  } catch {
    return {
      name: '1Password CLI',
      status: 'warning',
      message: '1Password CLI not found',
      details: 'Optional - install for secrets management',
    };
  }
}

async function checkConfigDir(): Promise<CheckResult> {
  const home = process.env.HOME;
  if (!home) {
    return {
      name: 'Config Directory',
      status: 'error',
      message: 'HOME environment variable not set',
    };
  }
  const configDir = process.env.BSCS_CONFIG_DIR || `${home}/.config/bscs`;
  const fs = await import('fs');
  
  try {
    if (fs.existsSync(configDir)) {
      return {
        name: 'Config Directory',
        status: 'ok',
        message: `Config directory exists at ${configDir}`,
      };
    } else {
      return {
        name: 'Config Directory',
        status: 'warning',
        message: `Config directory not found at ${configDir}`,
        details: 'Will be created on first use',
      };
    }
  } catch (err) {
    return {
      name: 'Config Directory',
      status: 'error',
      message: `Error checking config directory: ${err}`,
    };
  }
}

function formatResult(result: CheckResult): string {
  const statusIcon = {
    ok: chalk.green('✓'),
    warning: chalk.yellow('⚠'),
    error: chalk.red('✗'),
  }[result.status];
  
  let output = `${statusIcon} ${chalk.bold(result.name)}: ${result.message}`;
  if (result.details) {
    output += chalk.gray(` (${result.details})`);
  }
  return output;
}

export function createDoctorCommand(): Command {
  const command = new Command('doctor')
    .description('Validate environment and dependencies')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      logger.debug('Running environment checks');
      
      const results: CheckResult[] = [
        checkDocker(),
        checkNode(),
        check1Password(),
        await checkConfigDir(),
      ];
      
      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      
      console.log(chalk.bold('\n🔍 BSCS Environment Check\n'));
      
      for (const result of results) {
        console.log(formatResult(result));
      }
      
      const errors = results.filter(r => r.status === 'error');
      const warnings = results.filter(r => r.status === 'warning');
      
      console.log();
      if (errors.length > 0) {
        console.log(chalk.red(`Found ${errors.length} error(s). Fix before continuing.`));
        process.exit(1);
      } else if (warnings.length > 0) {
        console.log(chalk.yellow(`Found ${warnings.length} warning(s). Some features may not work.`));
      } else {
        console.log(chalk.green('All checks passed!'));
      }
    });

  return command;
}
