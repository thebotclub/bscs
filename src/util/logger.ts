/**
 * Simple pino logger placeholder
 * Will be properly implemented with pino in later phase
 */

let logger: Logger | null = null;

interface Logger {
  debug(obj: Record<string, unknown> | unknown, msg?: string): void;
  info(obj: Record<string, unknown> | unknown, msg?: string): void;
  warn(obj: Record<string, unknown> | unknown, msg?: string): void;
  error(obj: Record<string, unknown> | unknown, msg?: string): void;
}

export function getLogger(_level?: string): Logger {
  if (!logger) {
    logger = createConsoleLogger();
  }
  return logger;
}

export function createLogger(name: string): Logger {
  return {
    debug: (obj, msg) => console.debug(`[${name}] [DEBUG]`, typeof obj === 'object' ? JSON.stringify(obj) : obj, msg || ''),
    info: (obj, msg) => console.info(`[${name}] [INFO]`, typeof obj === 'object' ? JSON.stringify(obj) : obj, msg || ''),
    warn: (obj, msg) => console.warn(`[${name}] [WARN]`, typeof obj === 'object' ? JSON.stringify(obj) : obj, msg || ''),
    error: (obj, msg) => console.error(`[${name}] [ERROR]`, typeof obj === 'object' ? JSON.stringify(obj) : obj, msg || ''),
  };
}

function createConsoleLogger(): Logger {
  return {
    debug: (obj, msg) => console.debug('[DEBUG]', typeof obj === 'object' ? JSON.stringify(obj) : obj, msg || ''),
    info: (obj, msg) => console.info('[INFO]', typeof obj === 'object' ? JSON.stringify(obj) : obj, msg || ''),
    warn: (obj, msg) => console.warn('[WARN]', typeof obj === 'object' ? JSON.stringify(obj) : obj, msg || ''),
    error: (obj, msg) => console.error('[ERROR]', typeof obj === 'object' ? JSON.stringify(obj) : obj, msg || ''),
  };
}
