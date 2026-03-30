/**
 * Template: Generate docker-compose.yml snippets for agents.
 */

// Agent name must match schema regex — prevents injection into container_name / env vars
const AGENT_NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;

function assertSafeName(name: string): void {
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(`Invalid agent name "${name}": must match ^[a-z][a-z0-9-]{1,30}$`);
  }
}

export interface ComposeServiceOptions {
  name: string;
  image: string;
  ports: { gateway?: number; remote?: number };
  memory?: string;
  pidsLimit?: number;
  env?: Record<string, string>;
  volumes?: Record<string, string>;
}

export interface ComposeService {
  image: string;
  container_name: string;
  restart: string;
  ports: string[];
  environment: Record<string, string>;
  volumes: string[];
  deploy: {
    resources: {
      limits: { memory: string; pids: number };
    };
  };
  security_opt: string[];
  cap_drop: string[];
  tmpfs: string[];
}

export function generateComposeService(options: ComposeServiceOptions): ComposeService {
  const { name, image, ports, memory = '2g', pidsLimit = 256, env = {}, volumes = {} } = options;
  assertSafeName(name);

  return {
    image,
    container_name: `openclaw_${name}`,
    restart: 'unless-stopped',
    ports: [
      `127.0.0.1:${ports.gateway}:${ports.gateway}`,
      `127.0.0.1:${ports.remote}:${ports.remote}`,
    ],
    environment: {
      AGENT_NAME: name,
      ...env,
    },
    volumes: Object.entries(volumes).map(([host, container]) => `${host}:${container}`),
    deploy: {
      resources: {
        limits: { memory, pids: pidsLimit },
      },
    },
    security_opt: ['no-new-privileges:true'],
    cap_drop: ['ALL'],
    tmpfs: ['/tmp:rw,noexec,nosuid,size=256m'],
  };
}

export function generateComposeFile(services: ComposeServiceOptions[]): string {
  const compose: {
    version: string;
    services: Record<string, ComposeService>;
  } = {
    version: '3.8',
    services: {},
  };

  for (const svc of services) {
    compose.services[svc.name] = generateComposeService(svc);
  }

  // Simple YAML-like output (JSON is valid for docker compose too)
  return JSON.stringify(compose, null, 2);
}
