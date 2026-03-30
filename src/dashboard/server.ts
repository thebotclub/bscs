import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, exec } from 'child_process';
import chalk from 'chalk';
import { createLogger } from '../util/logger.js';
import { getFleetStatus } from '../cli/fleet/status.js';
import { getMachineStatus } from '../cli/machine/index.js';
import { loadConfig, saveConfig, type BscsConfig } from '../core/config.js';
import { Command } from 'commander';
import { createHash } from 'crypto';

const logger = createLogger('dashboard');

// WebSocket clients
const wsClients: Set<any> = new Set();

export interface DashboardServer {
  port: number;
  close: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

function getLocalIps(): string[] {
  try {
    const result = execSync("/sbin/ifconfig 2>/dev/null | grep 'inet ' | awk '{print $2}' || ip -4 addr show 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1", { encoding: 'utf8', timeout: 3000 });
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return ['127.0.0.1'];
  }
}

function isLocalMachine(host: string): boolean {
  const localIps = getLocalIps();
  return host === 'localhost' || host === '127.0.0.1' || localIps.includes(host);
}

function getMachineName(ip: string, config: BscsConfig): string {
  const machine = (config.machines as any)?.[ip];
  return machine?.sshAlias || ip;
}

function getSshTarget(machineHost: string, config: BscsConfig): string {
  const machine = (config.machines as any)?.[machineHost];
  if (machine?.sshAlias) return machine.sshAlias;
  const user = machine?.user || 'hani';
  return `${user}@${machineHost}`;
}

function executeCommand(command: string, timeoutMs = 30000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, output: (stderr || err.message || '').trim() });
      } else {
        resolve({ ok: true, output: (stdout || '').trim() });
      }
    });
  });
}

async function executeAgentCommand(agentName: string, command: string, config: BscsConfig): Promise<{ ok: boolean; output: string }> {
  const agent = (config.agents as any)?.[agentName];
  if (!agent) return { ok: false, output: 'Agent not found in config' };

  const machine = agent.machine || 'localhost';
  const local = isLocalMachine(machine);

  if (local) {
    return executeCommand(command);
  } else {
    const target = getSshTarget(machine, config);
    const escaped = command.replace(/'/g, "'\\''");
    return executeCommand(`ssh -o ConnectTimeout=10 -o BatchMode=yes ${target} '${escaped}'`);
  }
}

function getDockerCommand(action: string, containerName: string): string {
  switch (action) {
    case 'start': return `docker start ${containerName}`;
    case 'stop': return `docker stop ${containerName}`;
    case 'restart': return `docker restart ${containerName}`;
    case 'remove': return `docker rm -f ${containerName}`;
    case 'logs': return `docker logs --tail 100 ${containerName}`;
    default: throw new Error(`Unknown action: ${action}`);
  }
}

function getNativeCommand(action: string, agentName: string, _gatewayPort?: number): string {
  switch (action) {
    case 'start':
      return `launchctl kickstart gui/$(id -u)/ai.openclaw.${agentName} 2>/dev/null || echo "Started"`;
    case 'stop':
      return `pkill -f "openclaw.*gateway.*${agentName}" 2>/dev/null; pkill -f "openclaw.*${agentName}" 2>/dev/null; echo "Stopped"`;
    case 'restart':
      return `pkill -f "openclaw.*gateway.*${agentName}" 2>/dev/null; pkill -f "openclaw.*${agentName}" 2>/dev/null; sleep 2; launchctl kickstart -k gui/$(id -u)/ai.openclaw.${agentName} 2>/dev/null || echo "Restarted"`;
    case 'logs':
      return `tail -100 ~/Library/Logs/openclaw/${agentName}.log 2>/dev/null || journalctl --user -u openclaw-${agentName} -n 100 --no-pager 2>/dev/null || echo "No logs found"`;
    default: throw new Error(`Unknown action: ${action}`);
  }
}

// ============================================================================
// API Handlers
// ============================================================================

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, data: any, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleAgentAction(agentName: string, action: string, config: BscsConfig): Promise<{ ok: boolean; output: string }> {
  const agent = (config.agents as any)?.[agentName];
  if (!agent) return { ok: false, output: `Agent "${agentName}" not found` };

  const runtime = agent.runtime || 'docker';
  const containerName = agent.container || `openclaw_${agentName}`;

  if (runtime === 'docker') {
    const cmd = getDockerCommand(action, containerName);
    return executeAgentCommand(agentName, cmd, config);
  } else if (runtime === 'native') {
    const cmd = getNativeCommand(action, agentName, agent.ports?.gateway);
    return executeAgentCommand(agentName, cmd, config);
  }

  return { ok: false, output: `Unknown runtime: ${runtime}` };
}

async function handleMachinesList(config: BscsConfig): Promise<any[]> {
  const machines: any[] = [];
  const agents = config.agents || {};
  const machinesConfig = (config.machines || {}) as Record<string, any>;

  for (const [ip, mc] of Object.entries(machinesConfig)) {
    if (!mc) continue;
    const agentCount = Object.values(agents).filter((a: any) => a.machine === ip).length;
    const agentNames = Object.entries(agents)
      .filter(([, a]: [string, any]) => a.machine === ip)
      .map(([name]: [string, any]) => name);

    let status = 'unknown';
    if (isLocalMachine(ip)) {
      status = 'online';
    } else {
      const target = mc.sshAlias || `${mc.user || 'hani'}@${ip}`;
      const result = await executeCommand(`ssh -o ConnectTimeout=5 -o BatchMode=yes ${target} 'echo ok'`, 8000);
      status = result.ok ? 'online' : 'offline';
    }

    machines.push({
      name: mc.sshAlias || ip,
      ip,
      role: mc.role || 'worker',
      status,
      agentCount,
      agents: agentNames,
      user: mc.user || 'hani',
    });
  }

  return machines;
}

// ============================================================================
// Server
// ============================================================================

export function startDashboardServer(port = 3200): Promise<DashboardServer> {
  return new Promise((resolve, reject) => {
    logger.debug({ port }, 'Starting dashboard server');
    
    const server = createServer(async (req, res) => {
      const url = req.url || '/';
      const method = req.method || 'GET';
      
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      
      // API routes
      if (url.startsWith('/api/')) {
        try {
          // GET /api/fleet
          if (url === '/api/fleet' && method === 'GET') {
            const config = loadConfig();
            const status = await getFleetStatus(true);
            // Enrich agents with machine names
            for (const agent of status.agents) {
              (agent as any).machineName = getMachineName(agent.machine, config);
            }
            // Enrich machines with names
            for (const [ip, m] of Object.entries(status.machines)) {
              (m as any).name = getMachineName(ip, config);
            }
            jsonResponse(res, status);
            return;
          }
          
          // GET /api/health
          if (url === '/api/health' && method === 'GET') {
            jsonResponse(res, { status: 'ok', timestamp: new Date().toISOString() });
            return;
          }
          
          // GET /api/machines
          if (url === '/api/machines' && method === 'GET') {
            const config = loadConfig();
            const machines = await handleMachinesList(config);
            jsonResponse(res, { machines });
            return;
          }
          
          // GET /api/machine (legacy)
          if (url === '/api/machine' && method === 'GET') {
            const status = await getMachineStatus();
            jsonResponse(res, status);
            return;
          }
          
          // Agent-specific routes: /api/agent/:name/action
          const agentActionMatch = url.match(/^\/api\/agent\/([a-z0-9-]+)\/(start|stop|restart|logs)$/);
          if (agentActionMatch) {
            const agentName = agentActionMatch[1]!;
            const action = agentActionMatch[2]!;
            const config = loadConfig();
            
            if (method === 'POST' && ['start', 'stop', 'restart'].includes(action)) {
              const result = await handleAgentAction(agentName, action, config);
              jsonResponse(res, { 
                ok: result.ok, 
                message: result.ok ? `Agent ${agentName} ${action}ed successfully` : result.output,
                output: result.output 
              }, result.ok ? 200 : 500);
              return;
            }
            
            if (method === 'GET' && action === 'logs') {
              const result = await handleAgentAction(agentName, 'logs', config);
              jsonResponse(res, { ok: result.ok, logs: result.output });
              return;
            }
          }
          
          // DELETE /api/agent/:name
          const agentDeleteMatch = url.match(/^\/api\/agent\/([a-z0-9-]+)$/);
          if (agentDeleteMatch && method === 'DELETE') {
            const agentName = agentDeleteMatch[1]!;
            const config = loadConfig();
            const agent = (config.agents as any)?.[agentName];
            
            if (!agent) {
              jsonResponse(res, { ok: false, message: 'Agent not found' }, 404);
              return;
            }
            
            // Stop the agent first
            const runtime = agent.runtime || 'docker';
            const containerName = agent.container || `openclaw_${agentName}`;
            
            if (runtime === 'docker') {
              await executeAgentCommand(agentName, `docker rm -f ${containerName}`, config);
            } else {
              await handleAgentAction(agentName, 'stop', config);
            }
            
            // Remove from config
            if (config.agents) {
              delete (config.agents as any)[agentName];
              saveConfig(config);
            }
            
            jsonResponse(res, { ok: true, message: `Agent ${agentName} deleted` });
            return;
          }
          
          // POST /api/agent — create new agent
          if (url === '/api/agent' && method === 'POST') {
            const body = await readBody(req);
            let payload: any;
            try {
              payload = JSON.parse(body);
            } catch {
              jsonResponse(res, { ok: false, message: 'Invalid JSON' }, 400);
              return;
            }
            
            const { name, role, machine, model, fallback, image, dryRun } = payload;
            
            if (!name || !/^[a-z][a-z0-9-]{1,30}$/.test(name)) {
              jsonResponse(res, { ok: false, message: 'Invalid name: lowercase alphanumeric + hyphens, 2-31 chars' }, 400);
              return;
            }
            
            const config = loadConfig();
            if ((config.agents as any)?.[name]) {
              jsonResponse(res, { ok: false, message: `Agent "${name}" already exists` }, 409);
              return;
            }
            
            // Find next available port pair
            const usedPorts = new Set<number>();
            for (const a of Object.values(config.agents || {})) {
              if ((a as any).ports?.gateway) usedPorts.add((a as any).ports.gateway);
              if ((a as any).ports?.remote) usedPorts.add((a as any).ports.remote);
            }
            let nextPort = config.defaults?.portRange?.start || 19000;
            while (usedPorts.has(nextPort) || usedPorts.has(nextPort + 1)) nextPort += 2;
            
            const agentConfig: any = {
              name,
              role: role || 'custom',
              machine: machine || 'localhost',
              runtime: 'docker',
              image: image || config.defaults?.image || 'openclaw-fleet:latest',
              model: model || undefined,
              fallback: fallback || undefined,
              container: `openclaw_${name}`,
              ports: { gateway: nextPort, remote: nextPort + 1 },
              status: 'created',
              created: new Date().toISOString(),
            };
            
            if (dryRun) {
              jsonResponse(res, { ok: true, dryRun: true, agent: agentConfig });
              return;
            }
            
            // Save to config
            if (!config.agents) (config as any).agents = {};
            (config.agents as any)[name] = agentConfig;
            saveConfig(config);
            
            jsonResponse(res, { ok: true, message: `Agent "${name}" created`, agent: agentConfig });
            return;
          }
          
          // POST /api/doctor/fix
          if (url === '/api/doctor/fix' && method === 'POST') {
            const body = await readBody(req);
            let payload: any;
            try {
              payload = JSON.parse(body);
            } catch {
              jsonResponse(res, { ok: false, message: 'Invalid JSON' }, 400);
              return;
            }

            const { target, command } = payload;
            if (!command) {
              jsonResponse(res, { ok: false, message: 'Missing command' }, 400);
              return;
            }

            let cmd: string;

            if (!target || target === 'local') {
              cmd = command;
            } else {
              // target is sshAlias or host — run via SSH
              const escaped = command.replace(/'/g, "'\\''");
              cmd = `ssh -o ConnectTimeout=10 -o BatchMode=yes ${target} '${escaped}'`;
            }

            const result = await executeCommand(cmd, 30000);
            jsonResponse(res, { ok: result.ok, output: result.output || (result.ok ? 'Fix applied' : 'Fix failed') });
            return;
          }

          // GET /api/doctor or /api/doctor?deep=true
          if (url.startsWith('/api/doctor') && method === 'GET') {
            const config = loadConfig();
            const urlObj = new URL(url, 'http://localhost');
            const deep = urlObj.searchParams.get('deep') === 'true';

            try {
              const { runDoctor } = await import('../core/doctor.js');
              const result = await runDoctor(config, deep);
              // Enrich machines with names
              const enrichedMachines: Record<string, any> = {};
              for (const [ip, status] of Object.entries(result.machines)) {
                enrichedMachines[ip] = { status, name: getMachineName(ip, config) };
              }
              (result as any).machines = enrichedMachines;
              jsonResponse(res, result);
            } catch (err) {
              jsonResponse(res, { error: 'Doctor failed', message: (err as Error).message }, 500);
            }
            return;
          }

          // Unknown API route
          jsonResponse(res, { error: 'Not found' }, 404);
          
        } catch (err) {
          logger.error({ err }, 'API error');
          jsonResponse(res, { error: 'Internal server error', message: (err as Error).message }, 500);
        }
        return;
      }
      
      // Static files - serve dashboard UI
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const dashboardDir = join(__dirname, 'ui');
      
      let filePath = url === '/' 
        ? join(dashboardDir, 'index.html')
        : join(dashboardDir, url);
      
      if (!filePath.startsWith(dashboardDir)) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }
      
      if (!existsSync(filePath)) {
        filePath = join(dashboardDir, 'index.html');
      }
      
      if (!existsSync(filePath)) {
        if (url === '/' || !url.includes('.')) {
          res.setHeader('Content-Type', 'text/html');
          res.end(getEmbeddedHtml());
          return;
        }
        
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      
      const ext = filePath.split('.').pop() || '';
      const contentTypes: Record<string, string> = {
        html: 'text/html',
        js: 'application/javascript',
        css: 'text/css',
        json: 'application/json',
        png: 'image/png',
        svg: 'image/svg+xml',
      };
      res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
      
      try {
        const content = readFileSync(filePath);
        res.end(content);
      } catch {
        res.statusCode = 500;
        res.end('Internal server error');
      }
    });
    
    // WebSocket upgrade
    server.on('upgrade', (req, socket, head) => {
      if (req.url === '/ws') {
        handleWebSocketUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    });
    
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });
    
    server.listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'Dashboard server started');
      resolve({
        port,
        close: () => {
          server.close();
          wsClients.clear();
        },
      });
    });
  });
}

function handleWebSocketUpgrade(req: any, socket: any, _head: Buffer) {
  const key = req.headers['sec-websocket-key'];
  const acceptKey = generateWebSocketAcceptKey(key);
  
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    '\r\n'
  );
  
  wsClients.add(socket);
  
  socket.on('close', () => {
    wsClients.delete(socket);
  });
  
  socket.on('error', (err: Error) => {
    logger.debug({ err: err.message }, 'WebSocket client error');
    wsClients.delete(socket);
    try { socket.destroy(); } catch {}
  });
  
  broadcastUpdate();
}

function generateWebSocketAcceptKey(key: string): string {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

export async function broadcastUpdate(): Promise<void> {
  if (wsClients.size === 0) return;
  
  try {
    const config = loadConfig();
    const status = await getFleetStatus(true);
    for (const agent of status.agents) {
      (agent as any).machineName = getMachineName(agent.machine, config);
    }
    const message = JSON.stringify({ type: 'fleet-update', data: status });
    
    const payload = Buffer.from(message);
    const frame = Buffer.concat([
      Buffer.from([0x81, payload.length]),
      payload,
    ]);
    
    for (const client of wsClients) {
      try {
        client.write(frame);
      } catch {
        wsClients.delete(client);
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to broadcast update');
  }
}

// ============================================================================
// Embedded HTML Dashboard
// ============================================================================

function getEmbeddedHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BSCS Fleet Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0d1117;
      --bg-card: #161b22;
      --bg-hover: #1c2128;
      --border: #30363d;
      --text: #c9d1d9;
      --text-dim: #8b949e;
      --blue: #58a6ff;
      --green: #7ee787;
      --red: #f85149;
      --yellow: #d29922;
      --purple: #bc8cff;
      --orange: #d18616;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      font-size: 14px;
    }
    /* Header */
    .header {
      background: var(--bg-card);
      padding: 0.75rem 1.5rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header-left { display: flex; align-items: center; gap: 1rem; }
    .header h1 { color: var(--blue); font-size: 1.25rem; white-space: nowrap; }
    .header .fleet-info { color: var(--text-dim); font-size: 0.8rem; }
    .header-right { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
    .conn-badge {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 0.75rem; padding: 3px 8px; border-radius: 12px;
      background: rgba(126,231,135,0.1); color: var(--green);
    }
    .conn-badge.polling { background: rgba(210,153,34,0.1); color: var(--yellow); }
    .conn-badge.offline { background: rgba(248,81,73,0.1); color: var(--red); }
    .conn-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    /* Buttons */
    .btn {
      background: #21262d; border: 1px solid var(--border); color: var(--text);
      padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 0.8rem;
      display: inline-flex; align-items: center; gap: 4px; transition: background 0.15s;
    }
    .btn:hover { background: #30363d; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: #238636; border-color: #2ea043; color: #fff; }
    .btn-primary:hover { background: #2ea043; }
    .btn-danger { color: var(--red); }
    .btn-danger:hover { background: rgba(248,81,73,0.15); }
    .btn-sm { padding: 3px 8px; font-size: 0.75rem; }
    .btn-icon { padding: 4px 6px; min-width: 28px; justify-content: center; }
    /* Toggle */
    .toggle { position: relative; display: inline-block; width: 36px; height: 20px; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle-slider {
      position: absolute; inset: 0; background: #30363d; border-radius: 20px;
      cursor: pointer; transition: background 0.2s;
    }
    .toggle-slider::before {
      content: ''; position: absolute; width: 14px; height: 14px;
      left: 3px; bottom: 3px; background: var(--text); border-radius: 50%;
      transition: transform 0.2s;
    }
    .toggle input:checked + .toggle-slider { background: var(--green); }
    .toggle input:checked + .toggle-slider::before { transform: translateX(16px); background: var(--bg); }
    /* Main layout */
    .main { padding: 1rem 1.5rem; max-width: 1600px; margin: 0 auto; }
    /* Summary cards */
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; margin-bottom: 1.25rem; }
    .card {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 8px; padding: 1rem;
    }
    .card h3 { color: var(--text-dim); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 0.25rem; }
    .card .value { font-size: 1.75rem; font-weight: 700; }
    .card .value.green { color: var(--green); }
    .card .value.red { color: var(--red); }
    .card .value.blue { color: var(--blue); }
    .card .value.yellow { color: var(--yellow); }
    /* Controls bar */
    .controls {
      display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center;
      margin-bottom: 0.75rem; padding: 0.5rem 0;
    }
    .search-box {
      background: var(--bg); border: 1px solid var(--border); color: var(--text);
      padding: 5px 10px; border-radius: 6px; font-size: 0.8rem; min-width: 180px;
    }
    .search-box:focus { outline: none; border-color: var(--blue); }
    .filter-select {
      background: var(--bg); border: 1px solid var(--border); color: var(--text);
      padding: 5px 8px; border-radius: 6px; font-size: 0.8rem;
    }
    .controls-right { margin-left: auto; display: flex; gap: 0.5rem; }
    /* Agent table */
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 0.6rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
    th {
      color: var(--text-dim); font-weight: 500; font-size: 0.75rem;
      text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer;
      user-select: none; position: sticky; top: 0; background: var(--bg-card);
    }
    th:hover { color: var(--text); }
    th .sort-icon { font-size: 0.65rem; margin-left: 3px; opacity: 0.4; }
    th.sorted .sort-icon { opacity: 1; color: var(--blue); }
    tr:hover { background: var(--bg-hover); }
    /* Status badge */
    .status-badge {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 500;
    }
    .status-badge.running { background: rgba(126,231,135,0.12); color: var(--green); }
    .status-badge.stopped { background: rgba(248,81,73,0.12); color: var(--red); }
    .status-badge.created { background: rgba(210,153,34,0.12); color: var(--yellow); }
    .status-badge.unknown, .status-badge.missing { background: rgba(110,118,129,0.12); color: #6e7681; }
    .status-badge.unreachable { background: rgba(210,153,34,0.12); color: var(--yellow); }
    .status-badge.orphaned-running { background: rgba(88,166,255,0.12); color: var(--blue); }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
    /* Role badge */
    .role-badge {
      display: inline-block; padding: 1px 7px; border-radius: 10px;
      font-size: 0.7rem; font-weight: 500; border: 1px solid;
    }
    .role-badge.brain { color: var(--purple); border-color: rgba(188,140,255,0.3); }
    .role-badge.coding { color: var(--blue); border-color: rgba(88,166,255,0.3); }
    .role-badge.security { color: var(--red); border-color: rgba(248,81,73,0.3); }
    .role-badge.ops { color: var(--green); border-color: rgba(126,231,135,0.3); }
    .role-badge.review { color: var(--yellow); border-color: rgba(210,153,34,0.3); }
    .role-badge.custom { color: var(--text-dim); border-color: var(--border); }
    /* Runtime badge */
    .runtime-badge {
      font-size: 0.7rem; color: var(--text-dim);
    }
    .runtime-badge.docker::before { content: '🐳 '; }
    .runtime-badge.native::before { content: '💻 '; }
    /* Action buttons */
    .actions { display: flex; gap: 3px; }
    .action-btn {
      background: transparent; border: 1px solid transparent; color: var(--text-dim);
      padding: 3px 6px; border-radius: 4px; cursor: pointer; font-size: 0.8rem;
      transition: all 0.15s; line-height: 1;
    }
    .action-btn:hover { background: var(--bg); border-color: var(--border); color: var(--text); }
    .action-btn.danger:hover { color: var(--red); border-color: rgba(248,81,73,0.3); }
    .action-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .action-btn.spinning { animation: spin 1s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    /* Machine table */
    .machine-section { margin-top: 1.5rem; }
    .section-title {
      font-size: 0.85rem; color: var(--text-dim); margin-bottom: 0.75rem;
      display: flex; align-items: center; gap: 0.5rem;
    }
    .machine-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 0.75rem; }
    .machine-card {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 8px; padding: 0.75rem 1rem;
    }
    .machine-card .mc-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
    .machine-card .mc-name { font-weight: 600; color: var(--text); }
    .machine-card .mc-ip { font-size: 0.75rem; color: var(--text-dim); font-family: monospace; }
    .machine-card .mc-detail { font-size: 0.75rem; color: var(--text-dim); margin-top: 0.25rem; }
    /* Modal */
    .modal-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.6);
      display: none; justify-content: center; align-items: center;
      z-index: 1000; padding: 1rem;
    }
    .modal-overlay.open { display: flex; }
    .modal {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 12px; width: 100%; max-width: 700px; max-height: 80vh;
      display: flex; flex-direction: column;
    }
    .modal-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 0.75rem 1rem; border-bottom: 1px solid var(--border);
    }
    .modal-header h2 { font-size: 1rem; }
    .modal-close { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 1.2rem; padding: 4px; }
    .modal-close:hover { color: var(--text); }
    .modal-body { padding: 1rem; overflow-y: auto; flex: 1; }
    /* Logs */
    .log-content {
      background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
      padding: 0.75rem; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.75rem;
      line-height: 1.5; white-space: pre-wrap; word-break: break-all;
      max-height: 60vh; overflow-y: auto; color: var(--text-dim);
    }
    /* Form */
    .form-group { margin-bottom: 0.75rem; }
    .form-group label { display: block; font-size: 0.8rem; color: var(--text-dim); margin-bottom: 0.25rem; }
    .form-input {
      width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text);
      padding: 6px 10px; border-radius: 6px; font-size: 0.85rem;
    }
    .form-input:focus { outline: none; border-color: var(--blue); }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    .form-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid var(--border); }
    .dry-run-preview {
      background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
      padding: 0.75rem; font-family: monospace; font-size: 0.75rem; margin-top: 0.75rem;
    }
    /* Toast */
    .toast-container { position: fixed; top: 60px; right: 16px; z-index: 2000; display: flex; flex-direction: column; gap: 8px; }
    .toast {
      background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
      padding: 0.6rem 1rem; font-size: 0.8rem; min-width: 250px; max-width: 400px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4); animation: slideIn 0.2s ease;
      display: flex; align-items: center; gap: 8px;
    }
    .toast.success { border-left: 3px solid var(--green); }
    .toast.error { border-left: 3px solid var(--red); }
    .toast.info { border-left: 3px solid var(--blue); }
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    /* Confirm dialog */
    .confirm-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.6);
      display: none; justify-content: center; align-items: center; z-index: 3000;
    }
    .confirm-overlay.open { display: flex; }
    .confirm-dialog {
      background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;
      padding: 1.25rem; width: 90%; max-width: 380px; text-align: center;
    }
    .confirm-dialog h3 { margin-bottom: 0.5rem; }
    .confirm-dialog p { color: var(--text-dim); font-size: 0.85rem; margin-bottom: 1rem; }
    .confirm-dialog .confirm-actions { display: flex; justify-content: center; gap: 0.5rem; }
    /* Loading */
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--blue); border-radius: 50%; animation: spin 0.6s linear infinite; }
    .loading-row td { text-align: center; color: var(--text-dim); padding: 2rem; }
    /* Responsive */
    @media (max-width: 768px) {
      .header { padding: 0.5rem 1rem; }
      .header h1 { font-size: 1rem; }
      .main { padding: 0.75rem; }
      .summary { grid-template-columns: repeat(2, 1fr); }
      .card { padding: 0.75rem; }
      .card .value { font-size: 1.4rem; }
      .controls { gap: 0.25rem; }
      .search-box { min-width: 120px; flex: 1; }
      table { font-size: 0.8rem; }
      th, td { padding: 0.5rem; }
      .actions { gap: 1px; }
      .machine-grid { grid-template-columns: 1fr; }
      .form-row { grid-template-columns: 1fr; }
    }
    @media (max-width: 480px) {
      .summary { grid-template-columns: repeat(2, 1fr); gap: 0.5rem; }
      .header-right { width: 100%; justify-content: flex-end; }
      .controls-right { margin-left: 0; width: 100%; justify-content: flex-end; }
    }
    /* Empty state */
    .empty-state { text-align: center; padding: 3rem; color: var(--text-dim); }
    .empty-state .empty-icon { font-size: 2rem; margin-bottom: 0.5rem; }
  </style>
</head>
<body>
  <!-- Header -->
  <div class="header">
    <div class="header-left">
      <h1>🚀 BSCS Fleet</h1>
      <span class="fleet-info" id="fleet-info"></span>
    </div>
    <div class="header-right">
      <div class="conn-badge" id="conn-badge">
        <span class="conn-dot"></span>
        <span id="conn-text">Connecting</span>
      </div>
      <label class="toggle" title="Auto-refresh">
        <input type="checkbox" id="auto-refresh" checked>
        <span class="toggle-slider"></span>
      </label>
      <button class="btn btn-sm" onclick="runDoctor()" id="doctor-btn">🩺 Doctor</button>
      <button class="btn btn-sm" onclick="refreshData()" id="refresh-btn">↻ Refresh</button>
    </div>
  </div>

  <!-- Main -->
  <div class="main">
    <!-- Summary -->
    <div class="summary">
      <div class="card"><h3>Total Agents</h3><div class="value blue" id="stat-total">-</div></div>
      <div class="card"><h3>Running</h3><div class="value green" id="stat-running">-</div></div>
      <div class="card"><h3>Stopped</h3><div class="value red" id="stat-stopped">-</div></div>
      <div class="card"><h3>Machines</h3><div class="value yellow" id="stat-machines">-</div></div>
    </div>

    <!-- Agent Table -->
    <div class="card" style="padding: 0; overflow: hidden;">
      <div style="padding: 0.75rem; border-bottom: 1px solid var(--border);">
        <div class="controls">
          <input type="text" class="search-box" id="search-input" placeholder="Search agents…" oninput="applyFilters()">
          <select class="filter-select" id="filter-status" onchange="applyFilters()">
            <option value="">All status</option>
            <option value="running">Running</option>
            <option value="stopped">Stopped</option>
            <option value="created">Created</option>
            <option value="unreachable">Unreachable</option>
            <option value="missing">Missing</option>
          </select>
          <select class="filter-select" id="filter-machine" onchange="applyFilters()">
            <option value="">All machines</option>
          </select>
          <select class="filter-select" id="filter-role" onchange="applyFilters()">
            <option value="">All roles</option>
            <option value="brain">Brain</option>
            <option value="coding">Coding</option>
            <option value="security">Security</option>
            <option value="ops">Ops</option>
            <option value="review">Review</option>
            <option value="custom">Custom</option>
          </select>
          <select class="filter-select" id="filter-runtime" onchange="applyFilters()">
            <option value="">All runtimes</option>
            <option value="docker">Docker</option>
            <option value="native">Native</option>
          </select>
          <div class="controls-right">
            <button class="btn btn-primary btn-sm" onclick="openCreateModal()">+ Create Agent</button>
          </div>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th data-col="name" onclick="sortBy('name')">Name <span class="sort-icon">▲</span></th>
              <th data-col="status" onclick="sortBy('status')">Status <span class="sort-icon">▲</span></th>
              <th data-col="role" onclick="sortBy('role')">Role <span class="sort-icon">▲</span></th>
              <th data-col="runtime" onclick="sortBy('runtime')">Runtime <span class="sort-icon">▲</span></th>
              <th data-col="machineName" onclick="sortBy('machineName')">Machine <span class="sort-icon">▲</span></th>
              <th data-col="ports" onclick="sortBy('ports')">Ports <span class="sort-icon">▲</span></th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="agents-body">
            <tr class="loading-row"><td colspan="7"><span class="spinner"></span> Loading fleet data…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Machine Section -->
    <div class="machine-section">
      <div class="section-title">🖥️ Machines <span id="machine-count"></span></div>
      <div class="machine-grid" id="machines-grid">
        <div style="color: var(--text-dim); font-size: 0.85rem;">Loading machines…</div>
      </div>
    </div>
  </div>

  <!-- Toast container -->
  <div class="toast-container" id="toast-container"></div>

  <!-- Logs Modal -->
  <div class="modal-overlay" id="logs-modal">
    <div class="modal">
      <div class="modal-header">
        <h2>📋 <span id="logs-agent-name"></span> Logs</h2>
        <button class="modal-close" onclick="closeModal('logs-modal')">✕</button>
      </div>
      <div class="modal-body">
        <div class="log-content" id="logs-content">Loading…</div>
      </div>
    </div>
  </div>

  <!-- Create Agent Modal -->
  <div class="modal-overlay" id="create-modal">
    <div class="modal">
      <div class="modal-header">
        <h2>+ Create Agent</h2>
        <button class="modal-close" onclick="closeModal('create-modal')">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label>Name *</label>
            <input type="text" class="form-input" id="create-name" placeholder="my-agent" pattern="^[a-z][a-z0-9-]{1,30}$">
          </div>
          <div class="form-group">
            <label>Role</label>
            <select class="form-input" id="create-role">
              <option value="custom">custom</option>
              <option value="coding">coding</option>
              <option value="brain">brain</option>
              <option value="review">review</option>
              <option value="security">security</option>
              <option value="ops">ops</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Machine</label>
            <select class="form-input" id="create-machine"></select>
          </div>
          <div class="form-group">
            <label>Model</label>
            <select class="form-input" id="create-model-select" onchange="onModelSelectChange('create-model-select','create-model-custom')">
              <option value="">— default —</option>
              <option value="claude-opus-4-6">claude-opus-4-6</option>
              <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
              <option value="claude-haiku-3.5">claude-haiku-3.5</option>
              <option value="gpt-4o">gpt-4o</option>
              <option value="gpt-4o-mini">gpt-4o-mini</option>
              <option value="gemini-2.5-pro">gemini-2.5-pro</option>
              <option value="deepseek-v3">deepseek-v3</option>
              <option value="__custom__">Custom…</option>
            </select>
            <input type="text" class="form-input" id="create-model-custom" placeholder="Enter custom model" style="display:none;margin-top:4px;">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Fallback Model (optional)</label>
            <select class="form-input" id="create-fallback-select" onchange="onModelSelectChange('create-fallback-select','create-fallback-custom')">
              <option value="">— none —</option>
              <option value="claude-opus-4-6">claude-opus-4-6</option>
              <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
              <option value="claude-haiku-3.5">claude-haiku-3.5</option>
              <option value="gpt-4o">gpt-4o</option>
              <option value="gpt-4o-mini">gpt-4o-mini</option>
              <option value="gemini-2.5-pro">gemini-2.5-pro</option>
              <option value="deepseek-v3">deepseek-v3</option>
              <option value="__custom__">Custom…</option>
            </select>
            <input type="text" class="form-input" id="create-fallback-custom" placeholder="Enter custom model" style="display:none;margin-top:4px;">
          </div>
          <div class="form-group">
            <label>Image (optional)</label>
            <input type="text" class="form-input" id="create-image" placeholder="openclaw-fleet:latest">
          </div>
        </div>
        <div id="create-preview" class="dry-run-preview" style="display:none;"></div>
        <div class="form-actions">
          <button class="btn btn-sm" onclick="dryRunCreate()">Preview</button>
          <button class="btn btn-sm" onclick="closeModal('create-modal')">Cancel</button>
          <button class="btn btn-primary btn-sm" onclick="submitCreate()" id="create-submit">Create</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Confirm Dialog -->
  <div class="confirm-overlay" id="confirm-overlay">
    <div class="confirm-dialog">
      <h3 id="confirm-title">Confirm</h3>
      <p id="confirm-message">Are you sure?</p>
      <div class="confirm-actions">
        <button class="btn btn-sm" onclick="closeConfirm(false)">Cancel</button>
        <button class="btn btn-danger btn-sm" id="confirm-ok" onclick="closeConfirm(true)">Confirm</button>
      </div>
    </div>
  </div>

  <!-- Doctor Modal -->
  <div class="modal-overlay" id="doctor-modal">
    <div class="modal" style="max-width:850px;">
      <div class="modal-header">
        <h2>🩺 Fleet Doctor</h2>
        <div style="display:flex;align-items:center;gap:0.75rem;">
          <label style="font-size:0.8rem;color:var(--text-dim);display:flex;align-items:center;gap:4px;">
            <input type="checkbox" id="doctor-deep-toggle"> Deep scan
          </label>
          <button class="btn btn-sm" onclick="runDoctor()" id="doctor-rerun-btn">Re-run</button>
          <button class="modal-close" onclick="closeModal('doctor-modal')">✕</button>
        </div>
      </div>
      <div class="modal-body">
        <div id="doctor-content" style="text-align:center;padding:2rem;color:var(--text-dim);">
          <span class="spinner"></span> Running checks…
        </div>
        <div id="doctor-score" style="text-align:center;margin-top:1rem;font-size:1.2rem;font-weight:700;display:none;"></div>
      </div>
    </div>
  </div>

<script>
// ===================== Safe Fetch Helper =====================
async function safeFetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!text) throw new Error('Empty response from server');
  const data = JSON.parse(text);
  if (!res.ok && !data.ok && !data.message) throw new Error('HTTP ' + res.status);
  return data;
}

// ===================== State =====================
let fleetData = null;
let machinesData = null;
let sortCol = 'name';
let sortDir = 'asc';
let confirmCallback = null;
let autoRefreshEnabled = true;
let pollTimer = null;
let busyAgents = new Set();

// ===================== Data Fetching =====================
async function fetchFleet() {
  try {
    fleetData = await safeFetchJson('/api/fleet');
    renderAll();
  } catch (err) {
    console.error('Fleet fetch error:', err);
    showToast('Failed to load fleet data: ' + err.message, 'error');
  }
}

async function fetchMachines() {
  try {
    const data = await safeFetchJson('/api/machines');
    machinesData = data.machines || [];
    renderMachines();
  } catch (err) {
    console.error('Machines fetch error:', err);
  }
}

async function refreshData() {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.textContent = '↻ …';
  await Promise.all([fetchFleet(), fetchMachines()]);
  btn.disabled = false;
  btn.textContent = '↻ Refresh';
}

// ===================== Rendering =====================
function renderAll() {
  if (!fleetData) return;
  const s = fleetData.summary || {};
  document.getElementById('stat-total').textContent = s.total || 0;
  document.getElementById('stat-running').textContent = s.running || 0;
  document.getElementById('stat-stopped').textContent = s.stopped || 0;
  const machineCount = Object.keys(fleetData.machines || {}).length;
  document.getElementById('stat-machines').textContent = machineCount;
  document.getElementById('fleet-info').textContent = fleetData.fleetName || '';
  populateMachineFilter();
  renderAgents();
}

function populateMachineFilter() {
  const sel = document.getElementById('filter-machine');
  const current = sel.value;
  const machines = new Set();
  (fleetData.agents || []).forEach(a => {
    machines.add(a.machineName || a.machine || 'unknown');
  });
  sel.innerHTML = '<option value="">All machines</option>';
  [...machines].sort().forEach(m => {
    sel.innerHTML += '<option value="' + m + '"' + (m === current ? ' selected' : '') + '>' + m + '</option>';
  });
  // Also populate create modal machine dropdown
  const createSel = document.getElementById('create-machine');
  const entries = Object.entries(fleetData.machines || {});
  createSel.innerHTML = entries.map(([ip, m]) =>
    '<option value="' + ip + '">' + ((m && m.name) || ip) + ' (' + ip + ')</option>'
  ).join('');
}

function getFilteredAgents() {
  if (!fleetData || !fleetData.agents) return [];
  const search = document.getElementById('search-input').value.toLowerCase();
  const statusF = document.getElementById('filter-status').value;
  const machineF = document.getElementById('filter-machine').value;
  const roleF = document.getElementById('filter-role').value;
  const runtimeF = document.getElementById('filter-runtime').value;

  let agents = fleetData.agents.filter(a => {
    if (search && !a.name.toLowerCase().includes(search)) return false;
    if (statusF && a.status !== statusF) return false;
    if (machineF && (a.machineName || a.machine) !== machineF) return false;
    if (roleF && a.role !== roleF) return false;
    if (runtimeF && (a.runtime || 'docker') !== runtimeF) return false;
    return true;
  });

  agents.sort((a, b) => {
    let av = getSortValue(a, sortCol);
    let bv = getSortValue(b, sortCol);
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  return agents;
}

function getSortValue(agent, col) {
  switch (col) {
    case 'name': return agent.name || '';
    case 'status': return agent.status || 'zzz';
    case 'role': return agent.role || 'zzz';
    case 'runtime': return agent.runtime || 'docker';
    case 'machineName': return agent.machineName || agent.machine || '';
    case 'ports': return (agent.ports && agent.ports.gateway) || 99999;
    default: return '';
  }
}

function renderAgents() {
  const agents = getFilteredAgents();
  const tbody = document.getElementById('agents-body');

  if (agents.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">🔍</div>No agents match filters</div></td></tr>';
    updateSortHeaders();
    return;
  }

  tbody.innerHTML = agents.map(a => {
    const isBusy = busyAgents.has(a.name);
    const isRunning = a.status === 'running';
    const isStopped = a.status === 'stopped' || a.status === 'created' || a.status === 'missing';
    const portsStr = a.ports ? [a.ports.gateway, a.ports.remote].filter(Boolean).join('/') || '-' : '-';

    return '<tr data-agent="' + a.name + '">' +
      '<td><strong>' + esc(a.name) + '</strong></td>' +
      '<td><span class="status-badge ' + (a.status || 'unknown') + '"><span class="status-dot"></span>' + esc(a.status || 'unknown') + '</span></td>' +
      '<td><span class="role-badge ' + (a.role || 'custom') + '">' + esc(a.role || '-') + '</span></td>' +
      '<td><span class="runtime-badge ' + (a.runtime || 'docker') + '">' + esc(a.runtime || 'docker') + '</span></td>' +
      '<td>' + esc(a.machineName || a.machine || '-') + '</td>' +
      '<td style="font-family:monospace;font-size:0.8rem;">' + portsStr + '</td>' +
      '<td><div class="actions">' +
        (isBusy ? '<span class="spinner"></span>' : (
          (isStopped ? '<button class="action-btn" title="Start" onclick="agentAction(\\''+a.name+'\\',\\'start\\')">▶</button>' : '') +
          (isRunning ? '<button class="action-btn" title="Stop" onclick="confirmAction(\\'Stop ' + a.name + '?\\',\\'This will stop the agent.\\',()=>agentAction(\\''+a.name+'\\',\\'stop\\'))">⏹</button>' : '') +
          (isRunning ? '<button class="action-btn" title="Restart" onclick="agentAction(\\''+a.name+'\\',\\'restart\\')">🔄</button>' : '') +
          '<button class="action-btn" title="Logs" onclick="showLogs(\\''+a.name+'\\')">📋</button>' +
          '<button class="action-btn danger" title="Delete" onclick="confirmAction(\\'Delete ' + a.name + '?\\',\\'This will remove the agent permanently.\\',()=>deleteAgent(\\''+a.name+'\\'))">🗑</button>'
        )) +
      '</div></td>' +
    '</tr>';
  }).join('');

  updateSortHeaders();
}

function updateSortHeaders() {
  document.querySelectorAll('th[data-col]').forEach(th => {
    const col = th.getAttribute('data-col');
    const icon = th.querySelector('.sort-icon');
    if (col === sortCol) {
      th.classList.add('sorted');
      icon.textContent = sortDir === 'asc' ? '▲' : '▼';
    } else {
      th.classList.remove('sorted');
      icon.textContent = '▲';
    }
  });
}

function renderMachines() {
  if (!machinesData || machinesData.length === 0) {
    // Fallback: render from fleet data
    if (fleetData && fleetData.machines) {
      const grid = document.getElementById('machines-grid');
      const entries = Object.entries(fleetData.machines);
      document.getElementById('machine-count').textContent = '(' + entries.length + ')';
      grid.innerHTML = entries.map(([ip, m]) => {
        const name = (m && m.name) || ip;
        const status = (m && m.status) || 'unknown';
        const count = (m && m.agentCount) || 0;
        const role = (m && m.role) || '-';
        const statusColor = status === 'online' ? 'var(--green)' : status === 'offline' ? 'var(--red)' : 'var(--text-dim)';
        return '<div class="machine-card">' +
          '<div class="mc-header"><span class="mc-name">' + esc(name) + '</span><span class="status-badge ' + (status === 'online' ? 'running' : 'stopped') + '"><span class="status-dot"></span>' + status + '</span></div>' +
          '<div class="mc-ip">' + esc(ip) + '</div>' +
          '<div class="mc-detail">Role: ' + esc(role) + ' · Agents: ' + count + '</div>' +
        '</div>';
      }).join('');
      return;
    }
    return;
  }

  const grid = document.getElementById('machines-grid');
  document.getElementById('machine-count').textContent = '(' + machinesData.length + ')';
  grid.innerHTML = machinesData.map(m => {
    const statusColor = m.status === 'online' ? 'var(--green)' : 'var(--red)';
    return '<div class="machine-card">' +
      '<div class="mc-header"><span class="mc-name">' + esc(m.name) + '</span><span class="status-badge ' + (m.status === 'online' ? 'running' : 'stopped') + '"><span class="status-dot"></span>' + m.status + '</span></div>' +
      '<div class="mc-ip">' + esc(m.ip) + '</div>' +
      '<div class="mc-detail">Role: ' + esc(m.role) + ' · Agents: ' + m.agentCount + '</div>' +
    '</div>';
  }).join('');
}

// ===================== Sorting & Filtering =====================
function sortBy(col) {
  if (sortCol === col) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortCol = col;
    sortDir = 'asc';
  }
  renderAgents();
}

function applyFilters() {
  renderAgents();
}

// ===================== Agent Actions =====================
async function agentAction(name, action) {
  busyAgents.add(name);
  renderAgents();

  try {
    const data = await safeFetchJson('/api/agent/' + name + '/' + action, { method: 'POST' });
    if (data.ok) {
      showToast(name + ' ' + action + 'ed', 'success');
    } else {
      showToast(action + ' failed: ' + (data.message || 'Unknown error'), 'error');
    }
  } catch (err) {
    showToast(action + ' failed: ' + err.message, 'error');
  }

  busyAgents.delete(name);
  // Refresh data after action
  setTimeout(() => fetchFleet(), 1500);
}

async function deleteAgent(name) {
  busyAgents.add(name);
  renderAgents();

  try {
    const data = await safeFetchJson('/api/agent/' + name, { method: 'DELETE' });
    if (data.ok) {
      showToast(name + ' deleted', 'success');
    } else {
      showToast('Delete failed: ' + (data.message || 'Unknown error'), 'error');
    }
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }

  busyAgents.delete(name);
  setTimeout(() => fetchFleet(), 1000);
}

async function showLogs(name) {
  var agent = fleetData && fleetData.agents && fleetData.agents.find(function(a) { return a.name === name; });
  var machineSuffix = agent ? ' (' + (agent.machineName || agent.machine || '') + ')' : '';
  document.getElementById('logs-agent-name').textContent = name + machineSuffix;
  document.getElementById('logs-content').textContent = 'Loading…';
  openModal('logs-modal');

  try {
    const data = await safeFetchJson('/api/agent/' + name + '/logs');
    document.getElementById('logs-content').textContent = data.logs || 'No logs available';
  } catch (err) {
    document.getElementById('logs-content').textContent = 'Error: ' + err.message;
  }
}

// ===================== Create Agent =====================
function openCreateModal() {
  document.getElementById('create-name').value = '';
  document.getElementById('create-role').value = 'custom';
  document.getElementById('create-model-select').value = '';
  document.getElementById('create-model-custom').value = '';
  document.getElementById('create-model-custom').style.display = 'none';
  document.getElementById('create-fallback-select').value = '';
  document.getElementById('create-fallback-custom').value = '';
  document.getElementById('create-fallback-custom').style.display = 'none';
  document.getElementById('create-image').value = '';
  document.getElementById('create-preview').style.display = 'none';
  openModal('create-modal');
}

function onModelSelectChange(selectId, customId) {
  const sel = document.getElementById(selectId);
  const custom = document.getElementById(customId);
  if (sel.value === '__custom__') {
    custom.style.display = 'block';
    custom.focus();
  } else {
    custom.style.display = 'none';
    custom.value = '';
  }
}

function getModelValue(selectId, customId) {
  const sel = document.getElementById(selectId).value;
  if (sel === '__custom__') return document.getElementById(customId).value.trim() || undefined;
  return sel || undefined;
}

async function dryRunCreate() {
  const payload = getCreatePayload();
  if (!payload) return;
  payload.dryRun = true;

  try {
    const data = await safeFetchJson('/api/agent', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const preview = document.getElementById('create-preview');
    if (data.ok) {
      preview.textContent = JSON.stringify(data.agent, null, 2);
      preview.style.display = 'block';
    } else {
      preview.textContent = 'Error: ' + (data.message || 'Unknown');
      preview.style.display = 'block';
    }
  } catch (err) {
    showToast('Preview failed: ' + err.message, 'error');
  }
}

async function submitCreate() {
  const payload = getCreatePayload();
  if (!payload) return;

  const btn = document.getElementById('create-submit');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    const data = await safeFetchJson('/api/agent', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    if (data.ok) {
      showToast('Agent "' + payload.name + '" created', 'success');
      closeModal('create-modal');
      setTimeout(() => fetchFleet(), 500);
    } else {
      showToast('Create failed: ' + (data.message || 'Unknown'), 'error');
    }
  } catch (err) {
    showToast('Create failed: ' + err.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Create';
}

function getCreatePayload() {
  const name = document.getElementById('create-name').value.trim();
  if (!name) { showToast('Name is required', 'error'); return null; }
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) { showToast('Invalid name format', 'error'); return null; }
  return {
    name,
    role: document.getElementById('create-role').value,
    machine: document.getElementById('create-machine').value,
    model: getModelValue('create-model-select', 'create-model-custom'),
    fallback: getModelValue('create-fallback-select', 'create-fallback-custom'),
    image: document.getElementById('create-image').value || undefined,
  };
}

// ===================== Modals & Confirm =====================
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function confirmAction(title, message, callback) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  confirmCallback = callback;
  document.getElementById('confirm-overlay').classList.add('open');
}

function closeConfirm(ok) {
  document.getElementById('confirm-overlay').classList.remove('open');
  if (ok && confirmCallback) confirmCallback();
  confirmCallback = null;
}

// Close modals on escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    closeConfirm(false);
  }
});

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
});

// ===================== Toast =====================
function showToast(message, type) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
  const icon = type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ';
  toast.innerHTML = '<span>' + icon + '</span><span>' + esc(message) + '</span>';
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 4000);
}

// ===================== Utility =====================
function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

// ===================== WebSocket =====================
let ws;
let wsRetries = 0;
const MAX_WS_RETRIES = 3;

function connectWS() {
  if (wsRetries >= MAX_WS_RETRIES) {
    startPolling();
    return;
  }

  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');

    ws.onopen = () => {
      wsRetries = 0;
      setBadge('live');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'fleet-update') {
          fleetData = msg.data;
          renderAll();
        }
      } catch {}
    };

    ws.onclose = () => {
      wsRetries++;
      setBadge('polling');
      setTimeout(connectWS, 5000);
    };

    ws.onerror = () => {
      wsRetries++;
      try { ws.close(); } catch {}
    };
  } catch {
    startPolling();
  }
}

function startPolling() {
  setBadge('polling');
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (autoRefreshEnabled) fetchFleet();
    }, 10000);
  }
}

function setBadge(state) {
  const badge = document.getElementById('conn-badge');
  const text = document.getElementById('conn-text');
  badge.className = 'conn-badge';
  if (state === 'live') { text.textContent = 'Live'; }
  else if (state === 'polling') { badge.classList.add('polling'); text.textContent = 'Polling'; }
  else { badge.classList.add('offline'); text.textContent = 'Offline'; }
}

// Auto-refresh toggle
document.getElementById('auto-refresh').addEventListener('change', e => {
  autoRefreshEnabled = e.target.checked;
  if (autoRefreshEnabled && !pollTimer) startPolling();
  if (!autoRefreshEnabled && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
});

// ===================== Doctor =====================
async function runDoctor() {
  document.getElementById('doctor-content').innerHTML = '<span class="spinner"></span> Running checks…';
  document.getElementById('doctor-score').style.display = 'none';
  openModal('doctor-modal');

  var deep = document.getElementById('doctor-deep-toggle').checked;
  var url = '/api/doctor' + (deep ? '?deep=true' : '');

  try {
    var data = await safeFetchJson(url);
    var checks = data.checks || [];

    // Status icon map
    function statusIcon(s) {
      if (s === 'ok') return '✅';
      if (s === 'warn') return '⚠️';
      if (s === 'critical') return '🔴';
      if (s === 'skip') return '⊘';
      return '❌';
    }
    function statusColor(s) {
      if (s === 'ok') return 'var(--green)';
      if (s === 'warn') return 'var(--yellow)';
      if (s === 'skip') return 'var(--text-dim)';
      return 'var(--red)';
    }

    // Group checks by category + target
    var groups = {};
    checks.forEach(function(c) {
      var key = c.category + '|' + c.target;
      if (!groups[key]) groups[key] = { category: c.category, target: c.target, checks: [] };
      groups[key].checks.push(c);
    });

    var html = '';

    // Render each group
    Object.values(groups).forEach(function(g) {
      var label = '';
      if (g.category === 'machine') {
        var mObj = data.machines && data.machines[g.target];
        var mStatus = mObj ? (mObj.status || mObj) : 'unknown';
        var mColor = mStatus === 'online' ? 'var(--green)' : 'var(--red)';
        var mName = (mObj && mObj.name) ? mObj.name : g.target;
        var mIp = mName !== g.target ? ' (' + esc(g.target) + ')' : '';
        label = '🖥️ Machine: ' + esc(mName) + mIp + ' <span style="color:' + mColor + ';font-size:0.75rem;">[' + mStatus + ']</span>';
      } else if (g.category === 'agent') {
        label = '🤖 Agent: ' + esc(g.target);
      } else {
        label = '🌐 Fleet';
      }

      html += '<div style="margin-bottom:1rem;"><div style="font-weight:600;font-size:0.9rem;margin-bottom:0.4rem;border-bottom:1px solid var(--border);padding-bottom:0.3rem;">' + label + '</div>';
      html += '<table style="width:100%;border-collapse:collapse;">';
      g.checks.forEach(function(c) {
        html += '<tr>' +
          '<td style="padding:3px 8px;width:40%;font-size:0.8rem;">' + esc(c.name) + '</td>' +
          '<td style="padding:3px 8px;width:10%;color:' + statusColor(c.status) + ';font-size:0.8rem;">' + statusIcon(c.status) + '</td>' +
          '<td style="padding:3px 8px;color:var(--text-dim);font-size:0.8rem;">' + esc(c.message || '');
        if (c.details) html += ' <span style="opacity:0.7;">(' + esc(c.details) + ')</span>';
        if (c.fix && c.fixCommand) {
          var btnClass = c.autoFixable ? 'btn-primary' : '';
          html += ' <button class="btn btn-sm ' + btnClass + '" style="font-size:0.7rem;padding:1px 6px;margin-left:4px;" onclick="fixDoctorCheck(\'' + esc(c.fixCommand).replace(/'/g, "\\\\'") + '\',\'' + esc(c.fixTarget || 'local') + '\',this)" title="' + esc(c.fix) + '">🔧 Fix</button>';
        } else if (c.fix) {
          html += ' <span style="color:var(--blue);font-size:0.7rem;" title="' + esc(c.fix) + '">💡 ' + esc(c.fix) + '</span>';
        }
        html += '</td></tr>';
      });
      html += '</table></div>';
    });

    document.getElementById('doctor-content').innerHTML = html || '<div style="text-align:center;color:var(--text-dim);">No checks returned</div>';

    // Score
    var s = data.score || {};
    var scorable = (s.total || 0) - (s.skip || 0);
    var scoreText = (s.ok || 0) + '/' + scorable + ' passed';
    var parts = [scoreText];
    if (s.warn) parts.push(s.warn + ' warning(s)');
    if (s.error) parts.push(s.error + ' error(s)');
    if (s.critical) parts.push(s.critical + ' critical');
    var scoreEl = document.getElementById('doctor-score');
    scoreEl.innerHTML = parts.join(' | ') + '<br><span style="font-size:0.8rem;color:var(--text-dim);font-weight:400;">' + data.mode + ' mode · ' + ((data.duration || 0) / 1000).toFixed(1) + 's</span>';
    scoreEl.style.color = (s.error || s.critical) ? 'var(--red)' : s.warn ? 'var(--yellow)' : 'var(--green)';
    scoreEl.style.display = 'block';

    // Add "Fix All" button if there are auto-fixable issues
    var autoFixable = checks.filter(function(c) { return c.autoFixable && c.fixCommand && c.status !== 'ok'; });
    if (autoFixable.length > 0) {
      scoreEl.innerHTML += '<br><button class="btn btn-primary btn-sm" style="margin-top:0.5rem;" onclick="fixAllDoctor()">🔧 Fix All (' + autoFixable.length + ' auto-fixable)</button>';
    }

    // Store checks for fixAll
    window._doctorChecks = checks;
  } catch (err) {
    document.getElementById('doctor-content').innerHTML = '<div style="color:var(--red);text-align:center;">❌ Doctor failed: ' + esc(err.message) + '</div>';
  }
}

async function fixDoctorCheck(command, target, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    var data = await safeFetchJson('/api/doctor/fix', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ command: command, target: target })
    });
    if (data.ok) {
      showToast('Fix applied: ' + (data.output || 'OK'), 'success');
      if (btn) { btn.textContent = '✅'; btn.style.color = 'var(--green)'; }
    } else {
      showToast('Fix failed: ' + (data.output || 'Unknown error'), 'error');
      if (btn) { btn.textContent = '❌'; btn.disabled = false; }
    }
  } catch (err) {
    showToast('Fix failed: ' + err.message, 'error');
    if (btn) { btn.textContent = '❌'; btn.disabled = false; }
  }
}

async function fixAllDoctor() {
  var checks = window._doctorChecks || [];
  var fixable = checks.filter(function(c) { return c.autoFixable && c.fixCommand && c.status !== 'ok'; });
  if (fixable.length === 0) { showToast('No auto-fixable issues', 'info'); return; }

  showToast('Fixing ' + fixable.length + ' issue(s)…', 'info');

  for (var i = 0; i < fixable.length; i++) {
    var c = fixable[i];
    try {
      await safeFetchJson('/api/doctor/fix', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ command: c.fixCommand, target: c.fixTarget || 'local' })
      });
    } catch (err) {
      showToast('Fix failed for ' + c.name + ': ' + err.message, 'error');
    }
  }

  showToast('All fixes applied — re-running doctor…', 'success');
  setTimeout(function() { runDoctor(); }, 2000);
}

// ===================== Init =====================
fetchFleet();
fetchMachines();
connectWS();
</script>
</body>
</html>`;
}

export function createDashboardCommand(): Command {
  const command = new Command('dashboard')
    .description('Start the BSCS web dashboard')
    .option('-p, --port <port>', 'Port to listen on', '3200')
    .option('--no-open', 'Do not open browser automatically')
    .action(async (options: { port: string; open: boolean }) => {
      const port = parseInt(options.port, 10);
      
      try {
        const server = await startDashboardServer(port);
        
        console.log();
        console.log(chalk.bold.cyan('📊 BSCS Dashboard'));
        console.log();
        console.log(chalk.dim('   URL:'), chalk.white(`http://localhost:${port}`));
        console.log(chalk.dim('   API:'), chalk.white(`http://localhost:${port}/api/fleet`));
        console.log();
        console.log(chalk.dim('Press Ctrl+C to stop'));
        console.log();
        
        if (options.open) {
          try {
            const platform = process.platform;
            const url = `http://localhost:${port}`;
            
            if (platform === 'darwin') {
              execSync(`open ${url}`);
            } else if (platform === 'linux') {
              execSync(`xdg-open ${url}`);
            } else if (platform === 'win32') {
              execSync(`start ${url}`);
            }
          } catch {
            // Failed to open browser, ignore
          }
        }
        
        process.on('SIGINT', () => {
          console.log(chalk.dim('\nShutting down...'));
          server.close();
          process.exit(0);
        });
        
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to start dashboard: ${message}`));
        process.exit(1);
      }
    });
  
  return command;
}
