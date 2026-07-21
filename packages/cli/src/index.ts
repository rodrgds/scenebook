import { parseArguments } from './arguments.js';
import { executeCommand } from './commands.js';
import { CliError, type CliContext, type CliIO } from './types.js';

export async function runCli(
  argv: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly io?: CliIO } = {},
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  const context: CliContext = {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdin: io.stdin ?? process.stdin,
    ...io,
  };
  try {
    return await executeCommand(parseArguments(argv), context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.stderr.write(`Error: ${message}\n`);
    return error instanceof CliError ? error.exitCode : 1;
  }
}

export { parseArguments } from './arguments.js';
export { loadConfig, findConfig } from './config.js';
export { buildProject, sceneDirectories } from './project.js';
export {
  approvePublication,
  migrateLegacyBaselines,
  persistImmutableBaseline,
  promotePublication,
  rollbackPublication,
  sealPublicationCandidate,
  validateLocalTrustStorage,
  validatePublicationDestination,
} from './local-publication.js';
export {
  projectPublicationAnalytics,
  projectPublicationCta,
  projectPublicationPlan,
} from './publication.js';
export type { ProjectPublicationSelection } from './publication.js';
export type { CliContext, CliIO, LoadedConfig, ParsedArguments } from './types.js';
