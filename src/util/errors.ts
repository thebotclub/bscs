import chalk from 'chalk';
import { createLogger } from './logger.js';

const logger = createLogger('cli');

/**
 * A user-facing error with an optional actionable suggestion.
 * These are shown cleanly without stack traces.
 */
export class UserError extends Error {
  public readonly suggestion?: string;

  constructor(message: string, suggestion?: string) {
    super(message);
    this.name = 'UserError';
    this.suggestion = suggestion;
  }
}

/**
 * Wrap a CLI action function with consistent error handling.
 * - UserError: shows message + suggestion, exit code 1
 * - Other errors: shows message + suggests LOG_LEVEL=debug, exit code 2
 */
export async function withErrorHandler(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof UserError) {
      console.error(chalk.red(`Error: ${err.message}`));
      if (err.suggestion) {
        console.error(chalk.dim(err.suggestion));
      }
      process.exitCode = 1;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${message}`));
      console.error(chalk.dim('Run with LOG_LEVEL=debug for details'));
      logger.error({ err }, 'Unhandled error');
      process.exitCode = 2;
    }
  }
}
