import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';
import { createLogger } from '../util/logger.js';
import {
  BscsConfigSchema,
  type BscsConfig,
} from '../util/types.js';

export type { BscsConfig };

const logger = createLogger('config');

const DEFAULT_CONFIG: BscsConfig = {
  version: '1.0',
  docker: {
    image: 'ghcr.io/thebotclub/bscs:latest',
    registry: 'ghcr.io',
    security: {
      noNewPrivileges: true,
      capDropAll: true,
      tmpfs: true,
      pidsLimit: 256,
      readOnlyRootfs: false,
    },
    resources: {
      coding: { memory: '4g', pidsLimit: 512 },
      review: { memory: '2g', pidsLimit: 256 },
      brain: { memory: '2g', pidsLimit: 128 },
      ops: { memory: '2g', pidsLimit: 256 },
      default: { memory: '2g', pidsLimit: 256 },
    },
  },
  defaults: {
    image: 'ghcr.io/thebotclub/bscs:latest',
    portRange: {
      start: 19000,
      end: 19999,
    },
  },
  models: {
    providers: {},
    defaults: { coding: 'claude-sonnet-4', brain: 'claude-opus-4', review: 'claude-sonnet-4', ops: 'claude-haiku-3.5' },
    fallbacks: {},
  },
};

function getConfigPath(): string {
  return process.env.BSCS_CONFIG_DIR 
    ? `${process.env.BSCS_CONFIG_DIR}/config.json`
    : `${homedir()}/.config/bscs/config.json`;
}

export function loadConfig(): BscsConfig {
  const configPath = getConfigPath();
  logger.debug({ configPath }, 'Loading config');
  
  if (!existsSync(configPath)) {
    logger.debug('Config file not found, returning defaults');
    return DEFAULT_CONFIG;
  }
  
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const config = BscsConfigSchema.parse(parsed);
    logger.debug('Config loaded successfully');
    return config;
  } catch (err) {
    logger.error({ err }, 'Failed to load config');
    throw new Error(`Failed to load config from ${configPath}: ${err}`);
  }
}

export function saveConfig(config: BscsConfig): void {
  const configPath = getConfigPath();
  const configDir = dirname(configPath);
  
  logger.debug({ configPath }, 'Saving config');
  
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
    logger.debug({ configDir }, 'Created config directory');
  }
  
  try {
    const validated = BscsConfigSchema.parse(config);
    writeFileSync(configPath, JSON.stringify(validated, null, 2));
    logger.debug('Config saved successfully');
  } catch (err) {
    logger.error({ err }, 'Failed to save config');
    throw new Error(`Failed to save config to ${configPath}: ${err}`);
  }
}

export function getConfigPathString(): string {
  return getConfigPath();
}

export { DEFAULT_CONFIG };
