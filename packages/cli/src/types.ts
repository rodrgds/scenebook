import type { Project, ScenebookConfig } from '@scenebook/schema';

export interface CliIO {
  readonly stdin?: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
  readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export interface ParsedArguments {
  readonly command?: string;
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string | boolean | readonly string[]>;
}

export interface LoadedConfig {
  readonly path: string;
  readonly directory: string;
  readonly config: ScenebookConfig;
  readonly project: Project;
  readonly projectPath?: string;
}

export interface CliContext extends CliIO {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export class CliError extends Error {
  public constructor(
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
