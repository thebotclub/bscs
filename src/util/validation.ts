const SAFE_HOSTNAME = /^[a-zA-Z0-9._:-]+$/;
const SAFE_USERNAME = /^[a-zA-Z0-9._-]+$/;
const SAFE_AGENT_NAME = /^[a-zA-Z0-9_-]+$/;

export function validateHostname(host: string): string {
  if (!SAFE_HOSTNAME.test(host)) throw new Error(`Invalid hostname: ${host}`);
  return host;
}

export function validateUsername(user: string): string {
  if (!SAFE_USERNAME.test(user)) throw new Error(`Invalid username: ${user}`);
  return user;
}

export function validateAgentName(name: string): string {
  if (!SAFE_AGENT_NAME.test(name)) throw new Error(`Invalid agent name: ${name}`);
  return name;
}

export function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  return port;
}
