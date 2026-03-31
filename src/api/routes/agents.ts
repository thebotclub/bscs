/**
 * Agent route handlers: list, get, actions (start/stop/restart), logs.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { BscsConfig } from '../../util/types.js';
import {
  getAllAgentStatuses,
  getAgentStatus,
  startAgent,
  stopAgent,
  restartAgent,
  createAgent,
  destroyAgent,
} from '../../core/agent.js';
import { jsonResponse, jsonError } from '../middleware/errors.js';
import { readBody } from '../middleware/body.js';
import { getAgentConfigPath } from '../../core/config.js';
import { readFile } from 'node:fs/promises';

const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);

/**
 * GET /api/agents — list all agents with their statuses.
 */
export async function handleListAgents(
  _req: IncomingMessage,
  res: ServerResponse,
  _config: BscsConfig,
): Promise<void> {
  try {
    const agents = await getAllAgentStatuses();
    jsonResponse(res, agents);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list agents';
    jsonError(res, message, 500);
  }
}

/**
 * GET /api/agents/:name — get a single agent's status/details.
 */
export async function handleGetAgent(
  _req: IncomingMessage,
  res: ServerResponse,
  agentName: string,
  _config: BscsConfig,
): Promise<void> {
  try {
    const agent = await getAgentStatus(agentName);
    jsonResponse(res, agent);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Agent not found';
    jsonError(res, message, 404);
  }
}

/**
 * POST /api/agents/:name/(start|stop|restart) — perform an action on an agent.
 */
export async function handleAgentAction(
  _req: IncomingMessage,
  res: ServerResponse,
  agentName: string,
  action: string,
  _config: BscsConfig,
): Promise<void> {
  if (!ALLOWED_ACTIONS.has(action)) {
    jsonError(res, `Unknown action: ${action}. Allowed: start, stop, restart`, 400);
    return;
  }

  try {
    let result: { name: string; status: string };
    if (action === 'start') {
      result = await startAgent(agentName);
    } else if (action === 'stop') {
      result = await stopAgent(agentName);
    } else {
      result = await restartAgent(agentName);
    }
    jsonResponse(res, { ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : `Failed to ${action} agent`;
    jsonError(res, message, 500);
  }
}

/**
 * GET /api/agents/:name/logs — return recent log lines for an agent.
 */
export async function handleAgentLogs(
  _req: IncomingMessage,
  res: ServerResponse,
  agentName: string,
  config: BscsConfig,
): Promise<void> {
  if (!config.agents?.[agentName]) {
    jsonError(res, `Agent "${agentName}" not found`, 404);
    return;
  }

  // Return a simple JSON response indicating logs are available.
  // Full streaming log support would use SSE; this is the basic REST variant.
  jsonResponse(res, { agent: agentName, message: 'Use SSE endpoint for streaming logs' });
}

/**
 * GET /api/agents/:name/config — return the agent's on-disk OpenClaw config.
 */
export async function handleAgentConfig(
  _req: IncomingMessage,
  res: ServerResponse,
  agentName: string,
  config: BscsConfig,
): Promise<void> {
  if (!config.agents?.[agentName]) {
    jsonError(res, `Agent "${agentName}" not found`, 404);
    return;
  }
  try {
    const configPath = getAgentConfigPath(agentName);
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    jsonResponse(res, { name: agentName, config: parsed });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      jsonError(res, `Config file not found for agent "${agentName}"`, 404);
      return;
    }
    const message = err instanceof Error ? err.message : 'Failed to read agent config';
    jsonError(res, message, 500);
  }
}

const AGENT_NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * POST /api/agents — create a new agent.
 */
export async function handleCreateAgent(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw) as Record<string, unknown>;

    const name = typeof body.name === 'string' ? body.name : '';
    if (!AGENT_NAME_RE.test(name)) {
      jsonError(res, 'Invalid agent name: must match /^[a-z][a-z0-9-]{1,30}$/', 400);
      return;
    }

    const role = typeof body.role === 'string' ? body.role : 'coding';
    const dryRun = body.dryRun === true;

    const result = await createAgent({
      name,
      role: role as import('../../util/types.js').AgentRole,
      image: typeof body.image === 'string' ? body.image : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      dryRun,
    });
    jsonResponse(res, result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create agent';
    jsonError(res, message, 500);
  }
}

/**
 * DELETE /api/agents/:name — destroy an agent.
 */
export async function handleDeleteAgent(
  _req: IncomingMessage,
  res: ServerResponse,
  agentName: string,
): Promise<void> {
  try {
    await destroyAgent(agentName);
    jsonResponse(res, { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete agent';
    jsonError(res, message, 500);
  }
}
