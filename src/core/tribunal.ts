/**
 * Core tribunal module — install, configure, health check.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from '../util/logger.js';

const logger = createLogger('tribunal');

// ── Types ────────────────────────────────────────────────────────────

export interface TribunalConfig {
  version: string;
  agent: { name: string; type: string };
  hooks: {
    preToolUse: string[];
    postToolUse: string[];
  };
  rules: {
    preventFileDeletion: boolean;
    preventCommandExecution: string[];
    requireApprovalFor: string[];
  };
}

export interface TribunalHealthResult {
  installed: boolean;
  version?: string;
  configValid: boolean;
  agentName: string;
  errors: string[];
}

// ── Installation ─────────────────────────────────────────────────────

export function isTribunalInstalled(): boolean {
  try {
    execFileSync('which', ['tribunal'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getTribunalVersion(): string | null {
  try {
    return execFileSync('tribunal', ['--version'], { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

export function installTribunal(): { success: boolean; error?: string } {
  try {
    let pipCmd = 'pip';
    try {
      execFileSync('which', ['pipx'], { stdio: 'ignore' });
      pipCmd = 'pipx';
    } catch {
      try {
        execFileSync('which', ['pip3'], { stdio: 'ignore' });
        pipCmd = 'pip3';
      } catch {
        // fall back to pip
      }
    }
    execFileSync(pipCmd, ['install', 'tribunal'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Configuration ────────────────────────────────────────────────────

export function getTribunalConfigPath(agentName: string): string {
  const base = process.env.BSCS_CONFIG_DIR || join(homedir(), '.config', 'bscs');
  return join(base, 'agents', agentName, '.tribunal', 'config.json');
}

export function loadTribunalConfig(agentName: string): TribunalConfig | null {
  const configPath = getTribunalConfigPath(agentName);
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveTribunalConfig(agentName: string, config: TribunalConfig): void {
  const configPath = getTribunalConfigPath(agentName);
  const dir = join(configPath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  logger.info({ agentName }, 'Tribunal config saved');
}

export function createDefaultTribunalConfig(agentName: string): TribunalConfig {
  return {
    version: '1.0',
    agent: { name: agentName, type: 'coding' },
    hooks: {
      preToolUse: ['tribunal check'],
      postToolUse: ['tribunal log'],
    },
    rules: {
      preventFileDeletion: true,
      preventCommandExecution: ['rm -rf', 'sudo'],
      requireApprovalFor: ['npm publish', 'git push'],
    },
  };
}

// ── Health Check ─────────────────────────────────────────────────────

export function checkTribunalHealth(agentName: string): TribunalHealthResult {
  const errors: string[] = [];
  const installed = isTribunalInstalled();
  const version = getTribunalVersion() ?? undefined;

  if (!installed) {
    errors.push('Tribunal is not installed');
  }

  const config = loadTribunalConfig(agentName);
  let configValid = false;

  if (!config) {
    errors.push('Tribunal config not found');
  } else {
    if (!config.version) errors.push('Missing version in config');
    if (!config.agent?.name) errors.push('Missing agent name in config');
    if (!config.rules) errors.push('Missing rules in config');
    configValid = errors.length === (installed ? 0 : 1);
  }

  return { installed, version, configValid, agentName, errors };
}
