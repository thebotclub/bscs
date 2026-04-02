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
  listBscsContainers,
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
    const container = await getContainer(name);
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
    const args = ['logs'];
    if (opts?.follow) args.push('-f');
    if (opts?.tail !== undefined) args.push('--tail', String(opts.tail));
    args.push(`openclaw_${name}`);
    return spawn('docker', args, { stdio: 'inherit' });
  }

  shell(name: string): ChildProcess {
    return spawn('docker', ['exec', '-it', `openclaw_${name}`, '/bin/sh'], {
      stdio: 'inherit',
    });
  }

  async list(): Promise<RuntimeStatus[]> {
    const containers = await listBscsContainers();
    return containers.map((c) => ({
      name: c.name.replace('openclaw_', ''),
      status: c.status,
      containerId: c.id,
      image: c.image,
      ports: c.ports as { gateway?: number; remote?: number } | undefined,
    }));
  }

  async healthCheck(name: string): Promise<HealthCheckResult> {
    const container = await getContainer(name);
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
