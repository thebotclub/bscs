/**
 * Runtime resolver — returns the correct AgentRuntime for a given runtime type.
 */
import { DockerRuntime } from './docker.js';
import { NativeRuntime } from './native.js';
import { OpenClawRuntime } from './openclaw.js';
import type { AgentRuntime } from './types.js';

export type { AgentRuntime, OpenClawAgentRuntime, AgentRuntimeConfig, CreateResult, RuntimeStatus, HealthCheckResult } from './types.js';
export { isOpenClawRuntime } from './types.js';
export { DockerRuntime } from './docker.js';
export { NativeRuntime } from './native.js';
export { OpenClawRuntime } from './openclaw.js';

export function getRuntime(runtimeType?: string, opts?: { port?: number; gatewayUrl?: string }): AgentRuntime {
  switch (runtimeType || 'docker') {
    case 'docker':
      return new DockerRuntime();
    case 'native':
      return new NativeRuntime(opts?.port);
    case 'openclaw':
      return new OpenClawRuntime(opts?.gatewayUrl);
    default:
      throw new Error(`Unknown runtime: "${runtimeType}". Supported: docker, native, openclaw`);
  }
}
