/**
 * New API server: HTTP server wiring all api/ modules together.
 * Exports startApiServer(port, bind) → Promise<{ port, token, close }>.
 *
 * All same routes as dashboard/server.ts, plus:
 *   - Cookie-based auth (POST /api/auth sets bscs_session cookie)
 *   - GET /api/auth/check (accepts cookie OR bearer)
 *   - SSE endpoint at /api/events
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { loadOrCreateAuthToken, validateAuthToken } from '../core/auth.js';
import { loadConfig } from '../core/config.js';
import { createLogger } from '../util/logger.js';

import { isAllowedOrigin } from './middleware/cors.js';
import { extractAuth } from './middleware/auth.js';
import { jsonError } from './middleware/errors.js';

import { handlePostAuth, handleGetAuthCheck } from './auth.js';
import { sseManager } from './sse.js';
import { createFleetHandler } from './routes/fleet.js';
import { handleListAgents, handleGetAgent, handleAgentAction, handleAgentLogs } from './routes/agents.js';
import { handleListMachines, handleGetMachine } from './routes/machines.js';
import { handleGetDoctor, handleDoctorFix } from './routes/doctor.js';

const logger = createLogger('api-server');

export interface ApiServer {
  port: number;
  token: string;
  close: () => void;
}

// Routes that don't require authentication
const AUTH_EXEMPT = new Set(['/api/auth', '/api/auth/check']);

/**
 * Apply CORS headers to a response based on the request origin.
 */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = typeof req.headers['origin'] === 'string' ? req.headers['origin'] : undefined;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

/**
 * Start the API server on the given port and bind address.
 */
export function startApiServer(port = 3200, bind = '127.0.0.1'): Promise<ApiServer> {
  const authToken = loadOrCreateAuthToken();
  const config = loadConfig();

  // Create per-server fleet handler (owns its own 15s cache)
  const fleetHandler = createFleetHandler(config);

  return new Promise((resolve, reject) => {
    logger.debug({ port, bind }, 'Starting API server');

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';
      const method = (req.method ?? 'GET').toUpperCase();

      applyCors(req, res);

      // Handle preflight
      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Only handle /api/ routes
      if (!url.startsWith('/api/')) {
        jsonError(res, 'Not found', 404);
        return;
      }

      // Auth enforcement (exempt: POST /api/auth and GET /api/auth/check)
      const isExempt =
        (url === '/api/auth' && method === 'POST') ||
        url === '/api/auth/check' ||
        AUTH_EXEMPT.has(url);

      if (!isExempt) {
        const cookieHeader =
          typeof req.headers['cookie'] === 'string' ? req.headers['cookie'] : undefined;
        const authHeader =
          typeof req.headers['authorization'] === 'string'
            ? req.headers['authorization']
            : undefined;
        const candidate = extractAuth(cookieHeader, authHeader);
        if (!candidate || !validateAuthToken(candidate, authToken)) {
          jsonError(res, 'Unauthorized', 401);
          return;
        }
      }

      try {
        await routeRequest(req, res, url, method, authToken, config, fleetHandler);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal server error';
        logger.error({ err }, 'Unhandled API error');
        jsonError(res, message, 500);
      }
    });

    server.on('error', reject);
    server.listen(port, bind, () => {
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      logger.info({ port: actualPort, bind }, 'API server listening');
      resolve({
        port: actualPort,
        token: authToken,
        close: () => server.close(),
      });
    });
  });
}

type FleetHandlerFn = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
  authToken: string,
  config: ReturnType<typeof loadConfig>,
  fleetHandler: FleetHandlerFn,
): Promise<void> {
  // POST /api/auth — token → cookie
  if (url === '/api/auth' && method === 'POST') {
    await handlePostAuth(req, res, authToken);
    return;
  }

  // GET /api/auth/check
  if (url === '/api/auth/check' && method === 'GET') {
    handleGetAuthCheck(req, res, authToken);
    return;
  }

  // Legacy GET /api/auth (bearer-only, kept for dashboard backward compat)
  if (url === '/api/auth' && method === 'GET') {
    handleGetAuthCheck(req, res, authToken);
    return;
  }

  // GET /api/fleet
  if (url === '/api/fleet' && method === 'GET') {
    await fleetHandler(req, res);
    return;
  }

  // SSE: GET /api/events
  if (url === '/api/events' && method === 'GET') {
    sseManager.addClient(res);
    return;
  }

  // GET /api/agents
  if (url === '/api/agents' && method === 'GET') {
    await handleListAgents(req, res, config);
    return;
  }

  // Agent sub-routes: /api/agents/:name[/action]
  const agentMatch = url.match(/^\/api\/agents\/([^/]+)(?:\/(.+))?$/);
  if (agentMatch) {
    const agentName = decodeURIComponent(agentMatch[1] ?? '');
    const sub = agentMatch[2];

    if (!sub && method === 'GET') {
      await handleGetAgent(req, res, agentName, config);
      return;
    }

    if (sub === 'logs' && method === 'GET') {
      await handleAgentLogs(req, res, agentName, config);
      return;
    }

    if ((sub === 'start' || sub === 'stop' || sub === 'restart') && method === 'POST') {
      await handleAgentAction(req, res, agentName, sub, config);
      return;
    }
  }

  // GET /api/machines
  if (url === '/api/machines' && method === 'GET') {
    await handleListMachines(req, res, config);
    return;
  }

  // Machine sub-routes: /api/machines/:name
  const machineMatch = url.match(/^\/api\/machines\/([^/]+)$/);
  if (machineMatch && method === 'GET') {
    const machineName = decodeURIComponent(machineMatch[1] ?? '');
    await handleGetMachine(req, res, machineName, config);
    return;
  }

  // GET /api/doctor
  if (url === '/api/doctor' && method === 'GET') {
    await handleGetDoctor(req, res, config);
    return;
  }

  // POST /api/doctor/fix
  if (url === '/api/doctor/fix' && method === 'POST') {
    await handleDoctorFix(req, res, config);
    return;
  }

  jsonError(res, 'Not found', 404);
}
