/**
 * Machine route handlers: list all machines and get a single machine.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { BscsConfig } from '../../util/types.js';
import { getMachineStatus } from '../../core/machine.js';
import { jsonResponse, jsonError } from '../middleware/errors.js';

/**
 * GET /api/machines — list all machines with their statuses.
 */
export async function handleListMachines(
  _req: IncomingMessage,
  res: ServerResponse,
  _config: BscsConfig,
): Promise<void> {
  try {
    const statuses = await getMachineStatus();
    jsonResponse(res, statuses);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list machines';
    jsonError(res, message, 500);
  }
}

/**
 * GET /api/machines/:name — get a single machine's status.
 */
export async function handleGetMachine(
  _req: IncomingMessage,
  res: ServerResponse,
  machineName: string,
  config: BscsConfig,
): Promise<void> {
  const machine = config.machines?.[machineName];
  if (!machine) {
    jsonError(res, `Machine "${machineName}" not found`, 404);
    return;
  }

  try {
    const statuses = await getMachineStatus(machineName);
    const status = statuses[0] ?? { name: machineName };
    jsonResponse(res, status);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to get machine status';
    jsonError(res, message, 500);
  }
}
