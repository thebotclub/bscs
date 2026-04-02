/**
 * MCP (Model Context Protocol) server for AI-to-AI fleet control.
 *
 * Implements 8 MCP tools per spec:
 *   fleet_status, agent_create, agent_destroy, agent_logs,
 *   agent_restart, fleet_reconcile, cost_report, security_audit
 *
 * Transport: stdio (JSON-RPC over stdin/stdout)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getFleetStatus, computeReconcileChanges, applyReconcileChange } from '../core/fleet.js';
import {
  createAgent,
  destroyAgent,
  restartAgent,
  logsAgent,
} from '../core/agent.js';
import { getCostData, generateCostReport } from '../core/cost.js';
import { runSecurityAudit } from '../core/security.js';
import { createLogger } from '../util/logger.js';

const logger = createLogger('mcp');

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'bscs',
    version: '0.1.0',
  });

  // ── fleet_status ───────────────────────────────────────────────────
  server.tool(
    'fleet_status',
    'Get full fleet status including all agents and machines',
    {
      includeAll: z.boolean().optional().describe('Include stopped agents'),
    },
    async (args) => {
      try {
        const status = await getFleetStatus(args.includeAll ?? true);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── agent_create ───────────────────────────────────────────────────
  server.tool(
    'agent_create',
    'Create a new AI agent container',
    {
      name: z.string().describe('Agent name'),
      role: z.enum(['coding', 'review', 'brain', 'security', 'ops', 'marketing', 'custom']).describe('Agent role'),
      model: z.string().optional().describe('Model to use (e.g. claude-sonnet-4)'),
    },
    async (args) => {
      try {
        const result = await createAgent({
          name: args.name,
          role: args.role,
          model: args.model,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── agent_destroy ──────────────────────────────────────────────────
  server.tool(
    'agent_destroy',
    'Destroy an AI agent container',
    {
      name: z.string().describe('Agent name to destroy'),
      force: z.boolean().optional().describe('Force removal of running container'),
    },
    async (args) => {
      try {
        const result = await destroyAgent(args.name, { force: args.force });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── agent_logs ─────────────────────────────────────────────────────
  server.tool(
    'agent_logs',
    'Get recent logs from an agent container',
    {
      name: z.string().describe('Agent name'),
      lines: z.number().optional().describe('Number of lines to return (default: 50)'),
    },
    async (args) => {
      try {
        const child = logsAgent(args.name, {
          tail: args.lines ?? 50,
          follow: false,
        });

        // Collect output
        const chunks: Buffer[] = [];
        child.stdout?.on('data', (d: Buffer) => chunks.push(d));
        child.stderr?.on('data', (d: Buffer) => chunks.push(d));

        await new Promise<void>((resolve) => {
          child.on('close', () => resolve());
          // Safety timeout
          setTimeout(() => { child.kill(); resolve(); }, 10_000);
        });

        const output = Buffer.concat(chunks).toString();
        return {
          content: [{ type: 'text' as const, text: output || '(no logs)' }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── agent_restart ──────────────────────────────────────────────────
  server.tool(
    'agent_restart',
    'Restart an AI agent container',
    {
      name: z.string().describe('Agent name to restart'),
    },
    async (args) => {
      try {
        const result = await restartAgent(args.name);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── fleet_reconcile ────────────────────────────────────────────────
  server.tool(
    'fleet_reconcile',
    'Compute and optionally apply fleet reconciliation changes',
    {
      apply: z.boolean().optional().describe('Apply changes (default: dry run)'),
    },
    async (args) => {
      try {
        const changes = await computeReconcileChanges();

        if (args.apply) {
          const results = [];
          for (const change of changes) {
            const r = await applyReconcileChange(change);
            results.push(r);
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ applied: true, results }, null, 2) }],
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ dryRun: true, changes }, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── cost_report ────────────────────────────────────────────────────
  server.tool(
    'cost_report',
    'Generate a cost report for the fleet',
    {
      period: z.enum(['today', 'yesterday', 'week', 'month']).optional().describe('Time period'),
      groupBy: z.enum(['agent', 'model', 'provider']).optional().describe('Group costs by'),
    },
    async (args) => {
      try {
        const period = args.period ?? 'today';
        const entries = getCostData(period);
        const report = generateCostReport(entries, period, args.groupBy);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── security_audit ─────────────────────────────────────────────────
  server.tool(
    'security_audit',
    'Run a security audit on the fleet configuration',
    {},
    async () => {
      try {
        const result = runSecurityAudit();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── Start server ───────────────────────────────────────────────────
  const transport = new StdioServerTransport();
  logger.info('Starting MCP server on stdio');
  await server.connect(transport);
}
