import { execSync } from 'child_process';

export function getLocalIps(): string[] {
  try {
    const result = execSync(
      "/sbin/ifconfig 2>/dev/null | grep 'inet ' | awk '{print $2}' || ip -4 addr show 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1",
      { encoding: 'utf8', timeout: 3000 },
    );
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return ['127.0.0.1'];
  }
}

export function isLocalMachine(host: string): boolean {
  const localIps = getLocalIps();
  return host === 'localhost' || host === '127.0.0.1' || localIps.includes(host);
}
