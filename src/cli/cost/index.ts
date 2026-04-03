import { Command } from 'commander';
import chalk from 'chalk';
import {
  getCostData,
  generateCostReport,
  getBudgetStatus,
  setDailyBudget,
} from '../../core/cost.js';

export function createCostCommand(): Command {
  const command = new Command('cost')
    .description('Cost tracking and budget management');

  command.addCommand(createCostReportCommand());
  command.addCommand(createCostBudgetCommand());

  return command;
}

function createCostReportCommand(): Command {
  return new Command('report')
    .description('Generate cost report')
    .option('-p, --period <period>', 'Period: today, yesterday, week, month')
    .option('-b, --by <groupBy>', 'Group by: agent, model, provider')
    .option('--json', 'Output as JSON')
    .action((options) => {
      const period = (options.period as string) || 'today';
      const data = getCostData(period);
      const report = generateCostReport(data, period, options.by as string | undefined);
      
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      
      const startDate = new Date(report.period.start);
      const endDate = new Date(report.period.end);
      
      console.log(chalk.bold(`\n${startDate.toLocaleDateString()} to ${endDate.toLocaleDateString()} Cost Report\n`));
      console.log(chalk.gray(`  Period: ${startDate.toLocaleDateString()} to ${endDate.toLocaleDateString()}`));
      console.log(chalk.green(`  Total: $${report.total.toFixed(4)}`));
      
      if (options.by === 'agent' && report.byAgent) {
        console.log(chalk.cyan('\nBy Agent:'));
        const agents = Object.entries(report.byAgent)
          .sort((a, b) => b[1] - a[1]);
        
        agents.forEach(([agent, cost]) => {
          console.log(`  ${agent.padEnd(20)} ${chalk.cyan(`$${cost.toFixed(4)}`)}`);
        });
      }
      
      if (options.by === 'model' && report.byModel) {
        console.log(chalk.cyan('\nBy Model:'));
        const models = Object.entries(report.byModel)
          .sort((a, b) => b[1] - a[1]);
        
        models.forEach(([model, cost]) => {
          console.log(`  ${model.padEnd(20)} ${chalk.cyan(`$${cost.toFixed(4)}`)}`);
        });
      }
      
      if (options.by === 'provider' && report.byProvider) {
        console.log(chalk.cyan('\nBy Provider:'));
        const providers = Object.entries(report.byProvider)
          .sort((a, b) => b[1] - a[1]);
        
        providers.forEach(([provider, cost]) => {
          console.log(`  ${provider.padEnd(20)} ${chalk.cyan(`$${cost.toFixed(4)}`)}`);
        });
      }
      
      if (report.budget) {
        console.log(chalk.cyan('\nBudget Status:'));
        console.log(formatBudgetStatus(report.budget));
      }
    });
}

function createCostBudgetCommand(): Command {
  const budget = new Command('budget')
    .description('Manage cost budget');
  
  budget.command('set <amount>')
    .description('Set daily budget in USD')
    .action((amount: string) => {
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum)) {
        console.error(chalk.red('Invalid amount'));
        process.exit(1);
      }
      
      setDailyBudget(amountNum);
      console.log(chalk.green(`✓ Daily budget set to $${amount}`));
    });
  
  budget.command('status')
    .description('Show current budget status')
    .action(() => {
      const status = getBudgetStatus();
      if (status === null) {
        console.log(chalk.yellow('\n  No daily budget configured.\n'));
        console.log(chalk.dim('  Use "bscs cost budget set <amount>" to set one.\n'));
        return;
      }
      console.log(chalk.bold('\nBudget Status:\n'));
      console.log(chalk.cyan(`  Daily Limit: $${status.limit}`));
      console.log(chalk.cyan(`  Spent: $${status.spent.toFixed(4)}`));
      console.log(chalk.cyan(`  Usage: ${status.percent.toFixed(1)}%`));

      if (status.percent >= 100) {
        console.log(chalk.red('  ⚠ Budget exceeded!'));
      } else if (status.percent >= 80) {
        console.log(chalk.yellow('  ⚠ Warning: Approaching budget limit'));
      } else {
        console.log(chalk.green('  ✓ Within budget'));
      }
    });
  
  return budget;
}

function formatBudgetStatus(budget: { limit: number; spent: number; percent: number }): string {
  const bar = createProgressBar(budget.percent);
  return `  ${bar} ${budget.percent.toFixed(1)}% ($${budget.spent.toFixed(4)}/$${budget.limit})`;
}

function createProgressBar(percent: number, width: number = 20): string {
  const filled = Math.min(Math.floor((percent / 100) * width), width);
  const empty = width - filled;
  
  const filledBar = '█'.repeat(filled);
  const emptyBar = '░'.repeat(empty);
  
  if (percent >= 100) {
    return chalk.red(filledBar + chalk.gray(emptyBar));
  } else if (percent >= 80) {
    return chalk.yellow(filledBar + chalk.gray(emptyBar));
  }
  return chalk.green(filledBar + chalk.gray(emptyBar));
}
