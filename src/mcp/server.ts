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
  bindChannel,
  unbindChannel,
  addCronJob,
  removeCronJob,
  listCronJobs,
  setAgentConfig,
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
      name: z.string().min(2).max(31).regex(/^[a-z][a-z0-9-]*$/, 'Lowercase alphanumeric + hyphens').describe('Agent name'),
      role: z.enum(['coding', 'review', 'brain', 'security', 'ops', 'marketing', 'custom']).describe('Agent role'),
      model: z.string().min(1).max(128).optional().describe('Model to use (e.g. claude-sonnet-4)'),
      runtime: z.enum(['docker', 'native', 'openclaw']).optional().describe('Runtime type (default: docker)'),
      gatewayUrl: z.string().url().optional().describe('Gateway URL for openclaw runtime'),
      channels: z.array(z.object({
        type: z.enum(['telegram', 'discord']),
        accountId: z.string(),
      })).optional().describe('Channels to bind after creation (openclaw only)'),
    },
    async (args) => {
      try {
        const result = await createAgent({
          name: args.name,
          role: args.role,
          model: args.model,
          runtime: args.runtime,
          gatewayUrl: args.gatewayUrl,
        });

        // Bind channels if specified (openclaw only)
        if (args.channels && args.channels.length > 0) {
          for (const ch of args.channels) {
            await bindChannel(args.name, ch.type, ch.accountId);
          }
        }

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
      name: z.string().min(2).max(31).regex(/^[a-z][a-z0-9-]*$/, 'Lowercase alphanumeric + hyphens').describe('Agent name to destroy'),
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
      name: z.string().min(2).max(31).regex(/^[a-z][a-z0-9-]*$/, 'Lowercase alphanumeric + hyphens').describe('Agent name'),
      lines: z.number().int().min(1).max(10000).optional().describe('Number of lines to return (default: 50)'),
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
      name: z.string().min(2).max(31).regex(/^[a-z][a-z0-9-]*$/, 'Lowercase alphanumeric + hyphens').describe('Agent name to restart'),
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

  // ── agent_bind ──────────────────────────────────────────────────────
  server.tool(
    'agent_bind',
    'Bind a channel (telegram/discord) to an openclaw agent',
    {
      name: z.string().min(2).max(31).regex(/^[a-z][a-z0-9-]*$/, 'Lowercase alphanumeric + hyphens').describe('Agent name'),
      channel: z.enum(['telegram', 'discord']).describe('Channel type'),
      accountId: z.string().min(1).max(255).describe('Account ID for the channel'),
    },
    async (args) => {
      try {
        await bindChannel(args.name, args.channel, args.accountId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ bound: true, agent: args.name, channel: args.channel }) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── agent_unbind ───────────────────────────────────────────────────
  server.tool(
    'agent_unbind',
    'Unbind a channel from an openclaw agent',
    {
      name: z.string().min(2).max(31).regex(/^[a-z][a-z0-9-]*$/, 'Lowercase alphanumeric + hyphens').describe('Agent name'),
      channel: z.enum(['telegram', 'discord']).describe('Channel type to unbind'),
    },
    async (args) => {
      try {
        await unbindChannel(args.name, args.channel);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ unbound: true, agent: args.name, channel: args.channel }) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── cron_add ───────────────────────────────────────────────────────
  server.tool(
    'cron_add',
    'Add a cron job to an openclaw agent',
    {
      name: z.string().min(2).max(31).regex(/^[a-z][a-z0-9-]*$/, 'Lowercase alphanumeric + hyphens').describe('Agent name'),
      id: z.string().min(1).max(64).describe('Unique cron job identifier'),
      cron: z.string().regex(/^(\*|[0-9,\-/]+)\s+(\*|[0-9,\-/]+)\s+(\*|[0-9,\-/]+)\s+(\*|[0-9,\-/]+)\s+(\*|[0-9,\-/]+)$/, 'Invalid cron expression').describe('Cron expression (e.g. "0 9 * * *")'),
      message: z.string().min(1).max(4096).describe('Message/prompt to send on schedule'),
      channel: z.string().min(1).max(64).optional().describe('Target channel for the cron message'),
    },
    async (args) => {
      try {
        addCronJob(args.name, { id: args.id, cron: args.cron, message: args.message, channel: args.channel });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ added: true, agent: args.name, cronId: args.id }) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── cron_remove ────────────────────────────────────────────────────
  server.tool(
    'cron_remove',
    'Remove a cron job from an agent',
    {
      name: z.string().min(2).max(31).regex(/^[a-z][a-z0-9-]*$/, 'Lowercase alphanumeric + hyphens').describe('Agent name'),
      id: z.string().min(1).max(64).describe('Cron job identifier to remove'),
    },
    async (args) => {
      try {
        removeCronJob(args.name, args.id);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ removed: true, agent: args.name, cronId: args.id }) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── cron_list ──────────────────────────────────────────────────────
  server.tool(
    'cron_list',
    'List cron jobs for an agent',
    {
      name: z.string().min(2).max(31).regex(/^[a-z][a-z0-9-]*$/, 'Lowercase alphanumeric + hyphens').describe('Agent name'),
    },
    async (args) => {
      try {
        const jobs = listCronJobs(args.name);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(jobs, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── agent_config_set ───────────────────────────────────────────────
  server.tool(
    'agent_config_set',
    'Set a configuration value on an openclaw agent via the gateway',
    {
      name: z.string().min(2).max(31).regex(/^[a-z][a-z0-9-]*$/, 'Lowercase alphanumeric + hyphens').describe('Agent name'),
      path: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/, 'Invalid config path').describe('Config path (e.g. "agent.myagent.model")'),
      value: z.string().min(1).max(1024).describe('Config value to set'),
    },
    async (args) => {
      try {
        await setAgentConfig(args.name, args.path, args.value);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ set: true, agent: args.name, path: args.path }) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── secrets_audit ──────────────────────────────────────────────────
  server.tool(
    'secrets_audit',
    'Audit secrets configuration for potential issues',
    {},
    async () => {
      try {
        const audit = runSecurityAudit();
        // Extract secrets-related findings
        const secretsFindings = audit.findings.filter(
          (f) => f.category === 'secrets' || f.message.toLowerCase().includes('secret') || f.message.toLowerCase().includes('key'),
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ findings: secretsFindings, total: secretsFindings.length }, null, 2) }],
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
