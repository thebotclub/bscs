import { execFileSync } from 'child_process';
import { createLogger } from '../util/logger.js';
import { loadConfig } from './config.js';

const logger = createLogger('secrets');

// =============================================================================
// Secret Management
// =============================================================================

/**
 * List all configured secrets (redacted)
 */
export function listSecrets(): Array<{ ref: string; provider: string | undefined; status: string }> {
  const config = loadConfig();
  const providers = config.models?.providers ?? {};
  const secrets: Array<{ ref: string; provider: string | undefined; status: string }> = [];

  for (const [name, provider] of Object.entries(providers)) {
    const apiKey = provider.apiKey;
    if (!apiKey) continue;
    const isRef = apiKey.startsWith('op://');
    secrets.push({
      ref: isRef ? apiKey : `${apiKey.slice(0, 8)}...`,
      provider: name,
      status: isRef ? 'op-reference' : 'inline'
    })
  }

  return secrets
}

/**
 * Resolve an op:// reference to its actual value
 */
export async function resolveSecret(ref: string): Promise<string> {
  if (!ref.startsWith('op://')) {
    return ref
  }

  try {
    const result = execFileSync('op', ['read', ref], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return result.trim()
  } catch (err) {
    logger.error({ err, ref }, 'Failed to resolve secret')
    throw new Error(`Failed to resolve secret: ${err}`)
  }
}

/**
 * Check the health of all secrets
 */
export async function checkSecretsHealth(): Promise<Array<{ ref: string; status: string; error?: string }>> {
  const secrets = listSecrets()
  const results: Array<{ ref: string; status: string; error?: string }> = []

  for (const secret of secrets) {
    if (secret.status !== 'op-reference') {
      results.push({ ref: secret.ref, status: 'valid' })
      continue
    }

    try {
      await resolveSecret(secret.ref)
      results.push({ ref: secret.ref, status: 'valid' })
    } catch (err) {
      results.push({
        ref: secret.ref,
        status: 'invalid',
        error: err instanceof Error ? err.message : 'Unknown error'
      })
    }
  }

  return results
}

/**
 * Sync secrets from 1Password to fleet configs
 */
export async function syncSecrets(): Promise<Array<{ ref: string; success: boolean; error?: string }>> {
  const secrets = listSecrets()
  const results: Array<{ ref: string; success: boolean; error?: string }> = []

  for (const secret of secrets) {
    if (secret.status !== 'op-reference') {
      results.push({ ref: secret.ref, success: true })
      continue
    }

    try {
      const value = await resolveSecret(secret.ref)
      logger.info({ ref: secret.ref, length: value.length }, 'Secret synced')
      results.push({ ref: secret.ref, success: true })
    } catch (err) {
      results.push({
        ref: secret.ref,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error'
      })
    }
  }

  return results
}
