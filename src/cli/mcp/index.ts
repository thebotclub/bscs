import { Command } from 'commander';
import chalk from 'chalk';
import { startMcpServer } from '../../mcp/server.js';

export function createMcpServeCommand(): Command {
  return new Command('serve')
    .description('Start MCP server for AI-to-AI fleet control')
    .option('-p, --port <port>', 'Port to listen on (stdio mode ignores this)', '3210')
    .action(async () => {
      // When invoked interactively, print info to stderr (stdout is for MCP protocol)
      if (process.stderr.isTTY) {
        process.stderr.write(chalk.bold.cyan('\n🤖 BSCS MCP Server\n\n'));
        process.stderr.write(chalk.dim('  Transport: stdio (JSON-RPC)\n'));
        process.stderr.write(chalk.dim('  Tools: fleet_status, agent_create, agent_destroy,\n'));
        process.stderr.write(chalk.dim('         agent_logs, agent_restart, fleet_reconcile,\n'));
        process.stderr.write(chalk.dim('         cost_report, security_audit\n\n'));
        process.stderr.write(chalk.green('  ✓ MCP server running — waiting for JSON-RPC input on stdin\n\n'));
      }

      await startMcpServer();
    });
}

export function createMcpCommand(): Command {
  const command = new Command('mcp')
    .description('MCP (Model Context Protocol) server for fleet control');

  command.addCommand(createMcpServeCommand());

  return command;
}
