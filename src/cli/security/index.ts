import { Command } from 'commander';
import chalk from 'chalk';
import { runSecurityAudit, getSecurityBaseline } from '../../core/security.js';

export function createSecurityAuditCommand(): Command {
  return new Command('audit')
    .description('Run security audit on agent configurations')
    .option('--json', 'Output as JSON')
    .action((options: { json?: boolean }) => {
      const result = runSecurityAudit();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.bold.cyan('\n🔒 Security Audit\n'));
      console.log(chalk.dim(`  Timestamp: ${result.timestamp}`));
      console.log(chalk.dim(`  Score: ${result.score}/100\n`));

      if (result.findings.length === 0) {
        console.log(chalk.green('  ✓ No issues found\n'));
        return;
      }

      for (const f of result.findings) {
        const icon =
          f.severity === 'critical'
            ? chalk.red('✗')
            : f.severity === 'warning'
              ? chalk.yellow('⚠')
              : chalk.blue('ℹ');
        const agent = f.agent ? chalk.dim(` [${f.agent}]`) : '';
        console.log(`  ${icon} ${f.message}${agent}`);
        if (f.recommendation) {
          console.log(chalk.dim(`    → ${f.recommendation}`));
        }
      }

      console.log();
      console.log(
        chalk.dim(
          `  Summary: ${result.summary.critical} critical, ${result.summary.warning} warnings, ${result.summary.info} info`,
        ),
      );
      console.log();
    });
}

export function createSecurityBaselineCommand(): Command {
  return new Command('baseline')
    .description('Show security baseline recommendations')
    .option('--json', 'Output as JSON')
    .action((options: { json?: boolean }) => {
      const recommendations = getSecurityBaseline();

      if (options.json) {
        console.log(JSON.stringify(recommendations, null, 2));
        return;
      }

      console.log(chalk.bold.cyan('\n🛡️  Security Baseline\n'));

      for (const r of recommendations) {
        const icon = r.applied ? chalk.green('✓') : chalk.red('✗');
        console.log(`  ${icon} ${r.description}`);
        console.log(
          chalk.dim(`    Current: ${r.current} | Recommended: ${r.recommended}`),
        );
      }

      const applied = recommendations.filter((r) => r.applied).length;
      console.log();
      console.log(
        chalk.dim(`  ${applied}/${recommendations.length} recommendations applied`),
      );
      console.log();
    });
}

export function createSecurityCommand(): Command {
  const command = new Command('security').description(
    'Security audit and baseline tools',
  );

  command.addCommand(createSecurityAuditCommand());
  command.addCommand(createSecurityBaselineCommand());

  return command;
}
