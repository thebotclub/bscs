import { execFileSync, type ExecFileSyncOptions } from 'child_process';

export interface SshTarget {
  host: string;
  user: string;
  port?: number;
  sshAlias?: string;
}

export function sshExec(
  target: SshTarget,
  remoteCommand: string,
  options?: ExecFileSyncOptions & { timeoutMs?: number },
): string {
  const dest = target.sshAlias || `${target.user}@${target.host}`;
  const args = [
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    '-p', String(target.port || 22),
    dest,
    remoteCommand,
  ];
  const timeout = options?.timeoutMs;
  const { timeoutMs: _, ...restOpts } = options || {};
  return execFileSync('ssh', args, {
    encoding: 'utf-8',
    timeout: timeout || 30000,
    ...restOpts,
  }) as string;
}
