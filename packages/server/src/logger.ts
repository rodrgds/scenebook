import type { JsonObject, JsonValue } from '@scenebook/schema';

const SENSITIVE_KEY =
  /(?:password|passwd|pwd|secret|token|authorization|cookie|session|api[-_]?key|payload|fields|oidc)/iu;
const TOKEN_VALUE =
  /(?:Bearer\s+\S+|gh[pousr]_[A-Za-z0-9_]+|sk-(?:proj-)?[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/giu;
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/giu;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, context?: JsonObject): void;
  info(message: string, context?: JsonObject): void;
  warn(message: string, context?: JsonObject): void;
  error(message: string, context?: JsonObject): void;
}

function isLogString(value: JsonValue): value is string {
  return typeof value === 'string';
}

function isLogScalar(value: JsonValue): value is number | boolean | null {
  return typeof value === 'number' || typeof value === 'boolean' || value === null;
}

function isLogRecord(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Convert any caught value into a JSON-safe log entry. */
export function describeError<T>(error: T): JsonObject {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { message: String(error) };
}

function redactLogText(value: string): string {
  return value
    .replace(TOKEN_VALUE, '[REDACTED:TOKEN]')
    .replace(EMAIL_VALUE, '[REDACTED:EMAIL]')
    .slice(0, 10_000);
}

export function redactLogValue(value: JsonValue, key = '', depth = 0): JsonValue {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (depth > 8) return '[TRUNCATED]';
  if (isLogString(value)) return redactLogText(value);
  if (isLogScalar(value)) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => redactLogValue(entry, key, depth + 1));
  }
  if (isLogRecord(value)) {
    const output: JsonObject = {};
    for (const [entryKey, entry] of Object.entries(value).slice(0, 100)) {
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
  const log = (level: LogLevel, message: string, context?: JsonObject): void => {
    if (rank[level] < rank[minimum]) return;
    const entry: JsonObject = {
      timestamp: new Date().toISOString(),
      level,
      message: redactLogValue(message),
    };
    if (context) entry['context'] = redactLogValue(context);
    write(JSON.stringify(entry));
  };
  return {
    debug: (message, context) => log('debug', message, context),
    info: (message, context) => log('info', message, context),
    warn: (message, context) => log('warn', message, context),
    error: (message, context) => log('error', message, context),
  };
}
