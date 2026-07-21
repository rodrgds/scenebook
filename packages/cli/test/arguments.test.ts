import { describe, expect, it } from 'vitest';
import { optionBoolean, optionString, optionStrings, parseArguments } from '../src/arguments.js';

describe('CLI argument parsing', () => {
  it('supports value-taking short options, boolean clusters, repeated values, and negation', () => {
    const parsed = parseArguments([
      'export',
      '-o',
      'dist',
      '-hvy',
      '--format',
      'pdf',
      '--format=markdown',
      '--channel',
      'docs',
      '--collection=onboarding',
      '--no-color',
    ]);

    expect(parsed.command).toBe('export');
    expect(optionString(parsed, 'output', 'o')).toBe('dist');
    expect(optionBoolean(parsed, 'help', 'h')).toBe(true);
    expect(optionBoolean(parsed, 'version', 'v')).toBe(true);
    expect(optionBoolean(parsed, 'yes', 'y')).toBe(true);
    expect(optionStrings(parsed, 'format')).toEqual(['pdf', 'markdown']);
    expect(optionString(parsed, 'channel')).toBe('docs');
    expect(optionString(parsed, 'collection')).toBe('onboarding');
    expect(parsed.options.get('color')).toBe(false);
  });

  it('supports attached values and keeps arguments after boolean options positional', () => {
    const parsed = parseArguments([
      'build',
      '-odist',
      '-p=6100',
      '--allow-unscanned-privacy',
      'scene-id',
    ]);

    expect(optionString(parsed, 'output', 'o')).toBe('dist');
    expect(optionString(parsed, 'port', 'p')).toBe('6100');
    expect(optionBoolean(parsed, 'allow-unscanned-privacy')).toBe(true);
    expect(parsed.positionals).toEqual(['scene-id']);
  });

  it.each([
    [['build', '-o'], '-o'],
    [['build', '-p', '--help'], '-p'],
    [['build', '--output'], '--output'],
    [['export', '--format='], '--format'],
    [['dev', '--channel'], '--channel'],
    [['publish', '--collection='], '--collection'],
    [['test', '--target'], '--target'],
    [['test', '--base-url='], '--base-url'],
  ])('rejects a missing value for %s', (argv, option) => {
    expect(() => parseArguments(argv)).toThrow(`Option ${option} requires a value.`);
  });

  it('preserves explicit positional-only arguments', () => {
    const parsed = parseArguments(['test', '--', '--project', 'chromium']);
    expect(parsed.positionals).toEqual(['--project', 'chromium']);
  });
});
