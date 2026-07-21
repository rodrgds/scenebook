const SENSITIVE_KEY =
  /(?:password|passwd|pwd|secret|token|authorization|cookie|session|api[-_]?key|payload|fields|oidc)/iu;
const TOKEN_VALUE =
  /(?:Bearer\s+\S+|gh[pousr]_[A-Za-z0-9_]+|sk-(?:proj-)?[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/giu;
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/giu;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export function redactLogValue(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string')
    return value
      .replace(TOKEN_VALUE, '[REDACTED:TOKEN]')
      .replace(EMAIL_VALUE, '[REDACTED:EMAIL]')
      .slice(0, 10_000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value))
    return value.slice(0, 100).map((entry) => redactLogValue(entry, key, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>).slice(
      0,
      100,
    )) {
      output[entryKey] = redactLogValue(entry, entryKey, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function createJsonLogger(
  minimum: LogLevel,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const rank = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  const log = (
    level: LogLevel,
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ): void => {
    if (rank[level] < rank[minimum]) return;
    write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message: redactLogValue(message),
        ...(context ? { context: redactLogValue(context) } : {}),
      }),
    );
  };
  return {
    debug: (message, context) => log('debug', message, context),
    info: (message, context) => log('info', message, context),
    warn: (message, context) => log('warn', message, context),
    error: (message, context) => log('error', message, context),
  };
}
