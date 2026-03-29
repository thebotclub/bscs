import chalk from 'chalk';

export interface OutputOptions {
  json?: boolean;
  quiet?: boolean;
  color?: boolean;
}

/**
 * Format data as a table for human-readable output
 */
export function formatTable(
  headers: string[],
  rows: string[][],
  _options?: { maxWidth?: number }
): string {
  if (rows.length === 0) {
    return chalk.gray('No data to display');
  }

  // Calculate column widths
  const colWidths = headers.map((h, i) => {
    const maxRowWidth = Math.max(...rows.map((r) => (r[i] ?? '').length));
    return Math.max(h.length, maxRowWidth);
  });

  // Build header line
  const headerLine = headers.map((h, i) => h.padEnd(colWidths[i] ?? 0)).join('  ');

  // Build separator
  const separator = colWidths.map((w) => '─'.repeat(w)).join('──');

  // Build rows
  const rowLines = rows.map((row) =>
    row.map((cell, i) => (cell ?? '').padEnd(colWidths[i] ?? 0)).join('  ')
  );

  return [chalk.bold(headerLine), chalk.gray(separator), ...rowLines].join('\n');
}

/**
 * Format data as JSON
 */
export function formatJson(data: unknown, pretty = true): string {
  return pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}

/**
 * Format output based on options
 */
export function formatOutput(
  data: unknown,
  options: OutputOptions,
  humanFormatter?: () => string
): string {
  if (options.quiet) {
    return '';
  }

  if (options.json) {
    return formatJson(data);
  }

  return humanFormatter ? humanFormatter() : formatJson(data);
}

/**
 * Print a success message
 */
export function printSuccess(message: string, options?: OutputOptions): void {
  if (options?.quiet) return;

  const colored = options?.color !== false ? chalk.green('✓') : '✓';
  console.log(`${colored} ${message}`);
}

/**
 * Print an error message
 */
export function printError(message: string, options?: OutputOptions): void {
  if (options?.quiet) return;

  const colored = options?.color !== false ? chalk.red('✗') : '✗';
  console.error(`${colored} ${message}`);
}

/**
 * Print a warning message
 */
export function printWarning(message: string, options?: OutputOptions): void {
  if (options?.quiet) return;

  const colored = options?.color !== false ? chalk.yellow('⚠') : '⚠';
  console.log(`${colored} ${message}`);
}

/**
 * Print an info message
 */
export function printInfo(message: string, options?: OutputOptions): void {
  if (options?.quiet) return;

  console.log(message);
}
