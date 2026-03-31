/**
 * Fleet route handler factory.
 * Each instance owns its own 15-second cache of the fleet status payload.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { BscsConfig } from '../../util/types.js';
import { getFleetStatus } from '../../core/fleet.js';
import { jsonResponse, jsonError } from '../middleware/errors.js';

export interface FleetCache {
  data: unknown;
  timestamp: number;
}

export const FLEET_CACHE_TTL = 15000; // 15 seconds

/**
 * Factory: creates a fleet handler that owns its own cache.
 */
export function createFleetHandler(
  _config: BscsConfig,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let cache: FleetCache | null = null;

  return async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const now = Date.now();
    if (cache && now - cache.timestamp < FLEET_CACHE_TTL) {
      jsonResponse(res, cache.data);
      return;
    }

    try {
      const data = await getFleetStatus();
      cache = { data, timestamp: Date.now() };
      jsonResponse(res, data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get fleet status';
      jsonError(res, message, 500);
    }
  };
}
