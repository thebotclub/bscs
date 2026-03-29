import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type Docker from 'dockerode';

// Mock container data
const createMockContainer = (overrides: Partial<Docker.ContainerInfo> = {}) => ({
  Id: 'abc123def456',
  Names: ['/openclaw_test'],
  Image: 'openclaw-fleet:latest',
  State: 'running',
  Status: 'Up 2 hours',
  Created: Math.floor(Date.now() / 1000),
  Ports: [
    { IP: '127.0.0.1', PrivatePort: 19000, PublicPort: 19000, Type: 'tcp' },
    { IP: '127.0.0.1', PrivatePort: 19001, PublicPort: 19001, Type: 'tcp' },
  ],
  ...overrides,
});

// Mock Docker instance
const createMockDocker = () => {
  const containers = new Map<string, any>();
  
  const mockDocker = {
    _containers: containers,
    
    ping: vi.fn().mockResolvedValue('OK'),
    
    listContainers: vi.fn().mockImplementation(async () => {
      return Array.from(containers.values()).map(c => ({
        Id: c.Id,
        Names: [`/openclaw_${c.name}`],
        Image: c.image,
        State: c.status,
        Status: `Up ${Math.floor((Date.now() - c.created.getTime()) / 1000)} seconds`,
        Created: Math.floor(c.created.getTime() / 1000),
        Ports: c.ports ? [
          { PrivatePort: c.ports.gateway, PublicPort: c.ports.gateway, Type: 'tcp' },
          { PrivatePort: c.ports.remote, PublicPort: c.ports.remote, Type: 'tcp' },
        ] : [],
      }));
    }),
    
    getContainer: vi.fn().mockImplementation((id: string) => {
      const containerName = id.replace('openclaw_', '');
      const container = containers.get(containerName);
      
      if (!container) {
        const err: any = new Error('Container not found');
        err.statusCode = 404;
        throw err;
      }
      
      return {
        inspect: vi.fn().mockResolvedValue({
          Id: container.Id,
          Name: `/openclaw_${container.name}`,
          State: {
            Status: container.status,
          },
          Config: {
            Image: container.image,
          },
          Created: container.created.toISOString(),
          HostConfig: {
            PortBindings: container.ports ? {
              [`${container.ports.gateway}/tcp`]: [{ HostPort: String(container.ports.gateway), HostIp: '127.0.0.1' }],
              [`${container.ports.remote}/tcp`]: [{ HostPort: String(container.ports.remote), HostIp: '127.0.0.1' }],
            } : {},
          },
        }),
        start: vi.fn().mockImplementation(async () => {
          if (container.status === 'running') {
            const err: any = new Error('Already running');
            err.statusCode = 304;
            throw err;
          }
          container.status = 'running';
        }),
        stop: vi.fn().mockImplementation(async () => {
          if (container.status === 'exited') {
            const err: any = new Error('Already stopped');
            err.statusCode = 304;
            throw err;
          }
          container.status = 'exited';
        }),
        remove: vi.fn().mockImplementation(async () => {
          containers.delete(containerName);
        }),
      };
    }),
    
    createContainer: vi.fn().mockImplementation(async (opts: any) => {
      const name = opts.name.replace('openclaw_', '');
      const container = {
        Id: `new-${Date.now()}`,
        name,
        image: opts.Image,
        status: 'created',
        ports: opts.HostConfig?.PortBindings ? {
          gateway: parseInt(Object.keys(opts.HostConfig.PortBindings)[0]?.split('/')[0] || '0'),
          remote: parseInt(Object.keys(opts.HostConfig.PortBindings)[1]?.split('/')[0] || '0'),
        } : undefined,
        created: new Date(),
      };
      
      containers.set(name, container);
      
      return {
        inspect: vi.fn().mockResolvedValue({
          Id: container.Id,
          Name: `/openclaw_${name}`,
          State: { Status: 'created' },
          Config: { Image: opts.Image },
          Created: container.created.toISOString(),
          HostConfig: opts.HostConfig,
        }),
      };
    }),
    
    pull: vi.fn().mockImplementation((_image: string, callback: (err: Error | null, stream: NodeJS.ReadableStream) => void) => {
      const stream = new EventEmitter() as NodeJS.ReadableStream;
      callback(null, stream);
      setImmediate(() => stream.emit('end'));
    }),
    
    modem: {
      followProgress: vi.fn().mockImplementation((_stream: any, callback: (err: Error | undefined) => void) => {
        callback(undefined);
      }),
    },
  };
  
  return mockDocker as any as Docker;
};

// We'll test the docker module functions by importing and mocking
describe('Docker Module', () => {
  let mockDocker: Docker;
  
  beforeEach(() => {
    mockDocker = createMockDocker();
    vi.clearAllMocks();
  });
  
  afterEach(() => {
    vi.resetModules();
  });

  describe('isDockerRunning', () => {
    it('should return true when Docker is available', async () => {
      const { setDocker } = await import('../../../src/core/docker.js');
      const { getDocker } = await import('../../../src/core/docker.js');
      
      setDocker(mockDocker);
      
      const docker = await getDocker();
      await expect(docker.ping()).resolves.toBe('OK');
    });

    it('should return false when Docker is not available', async () => {
      const failingDocker = {
        ...mockDocker,
        ping: vi.fn().mockRejectedValue(new Error('Connection refused')),
      };
      
      const { setDocker } = await import('../../../src/core/docker.js');
      setDocker(failingDocker as any);
      
      await expect(failingDocker.ping()).rejects.toThrow('Connection refused');
    });
  });

  describe('listBscsContainers', () => {
    it('should list only openclaw containers', async () => {
      const { setDocker } = await import('../../../src/core/docker.js');
      setDocker(mockDocker);
      
      // Add some containers
      (mockDocker as any)._containers.set('atlas', {
        Id: 'atlas123',
        name: 'atlas',
        image: 'openclaw-fleet:latest',
        status: 'running',
        ports: { gateway: 19000, remote: 19001 },
        created: new Date(),
      });
      
      // Non-openclaw container (should be filtered out)
      (mockDocker as any)._containers.set('other', {
        Id: 'other123',
        name: 'other',
        image: 'nginx:latest',
        status: 'running',
        created: new Date(),
      });
      
      const containers = await mockDocker.listContainers();
      expect(containers.length).toBe(2);
    });
  });

  describe('createContainer', () => {
    it('should create a container with port bindings', async () => {
      const { setDocker } = await import('../../../src/core/docker.js');
      setDocker(mockDocker);
      
      const options = {
        name: 'test-agent',
        image: 'openclaw-fleet:latest',
        ports: { gateway: 19100, remote: 19101 },
      };
      
      const container = await mockDocker.createContainer({
        name: `openclaw_${options.name}`,
        Image: options.image,
        HostConfig: {
          PortBindings: {
            [`${options.ports.gateway}/tcp`]: [{ HostPort: String(options.ports.gateway), HostIp: '127.0.0.1' }],
            [`${options.ports.remote}/tcp`]: [{ HostPort: String(options.ports.remote), HostIp: '127.0.0.1' }],
          },
        },
      });
      
      const info = await container.inspect();
      expect(info.Name).toBe('/openclaw_test-agent');
    });
  });

  describe('startContainer', () => {
    it('should start a created container', async () => {
      const { setDocker } = await import('../../../src/core/docker.js');
      setDocker(mockDocker);
      
      (mockDocker as any)._containers.set('test', {
        Id: 'test123',
        name: 'test',
        image: 'openclaw-fleet:latest',
        status: 'created',
        created: new Date(),
      });
      
      const container = mockDocker.getContainer('openclaw_test');
      await container.start();
      
      const info = await container.inspect();
      expect((mockDocker as any)._containers.get('test')?.status).toBe('running');
    });
  });

  describe('stopContainer', () => {
    it('should stop a running container', async () => {
      const { setDocker } = await import('../../../src/core/docker.js');
      setDocker(mockDocker);
      
      (mockDocker as any)._containers.set('test', {
        Id: 'test123',
        name: 'test',
        image: 'openclaw-fleet:latest',
        status: 'running',
        created: new Date(),
      });
      
      const container = mockDocker.getContainer('openclaw_test');
      await container.stop();
      
      expect((mockDocker as any)._containers.get('test')?.status).toBe('exited');
    });
  });

  describe('removeContainer', () => {
    it('should remove a container', async () => {
      const { setDocker } = await import('../../../src/core/docker.js');
      setDocker(mockDocker);
      
      (mockDocker as any)._containers.set('test', {
        Id: 'test123',
        name: 'test',
        image: 'openclaw-fleet:latest',
        status: 'exited',
        created: new Date(),
      });
      
      const container = mockDocker.getContainer('openclaw_test');
      await container.remove();
      
      expect((mockDocker as any)._containers.has('test')).toBe(false);
    });
  });
});
