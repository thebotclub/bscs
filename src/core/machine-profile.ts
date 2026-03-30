import { execSync, exec } from 'child_process';
import { createLogger } from '../util/logger.js';
import type { MachineProfile } from '../util/types.js';

const logger = createLogger('machine-profile');

// =============================================================================
// Probe Script
// =============================================================================

const PROBE_SCRIPT = `
echo '{'
echo '"os":"'$(uname -s | tr A-Z a-z)'",'
echo '"arch":"'$(uname -m)'",'
echo '"hostname":"'$(hostname -s)'",'
echo '"shell":"'$SHELL'",'

for bin in docker node openclaw npm tailscale op git; do
  path=$(which $bin 2>/dev/null)
  if [ -z "$path" ]; then
    for dir in /usr/local/bin /opt/homebrew/bin /opt/homebrew/opt/node@22/bin /snap/bin $HOME/.local/bin; do
      if [ -x "$dir/$bin" ]; then path="$dir/$bin"; break; fi
    done
  fi
  echo '"bin_'$bin'":"'"\${path:-}"'",'
done

echo '"ver_docker":"'$(docker version --format '{{.Server.Version}}' 2>/dev/null || /usr/local/bin/docker version --format '{{.Server.Version}}' 2>/dev/null || echo '')'",'
echo '"ver_node":"'$(node --version 2>/dev/null || /opt/homebrew/opt/node@22/bin/node --version 2>/dev/null || echo '')'",'
echo '"ver_openclaw":"'$(openclaw --version 2>/dev/null || echo '')'",'
echo '"ver_npm":"'$(npm --version 2>/dev/null || echo '')'",'

if command -v launchctl >/dev/null 2>&1; then echo '"init":"launchctl",'
elif command -v systemctl >/dev/null 2>&1; then echo '"init":"systemd",'
else echo '"init":"none",'
fi

if docker ps >/dev/null 2>&1; then echo '"needsSudo":false,'
elif sudo -n docker ps >/dev/null 2>&1; then echo '"needsSudo":true,'
else echo '"needsSudo":false,'
fi

if [ "$(uname)" = "Darwin" ]; then
  echo '"memBytes":'$(sysctl -n hw.memsize 2>/dev/null || echo 0)','
  echo '"diskTotal":"'$(df -g / | tail -1 | awk '{print $2}')'",'
else
  echo '"memBytes":'$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2 * 1024}' || echo 0)','
  echo '"diskTotal":"'$(df -BG / | tail -1 | awk "{print \\$2}" | tr -d G)'",'
fi

echo '"probed":true}'
`.trim();

// =============================================================================
// Helpers
// =============================================================================

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

/**
 * Derive a PATH prefix from all discovered binary paths.
 */
export function derivePathPrefix(binaries: Record<string, string | null>): string {
  const dirs = new Set<string>();
  for (const binPath of Object.values(binaries)) {
    if (binPath) {
      const dir = binPath.substring(0, binPath.lastIndexOf('/'));
      if (dir) dirs.add(dir);
    }
  }
  return Array.from(dirs).join(':');
}

/**
 * Parse raw probe JSON output into a MachineProfile.
 */
export function parseProbeOutput(raw: string): MachineProfile {
  // Clean the output — sometimes there's trailing junk
  const jsonStr = raw.trim();
  let data: Record<string, any>;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    // Try to fix common JSON issues (trailing comma before })
    const fixed = jsonStr.replace(/,\s*}/g, '}');
    data = JSON.parse(fixed);
  }

  const binaries: Record<string, string | null> = {
    docker: data.bin_docker || null,
    node: data.bin_node || null,
    openclaw: data.bin_openclaw || null,
    npm: data.bin_npm || null,
    tailscale: data.bin_tailscale || null,
    op: data.bin_op || null,
    git: data.bin_git || null,
  };

  const versions: Record<string, string | null> = {
    docker: data.ver_docker || null,
    node: data.ver_node || null,
    openclaw: data.ver_openclaw || null,
    npm: data.ver_npm || null,
  };

  const memBytes = parseInt(data.memBytes || '0', 10);
  const diskTotal = parseInt(data.diskTotal || '0', 10);

  const profile: MachineProfile = {
    os: data.os === 'linux' ? 'linux' : 'darwin',
    arch: data.arch || 'arm64',
    hostname: data.hostname || 'unknown',
    shell: data.shell || '/bin/sh',
    binaries,
    versions,
    pathPrefix: derivePathPrefix(binaries),
    needsSudo: data.needsSudo === true || data.needsSudo === 'true',
    initSystem: data.init === 'systemd' ? 'systemd' : data.init === 'launchctl' ? 'launchctl' : 'none',
    totalMemoryGB: Math.round((memBytes / (1024 * 1024 * 1024)) * 10) / 10,
    diskTotalGB: diskTotal || 0,
    probedAt: new Date().toISOString(),
  };

  return profile;
}

// =============================================================================
// Probe Functions
// =============================================================================

function executeProbeCommand(command: string, timeoutMs = 15000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, output: (stderr || err.message || '').trim() });
      } else {
        resolve({ ok: true, output: (stdout || '').trim() });
      }
    });
  });
}

/**
 * Probe a machine (local or remote via SSH) and return its profile.
 */
export async function probeMachine(host: string, sshAlias?: string): Promise<MachineProfile> {
  logger.debug({ host, sshAlias }, 'Probing machine');

  let result: { ok: boolean; output: string };

  if (isLocalMachine(host)) {
    // Run locally
    result = await executeProbeCommand(`bash -c '${PROBE_SCRIPT.replace(/'/g, "'\\''")}'`);
  } else {
    // Run via SSH
    const target = sshAlias || host;
    const escaped = PROBE_SCRIPT.replace(/'/g, "'\\''");
    result = await executeProbeCommand(
      `ssh -o ConnectTimeout=10 -o BatchMode=yes ${target} 'bash -s' << 'BSCS_PROBE_EOF'\n${PROBE_SCRIPT}\nBSCS_PROBE_EOF`
    );
  }

  if (!result.ok) {
    throw new Error(`Probe failed for ${host}: ${result.output}`);
  }

  return parseProbeOutput(result.output);
}

// =============================================================================
// Command Builders (profile-aware)
// =============================================================================

/**
 * Get a command string using the absolute path from the profile.
 * Falls back to the bare binary name if no profile or binary not found.
 */
export function getCommandForMachine(profile: MachineProfile | undefined, binary: string, args: string): string {
  if (!profile) {
    // Fallback: use PATH prefix approach
    return `export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH" && ${binary} ${args}`;
  }

  const binPath = profile.binaries?.[binary];
  if (binPath) {
    return `${binPath} ${args}`;
  }

  // Binary not in profile — use PATH prefix
  if (profile.pathPrefix) {
    return `export PATH="${profile.pathPrefix}:$PATH" && ${binary} ${args}`;
  }

  return `${binary} ${args}`;
}

/**
 * Get a docker command using the profile's docker path.
 */
export function getDockerCommandForMachine(profile: MachineProfile | undefined, action: string, container: string): string {
  const docker = profile?.binaries?.docker || null;

  // Use absolute path if available, otherwise PATH prefix fallback
  let prefix: string;
  if (docker) {
    prefix = docker;
  } else if (profile?.pathPrefix) {
    prefix = `export PATH="${profile.pathPrefix}:$PATH" && docker`;
  } else {
    prefix = 'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH" && docker';
  }

  const sudo = profile?.needsSudo ? 'sudo ' : '';

  switch (action) {
    case 'start': return `${sudo}${prefix} start ${container}`;
    case 'stop': return `${sudo}${prefix} stop ${container}`;
    case 'restart': return `${sudo}${prefix} restart ${container}`;
    case 'remove': return `${sudo}${prefix} rm -f ${container}`;
    case 'logs': return `${sudo}${prefix} logs --tail 100 ${container}`;
    case 'inspect': return `${sudo}${prefix} inspect ${container}`;
    case 'exec': return `${sudo}${prefix} exec ${container}`;
    case 'stats': return `${sudo}${prefix} stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}' ${container}`;
    case 'ps': return `${sudo}${prefix} ps`;
    default: throw new Error(`Unknown docker action: ${action}`);
  }
}

/**
 * Get a service management command based on the machine's init system.
 */
export function getServiceCommand(profile: MachineProfile | undefined, action: 'start' | 'stop' | 'restart', serviceName: string): string {
  const initSystem = profile?.initSystem || 'launchctl';

  if (initSystem === 'systemd') {
    switch (action) {
      case 'start': return `systemctl --user start ${serviceName}`;
      case 'stop': return `systemctl --user stop ${serviceName}`;
      case 'restart': return `systemctl --user restart ${serviceName}`;
    }
  }

  // launchctl (macOS) or fallback
  const launchLabel = `ai.openclaw.${serviceName}`;
  switch (action) {
    case 'start':
      return `launchctl kickstart gui/$(id -u)/${launchLabel} 2>/dev/null || echo "Started"`;
    case 'stop':
      return `pkill -f "openclaw.*gateway.*${serviceName}" 2>/dev/null; pkill -f "openclaw.*${serviceName}" 2>/dev/null; echo "Stopped"`;
    case 'restart':
      return `pkill -f "openclaw.*gateway.*${serviceName}" 2>/dev/null; pkill -f "openclaw.*${serviceName}" 2>/dev/null; sleep 2; launchctl kickstart -k gui/$(id -u)/${launchLabel} 2>/dev/null || echo "Restarted"`;
  }
}

/**
 * Get the PATH export prefix string for a machine profile.
 * Used when you need to set PATH before running commands.
 */
export function getPathPrefix(profile: MachineProfile | undefined): string {
  if (profile?.pathPrefix) {
    return `export PATH="${profile.pathPrefix}:$PATH" && `;
  }
  return 'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH" && ';
}
