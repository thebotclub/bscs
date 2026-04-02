/**
 * DockerRuntime — AgentRuntime implementation backed by Docker (dockerode).
 * Wraps existing docker.ts functions; no new behavior.
 */
import { spawn, type ChildProcess } from 'child_process';
import {
  createContainer,
  startContainer,
  stopContainer,
  removeContainer,
  getContainer,
  listAllContainers,
  pullImage,
  isDockerRunning,
} from '../docker.js';
import type {
  AgentRuntime,
  AgentRuntimeConfig,
  CreateResult,
  RuntimeStatus,
  HealthCheckResult,
} from './types.js';

export class DockerRuntime implements AgentRuntime {
  /** Map of agent name -> actual Docker container name (e.g. { khadem: "khadem-bot" }) */
  private containerNames: Map<string, string>;

  constructor(containerNames?: Map<string, string>) {
    this.containerNames = containerNames || new Map();
  }

  /** Register a custom container name for an agent. */
  setContainerName(agentName: string, containerName: string): void {
    this.containerNames.set(agentName, containerName);
  }

  /** Resolve the actual Docker container name for an agent. */
  resolveContainerName(name: string): string {
    return this.containerNames.get(name) || `openclaw_${name}`;
  }

  async create(name: string, config: AgentRuntimeConfig): Promise<CreateResult> {
    if (config.image) {
      await pullImage(config.image);
    }
    const info = await createContainer({
      name,
      image: config.image || 'openclaw-fleet:latest',
      ports: config.ports,
      env: config.env,
      volumes: config.volumes,
    });
    return { name, id: info.id, status: 'created' };
  }

  async start(name: string): Promise<void> {
    await startContainer(name);
  }

  async stop(name: string): Promise<void> {
    await stopContainer(name);
  }

  async restart(name: string): Promise<void> {
    await stopContainer(name);
    await startContainer(name);
  }

  async destroy(name: string, opts?: { force?: boolean; volumes?: boolean }): Promise<void> {
    await stopContainer(name);
    await removeContainer(name, opts?.volumes);
  }

  async status(name: string): Promise<RuntimeStatus> {
    const containerName = this.resolveContainerName(name);
    const container = await getContainer(name, containerName);
    if (!container) {
      return { name, status: 'missing' };
    }
    return {
      name,
      status: container.status,
      containerId: container.id,
      image: container.image,
      ports: container.ports as { gateway?: number; remote?: number } | undefined,
    };
  }

  logs(name: string, opts?: { tail?: number; follow?: boolean }): ChildProcess {
    const containerName = this.resolveContainerName(name);
    const args = ['logs'];
    if (opts?.follow) args.push('-f');
    if (opts?.tail !== undefined) args.push('--tail', String(opts.tail));
    args.push(containerName);
    return spawn('docker', args, { stdio: 'inherit' });
  }

  shell(name: string): ChildProcess {
    const containerName = this.resolveContainerName(name);
    return spawn('docker', ['exec', '-it', containerName, '/bin/sh'], {
      stdio: 'inherit',
    });
  }

  async list(): Promise<RuntimeStatus[]> {
    const containers = await listAllContainers();
    // Return containers that are either openclaw_-prefixed or explicitly registered
    return containers
      .filter((c) =>
        c.name.startsWith('openclaw_') ||
        [...this.containerNames.values()].includes(c.name),
      )
      .map((c) => {
        // Strip openclaw_ prefix for standard names, use as-is for custom names
        const registered = [...this.containerNames.entries()].find(([, cn]) => cn === c.name);
        const agentName = registered ? registered[0] : c.name.replace('openclaw_', '');
        return {
          name: agentName,
          status: c.status,
          containerId: c.id,
          image: c.image,
          ports: c.ports as { gateway?: number; remote?: number } | undefined,
        };
      });
  }

  async healthCheck(name: string): Promise<HealthCheckResult> {
    const containerName = this.resolveContainerName(name);
    const container = await getContainer(name, containerName);
    const now = new Date().toISOString();

    if (!container) {
      return {
        name,
        status: 'unhealthy',
        containerStatus: 'missing',
        restartNeeded: true,
        lastCheck: now,
        error: 'Container not found',
      };
    }

    if (container.status === 'running') {
      return {
        name,
        status: 'healthy',
        containerStatus: 'running',
        restartNeeded: false,
        lastCheck: now,
      };
    }

    return {
      name,
      status: 'unhealthy',
      containerStatus: container.status,
      restartNeeded: true,
      lastCheck: now,
      error: `Expected running, found ${container.status}`,
    };
  }

  async isAvailable(): Promise<boolean> {
    return isDockerRunning();
  }
}
