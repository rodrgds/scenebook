export class ScenebookError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    options?: { cause?: unknown; details?: Readonly<Record<string, unknown>> },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ScenebookError';
    this.code = code;
    this.details = options?.details;
  }
}

export class InvariantError extends ScenebookError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('SCENEBOOK_INVARIANT', message, { details });
    this.name = 'InvariantError';
  }
}

export class UnsafePathError extends ScenebookError {
  constructor(path: string, root: string) {
    super('SCENEBOOK_UNSAFE_PATH', `Path ${JSON.stringify(path)} escapes ${JSON.stringify(root)}`, {
      details: { path, root },
    });
    this.name = 'UnsafePathError';
  }
}
