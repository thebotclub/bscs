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

interface RuntimeOpts {
  port?: number;
  gatewayUrl?: string;
  /** Map of agent name -> Docker container name for custom-named containers. */
  containerNames?: Map<string, string>;
}

export function getRuntime(runtimeType?: string, opts?: RuntimeOpts): AgentRuntime {
  switch (runtimeType || 'docker') {
    case 'docker': {
      return new DockerRuntime(opts?.containerNames);
    }
    case 'native':
      return new NativeRuntime(opts?.port);
    case 'openclaw':
      return new OpenClawRuntime(opts?.gatewayUrl);
    default:
      throw new Error(`Unknown runtime: "${runtimeType}". Supported: docker, native, openclaw`);
  }
}

/**
 * Build container name mappings from BSCS config.
 * Scans all agents with runtime='docker' and a `container` field.
 */
export function buildContainerNamesFromConfig(
  agents: Record<string, { runtime?: string; container?: string }> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!agents) return map;
  for (const [name, agentConfig] of Object.entries(agents)) {
    if (agentConfig.runtime === 'docker' && agentConfig.container) {
      map.set(name, agentConfig.container);
    }
  }
  return map;
}
