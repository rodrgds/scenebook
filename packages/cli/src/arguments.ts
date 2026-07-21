import type { ParsedArguments } from './types.js';

const BOOLEAN_OPTIONS = new Set([
  'allow-remote',
  'allow-unscanned-privacy',
  'dry-run',
  'help',
  'upload',
  'version',
  'yes',
]);

const VALUE_OPTIONS = new Set([
  'actor',
  'adapter',
  'baseline',
  'base-path',
  'base-url',
  'build',
  'candidate',
  'command-json',
  'channel',
  'collection',
  'config',
  'destination',
  'decision',
  'fallback-locale',
  'format',
  'host',
  'import',
  'kind',
  'locale',
  'name',
  'oidc-audience',
  'output',
  'port',
  'provider',
  'reason',
  'release',
  'review',
  'run',
  'scanner-id',
  'scanner-version',
  'server-url',
  'scene',
  'test',
  'target',
  'workspace-id',
  'project-id',
]);

const SHORT_BOOLEAN_OPTIONS = new Set(['h', 'v', 'y']);
const SHORT_VALUE_OPTIONS = new Set(['o', 'p']);

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`Option ${option} requires a value.`);
  return value;
}

function addOption(
  options: Map<string, string | boolean | readonly string[]>,
  key: string,
  value: string | boolean,
): void {
  const existing = options.get(key);
  if (existing === undefined) options.set(key, value);
  else if (Array.isArray(existing)) options.set(key, [...existing, String(value)]);
  else options.set(key, [String(existing), String(value)]);
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string | boolean | readonly string[]>();
  let command: string | undefined;
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    if (value === '--') {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && value.startsWith('--')) {
      const equal = value.indexOf('=');
      if (equal > 2) {
        const key = value.slice(2, equal);
        const optionValue = value.slice(equal + 1);
        if (VALUE_OPTIONS.has(key) && optionValue.length === 0) {
          throw new Error(`Option --${key} requires a value.`);
        }
        addOption(options, key, optionValue);
      } else if (value.startsWith('--no-')) {
        addOption(options, value.slice(5), false);
      } else {
        const key = value.slice(2);
        if (BOOLEAN_OPTIONS.has(key)) {
          addOption(options, key, true);
        } else if (VALUE_OPTIONS.has(key)) {
          addOption(options, key, requiredValue(argv, index, `--${key}`));
          index += 1;
        } else {
          const next = argv[index + 1];
          if (next && !next.startsWith('-')) {
            addOption(options, key, next);
            index += 1;
          } else addOption(options, key, true);
        }
      }
      continue;
    }
    if (!positionalOnly && value.startsWith('-') && value.length > 1) {
      const body = value.slice(1);
      for (let shortIndex = 0; shortIndex < body.length; shortIndex += 1) {
        const key = body[shortIndex];
        if (!key) continue;
        if (SHORT_VALUE_OPTIONS.has(key)) {
          const attached = body.slice(shortIndex + 1).replace(/^=/, '');
          if (attached) addOption(options, key, attached);
          else {
            addOption(options, key, requiredValue(argv, index, `-${key}`));
            index += 1;
          }
          break;
        }
        addOption(options, key, true);
        if (!SHORT_BOOLEAN_OPTIONS.has(key)) continue;
      }
      continue;
    }
    if (!command) command = value;
    else positionals.push(value);
  }
  return { ...(command ? { command } : {}), positionals, options };
}

export function optionString(
  arguments_: ParsedArguments,
  name: string,
  short?: string,
): string | undefined {
  const value = arguments_.options.get(name) ?? (short ? arguments_.options.get(short) : undefined);
  if (Array.isArray(value)) return value.at(-1);
  return typeof value === 'string' ? value : undefined;
}

export function optionStrings(arguments_: ParsedArguments, name: string): string[] {
  const value = arguments_.options.get(name);
  if (Array.isArray(value)) return value.flatMap((entry) => entry.split(',')).filter(Boolean);
  return typeof value === 'string' ? value.split(',').filter(Boolean) : [];
}

export function optionBoolean(arguments_: ParsedArguments, name: string, short?: string): boolean {
  const value = arguments_.options.get(name) ?? (short ? arguments_.options.get(short) : undefined);
  return value === true || value === 'true' || value === '1';
}
