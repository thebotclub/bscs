import pino from 'pino';

// Log level from env (LOG_LEVEL) or default to 'info'.
// --verbose flag sets LOG_LEVEL=debug before calling createLogger.
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// Redact op:// secret references from log output so API keys never appear in logs.
const OP_REF_PATTERN = /op:\/\/[^\s"']+/g;

function redactOpRefs(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(OP_REF_PATTERN, 'op://<redacted>');
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactOpRefs(v);
    }
    return out;
  }
  return value;
}

const rootLogger = pino({
  level: LOG_LEVEL,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  serializers: {
    // Redact op:// refs from any 'err' or nested objects logged at the root level.
    err: pino.stdSerializers.err,
  },
  hooks: {
    logMethod(inputArgs, method) {
      // inputArgs is [mergingObject, msg?, ...args] or [msg, ...args]
      if (inputArgs.length >= 1 && typeof inputArgs[0] === 'object' && inputArgs[0] !== null) {
        inputArgs[0] = redactOpRefs(inputArgs[0]) as object;
      }
      return method.apply(this, inputArgs as Parameters<typeof method>);
    },
  },
});

export interface Logger {
  debug(obj: Record<string, unknown> | unknown, msg?: string): void;
  info(obj: Record<string, unknown> | unknown, msg?: string): void;
  warn(obj: Record<string, unknown> | unknown, msg?: string): void;
  error(obj: Record<string, unknown> | unknown, msg?: string): void;
}

export function getLogger(_level?: string): Logger {
  return rootLogger;
}

export function createLogger(name: string): Logger {
  return rootLogger.child({ module: name });
}
