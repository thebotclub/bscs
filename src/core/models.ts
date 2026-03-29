import { createLogger } from '../util/logger.js';
import { loadConfig, saveConfig } from './config.js';
import {
  ProviderSchema,
  type Provider,
  type ProviderType,
  type ProviderStatus,
  ProviderStatusSchema,
} from '../util/types.js';

const logger = createLogger('models');

// =============================================================================
// Model Provider Management
// =============================================================================

const PROVIDER_ENDPOINTS: Record<ProviderType, { baseUrl: string; modelsPath?: string }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com/v1' },
  openai: { baseUrl: 'https://api.openai.com/v1', modelsPath: '/models' },
  google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  ollama: { baseUrl: 'http://localhost:11434' },
  llamacpp: { baseUrl: 'http://localhost:8080' },
  litellm: { baseUrl: 'http://localhost:4000' },
};

const DEFAULT_MODEL_DEFAULTS: Record<string, string> = {
  coding: 'claude-sonnet-4',
  brain: 'claude-opus-4',
  review: 'claude-sonnet-4',
  ops: 'claude-haiku-3.5',
};

const DEFAULT_MODEL_FALLBACKS: Record<string, string[]> = {
  coding: ['claude-sonnet-4', 'claude-sonnet-4-5', 'gpt-4o'],
  brain: ['claude-opus-4', 'claude-sonnet-4', 'gpt-4o'],
  review: ['claude-sonnet-4', 'claude-sonnet-4-5', 'gpt-4o'],
  ops: ['claude-haiku-3.5', 'claude-sonnet-4'],
};

/**
 * List all configured providers
 */
export function listProviders(): ProviderStatus[] {
  const config = loadConfig();
  const providers = config.models?.providers ?? {};
  const results: ProviderStatus[] = [];

  for (const [name, provider] of Object.entries(providers)) {
    const status = checkProviderStatus(name, provider);
    results.push(status);
  }

  return results;
}

/**
 * Check the status of a provider
 */
function checkProviderStatus(name: string, provider: Provider): ProviderStatus {
  if (!provider.enabled) {
    return ProviderStatusSchema.parse({
      name,
      type: provider.type,
      enabled: false,
      local: provider.local ?? false,
      status: 'unknown',
    });
  }

  if (provider.local) {
    const baseUrl = provider.baseUrl ?? PROVIDER_ENDPOINTS[provider.type]?.baseUrl;
    if (!baseUrl) {
      return ProviderStatusSchema.parse({
        name,
        type: provider.type,
        enabled: true,
        local: true,
        status: 'unhealthy',
        error: 'No base URL configured',
      });
    }
    return ProviderStatusSchema.parse({
      name,
      type: provider.type,
      enabled: true,
      local: true,
      status: 'healthy',
    });
  }

  const hasKey = provider.apiKey && (provider.apiKey.startsWith('op://') || provider.apiKey.length > 10);
  
  return ProviderStatusSchema.parse({
    name,
    type: provider.type,
    enabled: true,
    local: false,
    status: hasKey ? 'healthy' : 'unhealthy',
    error: hasKey ? undefined : 'API key not configured',
  });
}

/**
 * Add a new provider
 */
export function addProvider(name: string, options: {
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  local?: boolean;
  gpu?: boolean;
}): void {
  const config = loadConfig();
  
  if (!config.models) {
    config.models = { providers: {}, defaults: {}, fallbacks: {} };
  }
  if (!config.models.providers) {
    config.models.providers = {};
  }
  if (config.models.providers[name]) {
    throw new Error(`Provider "${name}" already exists`);
  }

  const provider = ProviderSchema.parse({
    type: options.type,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    local: options.local ?? false,
    gpu: options.gpu ?? false,
    enabled: true,
  });

  config.models.providers[name] = provider;
  saveConfig(config);
  logger.info({ provider: name }, 'Provider added');
}

/**
 * Remove a provider
 */
export function removeProvider(name: string): void {
  const config = loadConfig();
  
  if (!config.models?.providers?.[name]) {
    throw new Error(`Provider "${name}" not found`);
  }

  delete config.models.providers[name];
  saveConfig(config);
  logger.info({ provider: name }, 'Provider removed');
}

/**
 * Test a provider's connectivity
 */
export async function testProvider(name: string): Promise<{ success: boolean; error?: string; latencyMs?: number }> {
  const config = loadConfig();
  const provider = config.models?.providers?.[name];
  
  if (!provider) {
    throw new Error(`Provider "${name}" not found`);
  }

  const endpoint = PROVIDER_ENDPOINTS[provider.type];
  if (!endpoint) {
    return { success: false, error: 'Unknown provider type' };
  }

  const baseUrl = provider.baseUrl ?? endpoint.baseUrl;
  const startTime = Date.now();

  try {
    if (provider.local) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      try {
        const response = await fetch(baseUrl, {
          method: 'GET',
          signal: controller.signal,
        });
        clearTimeout(timeout);
        
        return {
          success: response.ok || response.status === 404,
          latencyMs: Date.now() - startTime,
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    const hasValidKey = Boolean(provider.apiKey && (
      provider.apiKey.startsWith('op://') ||
      provider.apiKey.length > 10
    ));

    return {
      success: hasValidKey,
      error: hasValidKey ? undefined : 'API key not configured or invalid',
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Health check all providers
 */
export async function providersStatus(): Promise<Array<ProviderStatus & { error?: string }>> {
  const config = loadConfig();
  const providers = config.models?.providers ?? {};
  const results: Array<ProviderStatus & { error?: string }> = [];

  for (const [name, provider] of Object.entries(providers)) {
    const baseStatus = checkProviderStatus(name, provider);
    
    if (provider.enabled && !provider.local) {
      const testResult = await testProvider(name);
      results.push({
        ...baseStatus,
        status: testResult.success ? 'healthy' : 'unhealthy',
        error: testResult.error,
      });
    } else {
      results.push(baseStatus);
    }
  }

  return results;
}

/**
 * Show model defaults by role
 */
export function showDefaults(): Record<string, string> {
  const config = loadConfig();
  return config.models?.defaults ?? DEFAULT_MODEL_DEFAULTS;
}

/**
 * Get the effective model for an agent
 */
export function getEffectiveModel(agentName: string, role: string = 'custom'): string {
  const config = loadConfig();
  
  const agentConfig = config.agents?.[agentName];
  if (agentConfig?.model) {
    return agentConfig.model;
  }
  
  const defaults = config.models?.defaults ?? DEFAULT_MODEL_DEFAULTS;
  return defaults[role] ?? defaults['custom'] ?? 'claude-sonnet-4';
}

/**
 * Show fallback chains
 */
export function showFallbacks(): Record<string, string[]> {
  const config = loadConfig();
  return config.models?.fallbacks ?? DEFAULT_MODEL_FALLBACKS;
}

/**
 * Set fallback chain for a role
 */
export function setFallback(role: string, chain: string[]): void {
  const config = loadConfig();
  
  if (!config.models) {
    config.models = { providers: {}, defaults: {}, fallbacks: {} };
  }
  if (!config.models.fallbacks) {
    config.models.fallbacks = {};
  }
  
  config.models.fallbacks[role] = chain;
  saveConfig(config);
  logger.info({ role, chain }, 'Fallback chain set');
}
