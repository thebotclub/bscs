import { exec, execSync } from 'child_process';
import { userInfo } from 'os';
import type { BscsConfig } from '../util/types.js';

// =============================================================================
// Types
// =============================================================================

export interface DoctorCheck {
  category: 'machine' | 'agent' | 'fleet';
  target: string;
  name: string;
  status: 'ok' | 'warn' | 'error' | 'critical' | 'skip';
  message: string;
  details?: string;
  fix?: string;           // Human-readable fix description
  fixCommand?: string;    // Actual command to run
  autoFixable?: boolean;  // Safe to auto-fix?
  fixTarget?: string;     // 'local' | sshAlias for remote
}

export interface DoctorResult {
  timestamp: string;
  mode: 'quick' | 'deep';
  duration: number;
  score: { ok: number; warn: number; error: number; critical: number; skip: number; total: number };
  checks: DoctorCheck[];
  machines: Record<string, 'online' | 'offline'>;
}

// =============================================================================
// Helpers
// =============================================================================

function executeCommand(command: string, timeoutMs = 10000): Promise<{ ok: boolean; output: string }> {
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

function getLocalIps(): string[] {
  try {
    const result = execSync(
      "/sbin/ifconfig 2>/dev/null | grep 'inet ' | awk '{print $2}' || ip -4 addr show 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1",
      { encoding: 'utf8', timeout: 3000 }
    );
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return ['127.0.0.1'];
  }
}

function isLocalMachine(host: string): boolean {
  const localIps = getLocalIps();
  return host === 'localhost' || host === '127.0.0.1' || localIps.includes(host);
}

function getSshTarget(machineHost: string, config: BscsConfig): string {
  const machine = config.machines?.[machineHost];
  if (machine?.sshAlias) return machine.sshAlias;
  const user = machine?.user || userInfo().username;
  return `${user}@${machineHost}`;
}

function sshCommand(target: string, cmd: string): string {
  const escaped = cmd.replace(/'/g, "'\\''");
  return `ssh -o ConnectTimeout=10 -o BatchMode=yes ${target} '${escaped}'`;
}

function remoteOrLocal(host: string, cmd: string, config: BscsConfig): string {
  if (isLocalMachine(host)) return cmd;
  const target = getSshTarget(host, config);
  return sshCommand(target, cmd);
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

async function detectOS(host: string, config: BscsConfig): Promise<'macos' | 'linux'> {
  const cmd = remoteOrLocal(host, 'uname -s', config);
  const result = await executeCommand(cmd, 5000);
  if (result.ok && result.output.trim().toLowerCase() === 'darwin') return 'macos';
  return 'linux';
}

// =============================================================================
// Fix Doctor Issues
// =============================================================================

function getFixTarget(host: string, config: BscsConfig): string {
  if (isLocalMachine(host)) return 'local';
  return config.machines?.[host]?.sshAlias || host;
}

export async function fixDoctorIssue(check: DoctorCheck, _config: BscsConfig): Promise<{ ok: boolean; message: string }> {
  if (!check.fixCommand) {
    return { ok: false, message: 'No fix command available for this check' };
  }

  const target = check.fixTarget || 'local';
  let cmd: string;

  if (target === 'local') {
    cmd = check.fixCommand;
  } else {
    // target is sshAlias or host — run via SSH
    const escaped = check.fixCommand.replace(/'/g, "'\\''");
    cmd = `ssh -o ConnectTimeout=10 -o BatchMode=yes ${target} '${escaped}'`;
  }

  const result = await executeCommand(cmd, 30000);
  if (result.ok) {
    return { ok: true, message: result.output || 'Fix applied successfully' };
  }
  return { ok: false, message: result.output || 'Fix command failed' };
}

// =============================================================================
// Machine Checks
// =============================================================================

async function checkSSH(host: string, config: BscsConfig): Promise<DoctorCheck> {
  if (isLocalMachine(host)) {
    return { category: 'machine', target: host, name: 'SSH', status: 'ok', message: 'Local machine' };
  }
  const target = getSshTarget(host, config);
  const result = await executeCommand(`ssh -o ConnectTimeout=10 -o BatchMode=yes ${target} 'echo ok'`);
  if (result.ok && result.output.includes('ok')) {
    return { category: 'machine', target: host, name: 'SSH', status: 'ok', message: 'Connected' };
  }
  return {
    category: 'machine', target: host, name: 'SSH', status: 'error', message: 'Connection failed',
    details: result.output, fix: `Ensure SSH key is authorized for ${target}`,
    fixCommand: `ssh-copy-id ${target}`, autoFixable: false, fixTarget: 'local',
  };
}

async function checkDocker(host: string, config: BscsConfig): Promise<DoctorCheck> {
  const cmd = remoteOrLocal(host,
    'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; docker version --format "{{.Server.Version}}" 2>/dev/null',
    config);
  const result = await executeCommand(cmd);
  if (result.ok && result.output) {
    return { category: 'machine', target: host, name: 'Docker', status: 'ok', message: `v${result.output}` };
  }
  return {
    category: 'machine', target: host, name: 'Docker', status: 'error', message: 'Not running',
    details: result.output, fix: 'Start Docker daemon',
    fixCommand: 'open -a Docker', autoFixable: false, fixTarget: getFixTarget(host, config),
  };
}

async function checkDisk(host: string, config: BscsConfig): Promise<DoctorCheck> {
  const cmd = remoteOrLocal(host, "df -h / | tail -1 | awk '{print $5, $4}'", config);
  const result = await executeCommand(cmd);
  if (!result.ok) {
    return { category: 'machine', target: host, name: 'Disk Space', status: 'error', message: 'Check failed', details: result.output };
  }
  const parts = result.output.split(/\s+/);
  const usedPct = parseInt((parts[0] || '0').replace('%', ''), 10);
  const free = parts[1] || '?';

  if (usedPct >= 90) {
    const ft = getFixTarget(host, config);
    return { category: 'machine', target: host, name: 'Disk Space', status: 'critical', message: `${usedPct}% used (${free} free)`,
      fix: 'Free disk space with docker system prune',
      fixCommand: 'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; docker system prune -f',
      autoFixable: false, fixTarget: ft };
  }
  if (usedPct >= 80) {
    const ft = getFixTarget(host, config);
    return { category: 'machine', target: host, name: 'Disk Space', status: 'warn', message: `${usedPct}% used (${free} free)`,
      fix: 'Consider freeing disk space with docker system prune',
      fixCommand: 'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; docker system prune -f',
      autoFixable: false, fixTarget: ft };
  }
  return { category: 'machine', target: host, name: 'Disk Space', status: 'ok', message: `${usedPct}% used (${free} free)` };
}

async function checkMemory(host: string, config: BscsConfig): Promise<DoctorCheck> {
  const os = await detectOS(host, config);
  let cmd: string;
  if (os === 'macos') {
    cmd = remoteOrLocal(host,
      "export PATH=\"/usr/sbin:/usr/bin:/opt/homebrew/bin:$PATH\"; sysctl -n hw.memsize 2>/dev/null && vm_stat 2>/dev/null | awk '/Pages free/{free=$3} /Pages inactive/{inactive=$3} END{gsub(/\\./,\"\",free); gsub(/\\./,\"\",inactive); print free+0, inactive+0}'",
      config);
  } else {
    cmd = remoteOrLocal(host, "free -m | awk '/Mem:/{print $2, $7}'", config);
  }
  const result = await executeCommand(cmd);
  if (!result.ok) {
    return { category: 'machine', target: host, name: 'Memory', status: 'error', message: 'Check failed', details: result.output };
  }

  let availableGB: number;
  if (os === 'macos') {
    const lines = result.output.trim().split('\n');
    const totalBytes = parseInt(lines[0] || '0', 10);
    const pageParts = (lines[1] || '0 0').split(/\s+/);
    const freePages = parseInt(pageParts[0] || '0', 10);
    const inactivePages = parseInt(pageParts[1] || '0', 10);
    const pageSize = 16384; // Apple Silicon default
    const availableBytes = (freePages + inactivePages) * pageSize;
    availableGB = availableBytes / (1024 * 1024 * 1024);
    if (availableGB <= 0 || isNaN(availableGB)) {
      // Fallback: use total and assume some is available
      const totalGB = totalBytes / (1024 * 1024 * 1024);
      availableGB = totalGB * 0.3; // rough estimate
    }
  } else {
    const parts = result.output.split(/\s+/);
    const availableMB = parseInt(parts[1] || '0', 10);
    availableGB = availableMB / 1024;
  }

  if (availableGB < 0.5) {
    return { category: 'machine', target: host, name: 'Memory', status: 'critical', message: `${availableGB.toFixed(1)}GB available`,
      fix: 'Free memory — stop unused containers', autoFixable: false, fixTarget: getFixTarget(host, config) };
  }
  if (availableGB < 1) {
    return { category: 'machine', target: host, name: 'Memory', status: 'warn', message: `${availableGB.toFixed(1)}GB available` };
  }
  return { category: 'machine', target: host, name: 'Memory', status: 'ok', message: `${availableGB.toFixed(1)}GB available` };
}

async function checkNodeVersion(host: string, config: BscsConfig): Promise<DoctorCheck> {
  const cmd = remoteOrLocal(host,
    'node --version 2>/dev/null || /opt/homebrew/opt/node@22/bin/node --version 2>/dev/null',
    config);
  const result = await executeCommand(cmd);
  if (result.ok && result.output.startsWith('v')) {
    return { category: 'machine', target: host, name: 'Node.js', status: 'ok', message: result.output };
  }
  return { category: 'machine', target: host, name: 'Node.js', status: 'warn', message: 'Not found', details: result.output };
}

async function checkOpenClawVersion(host: string, config: BscsConfig): Promise<DoctorCheck> {
  const cmd = remoteOrLocal(host,
    'openclaw --version 2>/dev/null || /opt/homebrew/lib/node_modules/openclaw/node_modules/.bin/openclaw --version 2>/dev/null',
    config);
  const result = await executeCommand(cmd);
  if (result.ok && result.output) {
    return { category: 'machine', target: host, name: 'OpenClaw', status: 'ok', message: result.output };
  }
  return { category: 'machine', target: host, name: 'OpenClaw', status: 'warn', message: 'Not found',
    fix: 'Install OpenClaw globally', fixCommand: 'npm install -g openclaw', autoFixable: false, fixTarget: getFixTarget(host, config) };
}

async function checkMachineHealth(host: string, config: BscsConfig): Promise<DoctorCheck[]> {
  const sshCheck = await checkSSH(host, config);
  if (sshCheck.status === 'error') {
    // Machine offline — skip remaining checks
    return [
      sshCheck,
      { category: 'machine', target: host, name: 'Docker', status: 'skip', message: 'Machine unreachable' },
      { category: 'machine', target: host, name: 'Disk Space', status: 'skip', message: 'Machine unreachable' },
      { category: 'machine', target: host, name: 'Memory', status: 'skip', message: 'Machine unreachable' },
      { category: 'machine', target: host, name: 'Node.js', status: 'skip', message: 'Machine unreachable' },
      { category: 'machine', target: host, name: 'OpenClaw', status: 'skip', message: 'Machine unreachable' },
    ];
  }

  const [docker, disk, memory, node, openclaw] = await Promise.all([
    checkDocker(host, config),
    checkDisk(host, config),
    checkMemory(host, config),
    checkNodeVersion(host, config),
    checkOpenClawVersion(host, config),
  ]);

  return [sshCheck, docker, disk, memory, node, openclaw];
}

// =============================================================================
// Agent Checks
// =============================================================================

async function checkAgentContainer(agentName: string, agentConfig: any, config: BscsConfig): Promise<DoctorCheck> {
  const machine = agentConfig.machine || 'localhost';
  const runtime = agentConfig.runtime || 'docker';
  const containerName = agentConfig.container || `openclaw_${agentName}`;

  if (runtime === 'native') {
    const gwPort = agentConfig.ports?.gateway || 18789;
    const cmd = remoteOrLocal(machine,
      `curl -s --max-time 3 http://127.0.0.1:${gwPort}/healthz 2>/dev/null`,
      config);
    const result = await executeCommand(cmd);
    if (result.ok && (result.output.includes('"ok"') || result.output.includes('"live"'))) {
      return { category: 'agent', target: agentName, name: 'Process', status: 'ok', message: 'running (native)' };
    }
    return { category: 'agent', target: agentName, name: 'Process', status: 'error', message: 'Not responding',
      fix: `Restart native agent: launchctl kickstart gui/$(id -u)/ai.openclaw.${agentName}`,
      fixCommand: `launchctl kickstart -k gui/$(id -u)/ai.openclaw.${agentName}`,
      autoFixable: false, fixTarget: getFixTarget(machine, config) };
  }

  // Docker runtime
  const cmd = remoteOrLocal(machine,
    `export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; docker inspect --format '{{.State.Status}}|{{.State.StartedAt}}|{{.State.Health.Status}}' ${containerName} 2>/dev/null`,
    config);
  const ft = getFixTarget(machine, config);
  const pathPrefix = 'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; ';
  const result = await executeCommand(cmd);
  if (!result.ok || !result.output) {
    return { category: 'agent', target: agentName, name: 'Container', status: 'error', message: 'Not found',
      fix: `Start container ${containerName}`, fixCommand: `${pathPrefix}docker start ${containerName}`,
      autoFixable: true, fixTarget: ft };
  }
  const [status, _startedAt, healthStr] = result.output.split('|');
  const health = healthStr && healthStr !== '<no value>' ? ` (${healthStr})` : '';
  if (status === 'running') {
    if (healthStr === 'unhealthy') {
      return { category: 'agent', target: agentName, name: 'Container', status: 'warn', message: `running (unhealthy)`,
        fix: `Restart container ${containerName}`, fixCommand: `${pathPrefix}docker restart ${containerName}`,
        autoFixable: true, fixTarget: ft };
    }
    return { category: 'agent', target: agentName, name: 'Container', status: 'ok', message: `running${health}` };
  }
  if (status === 'restarting') {
    return { category: 'agent', target: agentName, name: 'Container', status: 'error', message: 'restarting (crash loop)',
      fix: `Restart container ${containerName}`, fixCommand: `${pathPrefix}docker restart ${containerName}`,
      autoFixable: true, fixTarget: ft };
  }
  // exited, stopped, created, etc.
  return { category: 'agent', target: agentName, name: 'Container', status: 'error', message: status || 'unknown',
    fix: `Start container ${containerName}`, fixCommand: `${pathPrefix}docker start ${containerName}`,
    autoFixable: true, fixTarget: ft };
}

async function checkAgentGateway(agentName: string, agentConfig: any, config: BscsConfig): Promise<DoctorCheck> {
  const machine = agentConfig.machine || 'localhost';
  const gwPort = agentConfig.ports?.gateway;
  if (!gwPort) {
    return { category: 'agent', target: agentName, name: 'Gateway', status: 'skip', message: 'No gateway port configured' };
  }

  const runtime = agentConfig.runtime || 'docker';
  const containerName = agentConfig.container || `openclaw_${agentName}`;
  const pathPrefix = 'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; ';

  let cmd: string;
  if (runtime === 'docker') {
    // For Docker agents, check healthz INSIDE the container on the agent's actual gateway port
    // Each container may use a different port (not always 18789)
    const internalPort = gwPort;
    const dockerExec = `${pathPrefix}docker exec ${containerName} wget -q -O- http://127.0.0.1:${internalPort}/healthz 2>&1 || ${pathPrefix}docker exec ${containerName} curl -s --max-time 3 http://127.0.0.1:${internalPort}/healthz 2>&1`;
    cmd = remoteOrLocal(machine, dockerExec, config);
  } else {
    // For native agents, curl directly on the gateway port
    cmd = remoteOrLocal(machine,
      `curl -s --max-time 3 http://127.0.0.1:${gwPort}/healthz 2>/dev/null`,
      config);
  }

  const result = await executeCommand(cmd);
  const output = (result.output || '').toLowerCase();

  // Check for proper healthz JSON response (newer OpenClaw versions)
  if (result.ok && (output.includes('"ok"') || output.includes('"live"') || output.includes('"status"'))) {
    return { category: 'agent', target: agentName, name: 'Gateway', status: 'ok', message: 'Responding' };
  }

  // Check for control UI HTML response (older OpenClaw versions without /healthz endpoint)
  // These return the control UI HTML on all routes, which means the gateway IS running
  if (result.ok && (output.includes('<!doctype') || output.includes('openclaw-app'))) {
    return { category: 'agent', target: agentName, name: 'Gateway', status: 'ok', message: 'Responding (control UI)' };
  }

  const ft = getFixTarget(machine, config);
  if (runtime === 'docker') {
    return { category: 'agent', target: agentName, name: 'Gateway', status: 'error', message: 'Not responding',
      details: (result.output || 'No response').substring(0, 200),
      fix: `Restart container ${containerName}`, fixCommand: `${pathPrefix}docker restart ${containerName}`,
      autoFixable: true, fixTarget: ft };
  }
  return { category: 'agent', target: agentName, name: 'Gateway', status: 'error', message: 'Not responding',
    details: (result.output || 'No response').substring(0, 200),
    fix: 'Restart the native agent process', autoFixable: false, fixTarget: ft };
}

async function checkAgentUptime(agentName: string, agentConfig: any, config: BscsConfig): Promise<DoctorCheck> {
  const machine = agentConfig.machine || 'localhost';
  const runtime = agentConfig.runtime || 'docker';
  const containerName = agentConfig.container || `openclaw_${agentName}`;

  if (runtime !== 'docker') {
    return { category: 'agent', target: agentName, name: 'Uptime', status: 'skip', message: 'Native agent — uptime N/A' };
  }

  const cmd = remoteOrLocal(machine,
    `export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; docker inspect --format '{{.State.StartedAt}}' ${containerName} 2>/dev/null`,
    config);
  const result = await executeCommand(cmd);
  if (!result.ok || !result.output || result.output === '0001-01-01T00:00:00Z') {
    return { category: 'agent', target: agentName, name: 'Uptime', status: 'skip', message: 'Not running' };
  }

  const started = new Date(result.output);
  const uptimeSec = (Date.now() - started.getTime()) / 1000;

  if (uptimeSec < 300) {
    return { category: 'agent', target: agentName, name: 'Uptime', status: 'warn',
      message: formatUptime(uptimeSec), details: 'Started recently — possible crash loop' };
  }
  return { category: 'agent', target: agentName, name: 'Uptime', status: 'ok', message: formatUptime(uptimeSec) };
}

async function checkAgentHealth(agentName: string, agentConfig: any, config: BscsConfig): Promise<DoctorCheck[]> {
  const [container, gateway, uptime] = await Promise.all([
    checkAgentContainer(agentName, agentConfig, config),
    checkAgentGateway(agentName, agentConfig, config),
    checkAgentUptime(agentName, agentConfig, config),
  ]);
  return [container, gateway, uptime];
}

// =============================================================================
// Fleet Checks
// =============================================================================

function checkPortConflicts(config: BscsConfig): DoctorCheck {
  const agents = config.agents || {};
  const portMap = new Map<number, string[]>();

  for (const [name, agent] of Object.entries(agents)) {
    if (!agent) continue;
    const gw = agent.ports?.gateway;
    const rem = agent.ports?.remote;
    if (gw) {
      if (!portMap.has(gw)) portMap.set(gw, []);
      portMap.get(gw)!.push(name);
    }
    if (rem) {
      if (!portMap.has(rem)) portMap.set(rem, []);
      portMap.get(rem)!.push(name);
    }
  }

  const conflicts: string[] = [];
  for (const [port, names] of portMap) {
    // Only flag conflicts on same machine
    const byMachine = new Map<string, string[]>();
    for (const name of names) {
      const m = (agents as any)[name]?.machine || 'localhost';
      if (!byMachine.has(m)) byMachine.set(m, []);
      byMachine.get(m)!.push(name);
    }
    for (const [machine, machineNames] of byMachine) {
      if (machineNames.length > 1) {
        conflicts.push(`Port ${port} on ${machine}: ${machineNames.join(', ')}`);
      }
    }
  }

  if (conflicts.length > 0) {
    return { category: 'fleet', target: 'fleet', name: 'Port Conflicts', status: 'error',
      message: `${conflicts.length} conflict(s)`, details: conflicts.join('; '),
      fix: 'Reassign ports in bscs config' };
  }
  return { category: 'fleet', target: 'fleet', name: 'Port Conflicts', status: 'ok', message: 'No port conflicts' };
}

async function checkOrphanedContainers(config: BscsConfig): Promise<DoctorCheck> {
  const agents = config.agents || {};
  const knownContainers = new Set<string>();
  for (const [name, agent] of Object.entries(agents)) {
    if (!agent) continue;
    knownContainers.add(agent.container || `openclaw_${name}`);
  }

  // Check local containers
  const result = await executeCommand(
    'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; docker ps -a --format "{{.Names}}" 2>/dev/null | grep "^openclaw_"'
  );
  if (!result.ok || !result.output) {
    return { category: 'fleet', target: 'fleet', name: 'Orphaned Containers', status: 'ok', message: 'No orphans detected' };
  }

  const running = result.output.split('\n').filter(Boolean);
  const orphans = running.filter(name => !knownContainers.has(name));

  if (orphans.length > 0) {
    return { category: 'fleet', target: 'fleet', name: 'Orphaned Containers', status: 'warn',
      message: `${orphans.length} orphaned container(s)`, details: orphans.join(', '),
      fix: `Remove orphaned containers: ${orphans.join(', ')}`,
      fixCommand: `export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; docker rm -f ${orphans.join(' ')}`,
      autoFixable: false, fixTarget: 'local' };
  }
  return { category: 'fleet', target: 'fleet', name: 'Orphaned Containers', status: 'ok', message: 'No orphans' };
}

function checkConfigConsistency(config: BscsConfig): DoctorCheck {
  const agents = config.agents || {};
  const machines = config.machines || {};
  const issues: string[] = [];

  for (const [name, agent] of Object.entries(agents)) {
    if (!agent) continue;
    const m = agent.machine || 'localhost';
    if (m !== 'localhost' && !isLocalMachine(m) && !(machines as any)[m]) {
      issues.push(`Agent "${name}" references unknown machine "${m}"`);
    }
  }

  if (issues.length > 0) {
    return { category: 'fleet', target: 'fleet', name: 'Config Consistency', status: 'warn',
      message: `${issues.length} issue(s)`, details: issues.join('; '),
      fix: 'Fix agent machine references in config' };
  }
  return { category: 'fleet', target: 'fleet', name: 'Config Consistency', status: 'ok', message: 'All references valid' };
}

// =============================================================================
// Deep Checks (Level 3 + 4)
// =============================================================================

async function checkAgentErrors(agentName: string, agentConfig: any, config: BscsConfig): Promise<DoctorCheck> {
  const machine = agentConfig.machine || 'localhost';
  const runtime = agentConfig.runtime || 'docker';
  const containerName = agentConfig.container || `openclaw_${agentName}`;

  let cmd: string;
  if (runtime === 'docker') {
    cmd = remoteOrLocal(machine,
      `export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; docker logs --tail 50 ${containerName} 2>&1 | grep -ci "error" 2>/dev/null || echo 0`,
      config);
  } else {
    cmd = remoteOrLocal(machine,
      `tail -50 ~/Library/Logs/openclaw/${agentName}.log 2>/dev/null | grep -ci "error" || echo 0`,
      config);
  }

  const result = await executeCommand(cmd);
  const count = parseInt(result.output || '0', 10);

  if (count > 10) {
    return { category: 'agent', target: agentName, name: 'Recent Errors', status: 'error',
      message: `${count} errors in last 50 log lines` };
  }
  if (count > 0) {
    return { category: 'agent', target: agentName, name: 'Recent Errors', status: 'warn',
      message: `${count} errors in last 50 log lines` };
  }
  return { category: 'agent', target: agentName, name: 'Recent Errors', status: 'ok', message: 'No recent errors' };
}

async function checkAgentRateLimiting(agentName: string, agentConfig: any, config: BscsConfig): Promise<DoctorCheck> {
  const machine = agentConfig.machine || 'localhost';
  const runtime = agentConfig.runtime || 'docker';
  const containerName = agentConfig.container || `openclaw_${agentName}`;

  let cmd: string;
  if (runtime === 'docker') {
    cmd = remoteOrLocal(machine,
      `export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; docker logs --tail 100 ${containerName} 2>&1 | grep -ci "rate_limit\\|429" 2>/dev/null || echo 0`,
      config);
  } else {
    cmd = remoteOrLocal(machine,
      `tail -100 ~/Library/Logs/openclaw/${agentName}.log 2>/dev/null | grep -ci "rate_limit\\|429" || echo 0`,
      config);
  }

  const result = await executeCommand(cmd);
  const count = parseInt(result.output || '0', 10);

  if (count > 5) {
    return { category: 'agent', target: agentName, name: 'Rate Limiting', status: 'warn',
      message: `${count} rate limit events in recent logs` };
  }
  return { category: 'agent', target: agentName, name: 'Rate Limiting', status: 'ok',
    message: count > 0 ? `${count} rate limit event(s)` : 'No rate limiting' };
}

async function checkAgentChannelStatus(agentName: string, agentConfig: any, config: BscsConfig): Promise<DoctorCheck> {
  const machine = agentConfig.machine || 'localhost';
  const runtime = agentConfig.runtime || 'docker';
  const containerName = agentConfig.container || `openclaw_${agentName}`;

  let cmd: string;
  if (runtime === 'docker') {
    cmd = remoteOrLocal(machine,
      `export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; docker logs --tail 200 ${containerName} 2>&1 | grep -i "starting provider\\|channel.*connect\\|telegram\\|discord" | tail -3 2>/dev/null`,
      config);
  } else {
    cmd = remoteOrLocal(machine,
      `tail -200 ~/Library/Logs/openclaw/${agentName}.log 2>/dev/null | grep -i "starting provider\\|channel.*connect\\|telegram\\|discord" | tail -3`,
      config);
  }

  const result = await executeCommand(cmd);
  if (result.ok && result.output) {
    return { category: 'agent', target: agentName, name: 'Channel Status', status: 'ok',
      message: 'Channel activity found', details: result.output.split('\n')[0] };
  }
  return { category: 'agent', target: agentName, name: 'Channel Status', status: 'warn',
    message: 'No channel activity in recent logs' };
}

async function checkAgentResources(agentName: string, agentConfig: any, config: BscsConfig): Promise<DoctorCheck> {
  const machine = agentConfig.machine || 'localhost';
  const runtime = agentConfig.runtime || 'docker';
  if (runtime !== 'docker') {
    return { category: 'agent', target: agentName, name: 'Resources', status: 'skip', message: 'Native agent' };
  }
  const containerName = agentConfig.container || `openclaw_${agentName}`;

  const cmd = remoteOrLocal(machine,
    `export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}' ${containerName} 2>/dev/null`,
    config);
  const result = await executeCommand(cmd);
  if (!result.ok || !result.output) {
    return { category: 'agent', target: agentName, name: 'Resources', status: 'skip', message: 'Not running' };
  }

  const [cpu, mem] = result.output.split('|');
  return { category: 'agent', target: agentName, name: 'Resources', status: 'ok',
    message: `CPU: ${cpu?.trim()}, Mem: ${mem?.trim()}` };
}

async function checkSubDoctor(agentName: string, agentConfig: any, config: BscsConfig): Promise<DoctorCheck> {
  const machine = agentConfig.machine || 'localhost';
  const runtime = agentConfig.runtime || 'docker';
  const containerName = agentConfig.container || `openclaw_${agentName}`;

  let cmd: string;
  if (runtime === 'docker') {
    cmd = remoteOrLocal(machine,
      `export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; docker exec ${containerName} openclaw doctor 2>&1 | tail -5`,
      config);
  } else {
    cmd = remoteOrLocal(machine, 'openclaw doctor 2>&1 | tail -5', config);
  }

  const result = await executeCommand(cmd, 15000);
  if (result.ok && result.output) {
    const hasErrors = result.output.toLowerCase().includes('error') || result.output.toLowerCase().includes('✗');
    return { category: 'agent', target: agentName, name: 'Sub-Doctor', status: hasErrors ? 'warn' : 'ok',
      message: hasErrors ? 'Issues found' : 'Healthy', details: result.output };
  }
  return { category: 'agent', target: agentName, name: 'Sub-Doctor', status: 'skip',
    message: 'Could not run openclaw doctor', details: result.output };
}

async function checkDeepAgentHealth(agentName: string, agentConfig: any, config: BscsConfig): Promise<DoctorCheck[]> {
  const [errors, rateLimit, channel, resources, subDoctor] = await Promise.all([
    checkAgentErrors(agentName, agentConfig, config),
    checkAgentRateLimiting(agentName, agentConfig, config),
    checkAgentChannelStatus(agentName, agentConfig, config),
    checkAgentResources(agentName, agentConfig, config),
    checkSubDoctor(agentName, agentConfig, config),
  ]);
  return [errors, rateLimit, channel, resources, subDoctor];
}

// =============================================================================
// Main Runner
// =============================================================================

export async function runDoctor(config: BscsConfig, deep: boolean): Promise<DoctorResult> {
  const start = Date.now();
  const checks: DoctorCheck[] = [];
  const machineStatuses: Record<string, 'online' | 'offline'> = {};

  // 1. Collect unique machines
  const machines = new Set<string>();
  const machinesConfig = (config.machines || {}) as Record<string, any>;
  for (const host of Object.keys(machinesConfig)) {
    machines.add(host);
  }
  // Also add machines referenced by agents
  if (config.agents) {
    for (const agent of Object.values(config.agents)) {
      if (agent?.machine && agent.machine !== 'localhost') {
        machines.add(agent.machine);
      }
    }
  }

  // 2. Run machine checks in parallel
  const machineChecks = await Promise.all(
    [...machines].map(async (host) => {
      const results = await checkMachineHealth(host, config);
      const sshCheck = results.find(c => c.name === 'SSH');
      machineStatuses[host] = (sshCheck?.status === 'ok') ? 'online' : 'offline';
      return results;
    })
  );
  for (const mc of machineChecks) {
    checks.push(...mc);
  }

  // 3. Run agent checks in parallel
  if (config.agents) {
    const agentEntries = Object.entries(config.agents).filter(([, a]) => !!a);
    const agentChecks = await Promise.all(
      agentEntries.map(async ([name, agentConfig]) => {
        const machine = agentConfig!.machine || 'localhost';
        if (!isLocalMachine(machine) && machineStatuses[machine] === 'offline') {
          return [
            { category: 'agent' as const, target: name, name: 'Container', status: 'skip' as const, message: 'Machine unreachable' },
            { category: 'agent' as const, target: name, name: 'Gateway', status: 'skip' as const, message: 'Machine unreachable' },
            { category: 'agent' as const, target: name, name: 'Uptime', status: 'skip' as const, message: 'Machine unreachable' },
          ];
        }
        return checkAgentHealth(name, agentConfig, config);
      })
    );
    for (const ac of agentChecks) {
      checks.push(...ac);
    }
  }

  // 4. Fleet checks
  checks.push(checkPortConflicts(config));
  checks.push(await checkOrphanedContainers(config));
  checks.push(checkConfigConsistency(config));

  // 5. Deep checks
  if (deep && config.agents) {
    const agentEntries = Object.entries(config.agents).filter(([, a]) => !!a);
    const deepChecks = await Promise.all(
      agentEntries.map(async ([name, agentConfig]) => {
        const machine = agentConfig!.machine || 'localhost';
        if (!isLocalMachine(machine) && machineStatuses[machine] === 'offline') {
          return [
            { category: 'agent' as const, target: name, name: 'Recent Errors', status: 'skip' as const, message: 'Machine unreachable' },
            { category: 'agent' as const, target: name, name: 'Rate Limiting', status: 'skip' as const, message: 'Machine unreachable' },
            { category: 'agent' as const, target: name, name: 'Channel Status', status: 'skip' as const, message: 'Machine unreachable' },
            { category: 'agent' as const, target: name, name: 'Resources', status: 'skip' as const, message: 'Machine unreachable' },
            { category: 'agent' as const, target: name, name: 'Sub-Doctor', status: 'skip' as const, message: 'Machine unreachable' },
          ];
        }
        return checkDeepAgentHealth(name, agentConfig, config);
      })
    );
    for (const dc of deepChecks) {
      checks.push(...dc);
    }
  }

  const duration = Date.now() - start;

  const score = {
    ok: checks.filter(c => c.status === 'ok').length,
    warn: checks.filter(c => c.status === 'warn').length,
    error: checks.filter(c => c.status === 'error').length,
    critical: checks.filter(c => c.status === 'critical').length,
    skip: checks.filter(c => c.status === 'skip').length,
    total: checks.length,
  };

  return {
    timestamp: new Date().toISOString(),
    mode: deep ? 'deep' : 'quick',
    duration,
    score,
    checks,
    machines: machineStatuses,
  };
}
