import { parseDocument, stringify } from 'yaml';
import type { z } from 'zod';

import {
  ScenebookConfigSchema,
  ProjectSchema,
  type Project,
  type ScenebookConfig,
} from './config.js';
import { migrateConfigDocument, migrateProjectDocument, migrateSceneDocument } from './migrate.js';
import { SceneSchema, type Scene } from './scene.js';

export class YamlDocumentError extends Error {
  readonly errors: readonly string[];

  constructor(message: string, errors: readonly string[]) {
    super(message);
    this.name = 'YamlDocumentError';
    this.errors = errors;
  }
}

function parseYamlUnknown(source: string): unknown {
  if (source.length > 10_000_000) {
    throw new YamlDocumentError('YAML document exceeds the 10 MB safety limit', []);
  }
  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    const errors = document.errors.map((error) => error.message);
    throw new YamlDocumentError('Invalid YAML document', errors);
  }
  if (document.warnings.length > 0) {
    const duplicateOrAliasWarning = document.warnings.find((warning) =>
      /alias|duplicate|merge key/iu.test(warning.message),
    );
    if (duplicateOrAliasWarning) {
      throw new YamlDocumentError('Unsafe or ambiguous YAML document', [
        duplicateOrAliasWarning.message,
      ]);
    }
  }
  return document.toJS({ maxAliasCount: 0 });
}

function parseWithMigration<T>(
  source: string,
  schema: z.ZodType<T>,
  migrate: (input: unknown) => unknown,
): T {
  return schema.parse(migrate(parseYamlUnknown(source)));
}

function serializeWithSchema<T>(value: T, schema: z.ZodType<T>): string {
  const parsed = schema.parse(value);
  return stringify(parsed, {
    aliasDuplicateObjects: false,
    lineWidth: 0,
    sortMapEntries: true,
  });
}

export function parseSceneYaml(source: string): Scene {
  return parseWithMigration(source, SceneSchema, migrateSceneDocument);
}

export function serializeSceneYaml(scene: Scene): string {
  return serializeWithSchema(scene, SceneSchema);
}

export function parseProjectYaml(source: string): Project {
  return parseWithMigration(source, ProjectSchema, migrateProjectDocument);
}

export function serializeProjectYaml(project: Project): string {
  return serializeWithSchema(project, ProjectSchema);
}

export function parseConfigYaml(source: string): ScenebookConfig {
  return parseWithMigration(source, ScenebookConfigSchema, migrateConfigDocument);
}

export function serializeConfigYaml(config: ScenebookConfig): string {
  return serializeWithSchema(config, ScenebookConfigSchema);
}

export function parseYamlWithSchema<T>(source: string, schema: z.ZodType<T>): T {
  return schema.parse(parseYamlUnknown(source));
}

export function serializeYamlWithSchema<T>(value: T, schema: z.ZodType<T>): string {
  return serializeWithSchema(value, schema);
}
