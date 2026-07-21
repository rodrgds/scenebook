import type { z } from 'zod';

import { serializeYamlWithSchema } from '@scenebook/schema';

import { atomicWriteFile, type AtomicWriteOptions } from './atomic.js';

export async function writeYamlAtomic<T>(
  path: string,
  value: T,
  schema: z.ZodType<T>,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await atomicWriteFile(path, serializeYamlWithSchema(value, schema), options);
}
