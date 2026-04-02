/**
 * AgentRuntime interface — runtime-agnostic agent lifecycle operations.
 * Implemented by DockerRuntime, NativeRuntime, and OpenClawRuntime.
 */
import type { ChildProcess } from 'child_process';

export interface AgentRuntimeConfig {
  image?: string;
  ports?: { gateway?: number; remote?: number };
  env?: Record<string, string>;
  volumes?: Record<string, string>;
  memory?: string;
  pidsLimit?: number;
}

export interface CreateResult {
  name: string;
  id?: string;
  status: string;
}

export interface RuntimeStatus {
  name: string;
  status: 'running' | 'stopped' | 'created' | 'missing' | 'unknown';
  containerId?: string;
  image?: string;
  ports?: { gateway?: number; remote?: number };
}

export interface HealthCheckResult {
  name: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  containerStatus: string;
  restartNeeded: boolean;
  lastCheck: string;
  error?: string;
}

export interface AgentRuntime {
  create(name: string, config: AgentRuntimeConfig): Promise<CreateResult>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  destroy(name: string, opts?: { force?: boolean; volumes?: boolean }): Promise<void>;
  status(name: string): Promise<RuntimeStatus>;
  logs(name: string, opts?: { tail?: number; follow?: boolean }): ChildProcess;
  shell(name: string): ChildProcess;
  list(): Promise<RuntimeStatus[]>;
  healthCheck(name: string): Promise<HealthCheckResult>;
  isAvailable(): Promise<boolean>;
}

/**
 * Extended interface for OpenClaw-specific operations.
 * Only OpenClawRuntime implements these — use isOpenClawRuntime() type guard.
 */
export interface OpenClawAgentRuntime extends AgentRuntime {
  bindChannel(name: string, channelType: string, accountId: string): Promise<void>;
  unbindChannel(name: string, channelType: string): Promise<void>;
  setConfig(path: string, value: string): Promise<void>;
  listAgents(): Promise<Array<{ name: string; enabled: boolean; channels?: Array<{ type: string; accountId: string }>; model?: string }>>;
  restartGateway(): Promise<void>;
}

/** Type guard — checks if a runtime is an OpenClawAgentRuntime. */
export function isOpenClawRuntime(runtime: AgentRuntime): runtime is OpenClawAgentRuntime {
  return 'bindChannel' in runtime && 'unbindChannel' in runtime && 'setConfig' in runtime;
}
