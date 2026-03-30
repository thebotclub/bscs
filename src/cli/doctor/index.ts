import { Command } from 'commander';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { createLogger } from '../../util/logger.js';
import { loadConfig } from '../../core/config.js';
import { runDoctor, fixDoctorIssue, type DoctorResult } from '../../core/doctor.js';

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

// =============================================================================
// Fleet Doctor Formatting
// =============================================================================

const STATUS_ICONS: Record<string, string> = {
  ok: chalk.green('✓'),
  warn: chalk.yellow('⚠'),
  error: chalk.red('✗'),
  critical: chalk.red.bold('✗'),
  skip: chalk.gray('⊘'),
};

function getStatusIcon(status: string): string {
  return STATUS_ICONS[status] || chalk.gray('?');
}

function getMachineName(host: string, config: any): string {
  const machine = config.machines?.[host];
  return machine?.sshAlias || host;
}

function formatFleetDoctor(result: DoctorResult, config: any): void {
  const modeLabel = result.mode === 'deep' ? 'deep mode' : 'quick mode';
  console.log();
  console.log(chalk.bold(`🩺 Fleet Doctor (${modeLabel})`));
  console.log();

  // Group checks by machine
  const machines = new Set<string>();
  for (const check of result.checks) {
    if (check.category === 'machine') machines.add(check.target);
  }

  for (const host of machines) {
    const name = getMachineName(host, config);
    const ip = name !== host ? ` (${host})` : '';
    const status = result.machines[host] || 'unknown';
    const statusColor = status === 'online' ? chalk.green : chalk.red;
    console.log(chalk.bold(`━━ Machine: ${name}${ip} `) + statusColor(`[${status}]`) + chalk.bold(' ━━━━━━━━━━━━━━━'));

    const machineChecks = result.checks.filter(c => c.category === 'machine' && c.target === host);
    for (const check of machineChecks) {
      const icon = getStatusIcon(check.status);
      let line = `  ${icon} ${check.name}: ${check.message}`;
      if (check.details) line += chalk.gray(` (${check.details})`);
      if (check.fix && check.status !== 'ok') {
        line += chalk.blue(` 💡 ${check.fix}`);
        if (check.autoFixable) line += chalk.green(' [auto-fixable]');
      }
      console.log(line);
    }
    console.log();
  }

  // Group checks by agent
  const agentNames = new Set<string>();
  for (const check of result.checks) {
    if (check.category === 'agent') agentNames.add(check.target);
  }

  for (const agentName of agentNames) {
    const agentConfig = config.agents?.[agentName];
    const machine = agentConfig?.machine || 'localhost';
    const machineName = getMachineName(machine, config);
    const runtime = agentConfig?.runtime || 'docker';
    console.log(chalk.bold(`━━ Agent: ${agentName} (${machineName}, ${runtime}) ━━━━━━━━━━━━━━━━━`));

    const agentChecks = result.checks.filter(c => c.category === 'agent' && c.target === agentName);
    for (const check of agentChecks) {
      const icon = getStatusIcon(check.status);
      let line = `  ${icon} ${check.name}: ${check.message}`;
      if (check.details) line += chalk.gray(` (${check.details})`);
      if (check.fix && check.status !== 'ok') {
        line += chalk.blue(` 💡 ${check.fix}`);
        if (check.autoFixable) line += chalk.green(' [auto-fixable]');
      }
      console.log(line);
    }
    console.log();
  }

  // Fleet checks
  const fleetChecks = result.checks.filter(c => c.category === 'fleet');
  if (fleetChecks.length > 0) {
    console.log(chalk.bold('━━ Fleet ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    for (const check of fleetChecks) {
      const icon = getStatusIcon(check.status);
      let line = `  ${icon} ${check.name}: ${check.message}`;
      if (check.details) line += chalk.gray(` (${check.details})`);
      if (check.fix && check.status !== 'ok') {
        line += chalk.blue(` 💡 ${check.fix}`);
        if (check.autoFixable) line += chalk.green(' [auto-fixable]');
      }
      console.log(line);
    }
    console.log();
  }

  // Score
  const { score } = result;
  const passed = score.ok;
  const scorable = score.total - score.skip;
  const parts: string[] = [];
  parts.push(chalk.bold(`Score: ${passed}/${scorable} checks passed`));
  if (score.warn > 0) parts.push(chalk.yellow(`${score.warn} warning(s)`));
  if (score.error > 0) parts.push(chalk.red(`${score.error} error(s)`));
  if (score.critical > 0) parts.push(chalk.red.bold(`${score.critical} critical`));
  if (score.skip > 0) parts.push(chalk.gray(`${score.skip} skipped`));
  console.log(parts.join(' | '));
  console.log(chalk.gray(`Completed in ${(result.duration / 1000).toFixed(1)}s`));
  console.log();
}

// =============================================================================
// Command
// =============================================================================

export function createDoctorCommand(): Command {
  const command = new Command('doctor')
    .description('Validate environment and dependencies')
    .option('--json', 'Output as JSON')
    .option('--fleet', 'Run fleet-wide doctor checks across all machines')
    .option('--deep', 'Run deep checks (extended diagnostics, log scanning)')
    .option('--fix', 'Auto-fix all fixable issues (use with --fleet)')
    .action(async (options: { json?: boolean; fleet?: boolean; deep?: boolean; fix?: boolean }) => {
      // Fleet doctor mode
      if (options.fleet) {
        logger.debug('Running fleet doctor');
        const config = loadConfig();
        const deep = options.deep || false;

        try {
          const result = await runDoctor(config, deep);

          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          formatFleetDoctor(result, config);

          // Auto-fix mode
          if (options.fix) {
            const fixable = result.checks.filter(c => c.autoFixable && c.fixCommand && c.status !== 'ok');
            if (fixable.length === 0) {
              console.log(chalk.gray('No auto-fixable issues found.'));
            } else {
              console.log(chalk.bold.yellow(`\n🔧 Auto-fixing ${fixable.length} issue(s)…\n`));
              for (const check of fixable) {
                process.stdout.write(`  Fixing ${check.target} → ${check.name}… `);
                const fixResult = await fixDoctorIssue(check, config);
                if (fixResult.ok) {
                  console.log(chalk.green('✓ ') + chalk.gray(fixResult.message));
                } else {
                  console.log(chalk.red('✗ ') + chalk.gray(fixResult.message));
                }
              }

              // Re-run doctor to show updated state
              console.log(chalk.bold('\n🩺 Re-running doctor…\n'));
              const recheck = await runDoctor(config, deep);
              formatFleetDoctor(recheck, config);
            }
          }

          // Exit with error code if critical issues
          if (result.score.critical > 0 || result.score.error > 0) {
            process.exit(1);
          }
        } catch (err) {
          console.error(chalk.red(`Fleet doctor failed: ${err}`));
          process.exit(1);
        }
        return;
      }

      // Original local doctor
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
