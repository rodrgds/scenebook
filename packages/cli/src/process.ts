import { spawn } from 'node:child_process';
import { CliError } from './types.js';

export async function runProcess(
  command: string,
  arguments_: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly quiet?: boolean },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...arguments_], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    child.once('error', (error) =>
      reject(new CliError(`Could not start ${command}: ${error.message}`)),
    );
    child.once('close', (code, signal) => {
      if (signal) reject(new CliError(`${command} was terminated by ${signal}.`, 130));
      else resolve(code ?? 1);
    });
  });
}
