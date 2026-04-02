// @ts-ignore - dockerode types installed separately
import type Docker from 'dockerode';
import { createLogger } from '../util/logger.js';
import { createRequire } from 'module';

const logger = createLogger('docker');

// Lazy-loaded Docker client
let _docker: Docker | null = null;

// Dynamic import for dockerode (handles case where it's not installed)
async function importDocker(): Promise<any> {
  try {
    const require = createRequire(import.meta.url);
    return require('dockerode');
  } catch (err) {
    throw new Error(
      'dockerode is not installed. Run: npm install dockerode'
    );
  }
}

export async function getDocker(): Promise<Docker> {
  if (!_docker) {
    const DockerClass = await importDocker();
    _docker = new DockerClass({
      socketPath: '/var/run/docker.sock',
    }) as Docker;
  }
  return _docker!;
}

// For testing - inject a mock
export function setDocker(docker: Docker | null): void {
  _docker = docker;
}

export interface ContainerInfo {
  name: string;
  id: string;
  status: 'running' | 'stopped' | 'created' | 'unknown';
  image: string;
  ports?: {
    gateway?: number;
    remote?: number;
  };
  created: Date;
}

export interface CreateContainerOptions {
  name: string;
  image: string;
  ports?: {
    gateway?: number;
    remote?: number;
  };
  env?: Record<string, string>;
  volumes?: Record<string, string>;
}

export async function isDockerRunning(): Promise<boolean> {
  try {
    const docker = await getDocker();
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

export async function listBscsContainers(): Promise<ContainerInfo[]> {
  const docker = await getDocker();
  
  try {
    const containers = await docker.listContainers({ all: true });
    const bscsContainers = containers.filter((c: { Names: string[] }) => 
      c.Names.some((n: string) => n.startsWith('/openclaw_'))
    );
    
    return bscsContainers.map((c: { Id: string; State: string; Image: string; Ports: Array<{ PublicPort?: number; PrivatePort?: number }>; Created: number; Names: string[] }) => ({
      name: (c.Names[0] || '').replace('/', ''),
      id: c.Id,
      status: mapStatus(c.State),
      image: c.Image,
      ports: extractPorts(c.Ports),
      created: new Date(c.Created * 1000),
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to list containers');
    throw err;
  }
}

/** List ALL containers (not just openclaw_-prefixed ones). */
export async function listAllContainers(): Promise<ContainerInfo[]> {
  const docker = await getDocker();

  try {
    const containers = await docker.listContainers({ all: true });

    return containers.map((c: { Id: string; State: string; Image: string; Ports: Array<{ PublicPort?: number; PrivatePort?: number }>; Created: number; Names: string[] }) => ({
      name: (c.Names[0] || '').replace('/', ''),
      id: c.Id,
      status: mapStatus(c.State),
      image: c.Image,
      ports: extractPorts(c.Ports),
      created: new Date(c.Created * 1000),
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to list all containers');
    throw err;
  }
}

export async function getContainer(name: string, containerName?: string): Promise<ContainerInfo | null> {
  const docker = await getDocker();

  try {
    const actualName = containerName || `openclaw_${name}`;
    const container = docker.getContainer(actualName);
    const info = await container.inspect();
    
    return {
      name: info.Name.replace('/', ''),
      id: info.Id,
      status: mapStatus(info.State.Status),
      image: info.Config.Image,
      ports: extractPortsFromInspect(info),
      created: new Date(info.Created),
    };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return null;
    }
    throw err;
  }
}

export async function createContainer(options: CreateContainerOptions): Promise<ContainerInfo> {
  const docker = await getDocker();
  const { name, image, ports, env = {}, volumes = {} } = options;
  
  logger.debug({ name, image, ports }, 'Creating container');
  
  // Build container config
  const containerConfig = {
    name: `openclaw_${name}`,
    Image: image,
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' as const },
      PortBindings: {} as Record<string, Array<{ HostPort: string; HostIp: string }>>,
      Binds: [] as string[],
    },
    ExposedPorts: {} as Record<string, Record<string, unknown>>,
  };
  
  // Add port bindings if specified
  if (ports) {
    containerConfig.ExposedPorts = {
      [`${ports.gateway}/tcp`]: {},
      [`${ports.remote}/tcp`]: {},
    };
    containerConfig.HostConfig.PortBindings = {
      [`${ports.gateway}/tcp`]: [{ HostPort: String(ports.gateway), HostIp: '127.0.0.1' }],
      [`${ports.remote}/tcp`]: [{ HostPort: String(ports.remote), HostIp: '127.0.0.1' }],
    };
  }
  
  // Add volume bindings if specified
  if (Object.keys(volumes).length > 0) {
    containerConfig.HostConfig.Binds = Object.entries(volumes).map(
      ([host, container]) => `${host}:${container}`
    );
  }
  
  try {
    const container = await docker.createContainer(containerConfig);
    const info = await container.inspect();
    
    logger.info({ name, id: info.Id }, 'Container created');
    
    return {
      name: info.Name.replace('/', ''),
      id: info.Id,
      status: 'created',
      image: info.Config.Image,
      ports,
      created: new Date(info.Created),
    };
  } catch (err) {
    logger.error({ err, name }, 'Failed to create container');
    throw err;
  }
}

export async function startContainer(name: string): Promise<void> {
  const docker = await getDocker();
  const container = docker.getContainer(`openclaw_${name}`);
  
  logger.debug({ name }, 'Starting container');
  
  try {
    await container.start();
    logger.info({ name }, 'Container started');
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 304) {
      logger.debug({ name }, 'Container already running');
      return;
    }
    throw err;
  }
}

export async function stopContainer(name: string, timeout = 10): Promise<void> {
  const docker = await getDocker();
  const container = docker.getContainer(`openclaw_${name}`);
  
  logger.debug({ name }, 'Stopping container');
  
  try {
    await container.stop({ t: timeout });
    logger.info({ name }, 'Container stopped');
  } catch (err: unknown) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code === 304) {
      logger.debug({ name }, 'Container already stopped');
      return;
    }
    if (code === 404) {
      logger.debug({ name }, 'Container not found');
      return;
    }
    throw err;
  }
}

export async function removeContainer(name: string, removeVolumes = false): Promise<void> {
  const docker = await getDocker();
  const container = docker.getContainer(`openclaw_${name}`);
  
  logger.debug({ name, removeVolumes }, 'Removing container');
  
  try {
    await container.remove({ v: removeVolumes, force: true });
    logger.info({ name }, 'Container removed');
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      logger.debug({ name }, 'Container not found');
      return;
    }
    throw err;
  }
}

export async function pullImage(image: string): Promise<void> {
  const docker = await getDocker();
  
  logger.debug({ image }, 'Checking/pulling image');
  
  // First check if image exists locally
  try {
    const images = await docker.listImages({
      filters: JSON.stringify({ reference: [image] }),
    });
    
    if (images.length > 0) {
      logger.info({ image }, 'Image already exists locally');
      return;
    }
  } catch (err) {
    logger.debug({ err }, 'Failed to check local images, will try pull');
  }
  
  // Image not found locally, try to pull
  return new Promise((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream | undefined) => {
      if (err) {
        logger.error({ err, image }, 'Failed to pull image');
        return reject(err);
      }
      
      if (!stream) {
        return reject(new Error('No stream returned from docker pull'));
      }
      
      docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) {
          logger.error({ err, image }, 'Failed to pull image');
          return reject(err);
        }
        logger.info({ image }, 'Image pulled');
        resolve();
      });
    });
  });
}

// Helper functions
function mapStatus(state: string): ContainerInfo['status'] {
  switch (state) {
    case 'running':
      return 'running';
    case 'exited':
    case 'stopped':
      return 'stopped';
    case 'created':
      return 'created';
    default:
      return 'unknown';
  }
}

function extractPorts(ports: Array<{ PublicPort?: number; PrivatePort?: number }>): ContainerInfo['ports'] {
  const result: ContainerInfo['ports'] = {};
  
  for (const p of ports) {
    if (p.PublicPort !== undefined) {
      if (p.PrivatePort === 19000 || p.PrivatePort === p.PublicPort - 1) {
        result.gateway = p.PublicPort;
      } else {
        result.remote = p.PublicPort;
      }
    }
  }
  
  return result;
}

function extractPortsFromInspect(info: { HostConfig?: { PortBindings?: Record<string, Array<{ HostPort: string }> | undefined> } }): ContainerInfo['ports'] {
  const bindings = info.HostConfig?.PortBindings || {};
  const result: ContainerInfo['ports'] = {};
  
  const entries = Object.entries(bindings)
    .filter(([, value]) => value && Array.isArray(value) && value.length > 0)
    .map(([key, value]) => ({
      containerPort: parseInt(key.split('/')[0] || '0', 10),
      hostPort: parseInt(value![0]!.HostPort || '0', 10),
    }))
    .sort((a, b) => a.containerPort - b.containerPort);
  
  // First port pair goes to gateway/remote
  if (entries.length >= 1) {
    result.gateway = entries[0]!.hostPort;
  }
  if (entries.length >= 2) {
    result.remote = entries[1]!.hostPort;
  }
  
  return result;
}
