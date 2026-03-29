import { createServer } from 'http';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { createLogger } from '../util/logger.js';
import { getFleetStatus } from '../cli/fleet/status.js';
import { getMachineStatus } from '../cli/machine/index.js';
import { Command } from 'commander';
import { createHash } from 'crypto';

const logger = createLogger('dashboard');

// WebSocket clients
const wsClients: Set<any> = new Set();

export interface DashboardServer {
  port: number;
  close: () => void;
}

export function startDashboardServer(port = 3200): Promise<DashboardServer> {
  return new Promise((resolve, reject) => {
    logger.debug({ port }, 'Starting dashboard server');
    
    const server = createServer(async (req, res) => {
      const url = req.url || '/';
      
      // API routes
      if (url.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
        
        try {
          if (url === '/api/fleet') {
            const status = await getFleetStatus(true);
            res.end(JSON.stringify(status));
            return;
          }
          
          if (url === '/api/machine') {
            const status = await getMachineStatus();
            res.end(JSON.stringify(status));
            return;
          }
          
          // Health check
          if (url === '/api/health') {
            res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
            return;
          }
          
          // Unknown API route
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Not found' }));
          
        } catch (err) {
          logger.error({ err }, 'API error');
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
      }
      
      // Static files - serve dashboard UI
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const dashboardDir = join(__dirname, 'ui');
      
      // Default to index.html
      let filePath = url === '/' 
        ? join(dashboardDir, 'index.html')
        : join(dashboardDir, url);
      
      // Security: prevent directory traversal
      if (!filePath.startsWith(dashboardDir)) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }
      
      if (!existsSync(filePath)) {
        // SPA fallback to index.html
        filePath = join(dashboardDir, 'index.html');
      }
      
      if (!existsSync(filePath)) {
        // Serve embedded HTML if no files exist
        if (url === '/' || !url.includes('.')) {
          res.setHeader('Content-Type', 'text/html');
          res.end(getEmbeddedHtml());
          return;
        }
        
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      
      // Determine content type
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
      } catch (err) {
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
  // Simple WebSocket handshake
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
  
  // Send initial status
  broadcastUpdate();
}

function generateWebSocketAcceptKey(key: string): string {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

// Broadcast updates to all WebSocket clients
export async function broadcastUpdate(): Promise<void> {
  if (wsClients.size === 0) return;
  
  try {
    const status = await getFleetStatus(true);
    const message = JSON.stringify({ type: 'fleet-update', data: status });
    
    // Simple text frame (opcode 0x81)
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

// Embedded HTML for the dashboard (no external files needed)
function getEmbeddedHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BSCS Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      min-height: 100vh;
    }
    .header {
      background: #161b22;
      padding: 1rem 2rem;
      border-bottom: 1px solid #30363d;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header h1 { color: #58a6ff; font-size: 1.5rem; }
    .header .status { color: #7ee787; font-size: 0.9rem; }
    .main { padding: 2rem; max-width: 1400px; margin: 0 auto; }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 1.5rem;
    }
    .card h3 { color: #8b949e; font-size: 0.85rem; margin-bottom: 0.5rem; }
    .card .value { font-size: 2rem; font-weight: bold; }
    .card .value.green { color: #7ee787; }
    .card .value.red { color: #f85149; }
    .card .value.yellow { color: #d29922; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #30363d; }
    th { color: #8b949e; font-weight: 500; }
    .status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
    .status-dot.running { background: #7ee787; }
    .status-dot.stopped { background: #f85149; }
    .status-dot.created { background: #d29922; }
    .status-dot.unknown, .status-dot.missing { background: #6e7681; }
    .loading { text-align: center; padding: 4rem; color: #8b949e; }
    .error { color: #f85149; text-align: center; padding: 2rem; }
    .refresh-btn {
      background: #21262d;
      border: 1px solid #30363d;
      color: #c9d1d9;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
    }
    .refresh-btn:hover { background: #30363d; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🚀 BSCS Dashboard</h1>
    <div>
      <span class="status" id="connection-status">● Connected</span>
      <button class="refresh-btn" onclick="refreshData()">Refresh</button>
    </div>
  </div>
  <div class="main">
    <div class="summary" id="summary">
      <div class="card">
        <h3>Total Agents</h3>
        <div class="value" id="total-agents">-</div>
      </div>
      <div class="card">
        <h3>Running</h3>
        <div class="value green" id="running-agents">-</div>
      </div>
      <div class="card">
        <h3>Stopped</h3>
        <div class="value red" id="stopped-agents">-</div>
      </div>
      <div class="card">
        <h3>Fleet Name</h3>
        <div class="value yellow" id="fleet-name">-</div>
      </div>
    </div>
    <div class="card">
      <h3>Agents</h3>
      <div id="agents-table">
        <div class="loading">Loading...</div>
      </div>
    </div>
  </div>
  <script>
    let ws;
    
    async function fetchData() {
      try {
        const res = await fetch('/api/fleet');
        const data = await res.json();
        updateUI(data);
      } catch (err) {
        document.getElementById('agents-table').innerHTML = 
          '<div class="error">Failed to load data: ' + err.message + '</div>';
      }
    }
    
    function updateUI(data) {
      document.getElementById('total-agents').textContent = data.summary.total;
      document.getElementById('running-agents').textContent = data.summary.running;
      document.getElementById('stopped-agents').textContent = data.summary.stopped;
      document.getElementById('fleet-name').textContent = data.fleetName;
      
      if (data.agents.length === 0) {
        document.getElementById('agents-table').innerHTML = 
          '<p style="color: #8b949e; padding: 1rem;">No agents configured. Run <code>bscs agent create &lt;name&gt;</code> to create one.</p>';
        return;
      }
      
      const html = '<table><thead><tr><th>Name</th><th>Status</th><th>Machine</th><th>Ports</th></tr></thead><tbody>' +
        data.agents.map(a => '<tr>' +
          '<td>' + a.name + '</td>' +
          '<td><span class="status-dot ' + a.status + '"></span>' + a.status + '</td>' +
          '<td>' + a.machine + '</td>' +
          '<td>' + (a.ports ? a.ports.gateway + '/' + a.ports.remote : '-') + '</td>' +
        '</tr>').join('') +
        '</tbody></table>';
      
      document.getElementById('agents-table').innerHTML = html;
    }
    
    function connectWebSocket() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host + '/ws');
      
      ws.onopen = () => {
        document.getElementById('connection-status').textContent = '● Connected';
        document.getElementById('connection-status').style.color = '#7ee787';
      };
      
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'fleet-update') {
            updateUI(msg.data);
          }
        } catch (e) {}
      };
      
      ws.onclose = () => {
        document.getElementById('connection-status').textContent = '○ Disconnected';
        document.getElementById('connection-status').style.color = '#f85149';
        setTimeout(connectWebSocket, 3000);
      };
    }
    
    function refreshData() {
      fetchData();
    }
    
    // Initial load
    fetchData();
    
    // WebSocket for real-time updates
    try {
      connectWebSocket();
    } catch (e) {
      console.log('WebSocket not available, using polling');
      setInterval(fetchData, 30000);
    }
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
        
        // Open browser if requested
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
        
        // Keep process running
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
