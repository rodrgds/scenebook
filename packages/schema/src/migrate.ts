import { SCHEMA_VERSION } from './common.js';

export type DocumentKind = 'config' | 'project' | 'scene';

export class UnsupportedSchemaVersionError extends Error {
  readonly documentKind: DocumentKind;
  readonly receivedVersion: number;
  readonly supportedVersion: number;

  constructor(documentKind: DocumentKind, receivedVersion: number) {
    super(
      `${documentKind} schema version ${receivedVersion} is not supported; this build supports ${SCHEMA_VERSION}`,
    );
    this.name = 'UnsupportedSchemaVersionError';
    this.documentKind = documentKind;
    this.receivedVersion = receivedVersion;
    this.supportedVersion = SCHEMA_VERSION;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readVersion(value: Record<string, unknown>): number {
  const candidate = value.schemaVersion ?? value.version ?? 0;
  if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0)
    return candidate;
  if (typeof candidate === 'string' && /^\d+$/u.test(candidate)) return Number(candidate);
  return 0;
}

function slugifyLegacy(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 100)
    .replace(/-+$/u, '');
  return slug || 'untitled';
}

function migrateSceneV0(value: Record<string, unknown>): Record<string, unknown> {
  const title =
    typeof value.title === 'string'
      ? value.title
      : typeof value.name === 'string'
        ? value.name
        : 'Untitled Scene';
  const id = typeof value.id === 'string' ? value.id : slugifyLegacy(title);
  const steps = Array.isArray(value.steps)
    ? value.steps.map((candidate, index) => {
        if (!isRecord(candidate)) return candidate;
        const step = { ...candidate };
        step.id ??= `step-${String(index + 1).padStart(2, '0')}`;
        step.title ??= step.caption ?? step.name ?? `Step ${index + 1}`;
        step.kind ??= step.states !== undefined ? 'browser' : 'explanation';
        if (step.presentation === undefined) step.presentation = {};
        delete step.name;
        return step;
      })
    : value.steps;

  const migrated: Record<string, unknown> = {
    ...value,
    schemaVersion: SCHEMA_VERSION,
    id,
    title,
    slug: typeof value.slug === 'string' ? value.slug : slugifyLegacy(title),
    steps,
  };
  delete migrated.version;
  delete migrated.name;
  return migrated;
}

function migrateProjectV0(value: Record<string, unknown>): Record<string, unknown> {
  const name = typeof value.name === 'string' ? value.name : 'Scenebook Project';
  const migrated: Record<string, unknown> = {
    ...value,
    schemaVersion: SCHEMA_VERSION,
    id: typeof value.id === 'string' ? value.id : slugifyLegacy(name),
    name,
    slug: typeof value.slug === 'string' ? value.slug : slugifyLegacy(name),
  };
  delete migrated.version;
  return migrated;
}

function migrateConfigV0(value: Record<string, unknown>): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...value, schemaVersion: SCHEMA_VERSION };
  delete migrated.version;
  if (migrated.project === undefined && typeof value.projectFile === 'string') {
    migrated.project = value.projectFile;
    delete migrated.projectFile;
  }
  return migrated;
}

export function migrateDocument(kind: DocumentKind, input: unknown): unknown {
  if (!isRecord(input)) return input;
  const version = readVersion(input);
  if (version > SCHEMA_VERSION) throw new UnsupportedSchemaVersionError(kind, version);
  if (version === SCHEMA_VERSION) {
    if ('version' in input && !('schemaVersion' in input)) {
      const migrated: Record<string, unknown> = { ...input, schemaVersion: SCHEMA_VERSION };
      delete migrated.version;
      return migrated;
    }
    return input;
  }
  if (version === 0) {
    if (kind === 'scene') return migrateSceneV0(input);
    if (kind === 'project') return migrateProjectV0(input);
    return migrateConfigV0(input);
  }
  throw new UnsupportedSchemaVersionError(kind, version);
}

export function migrateSceneDocument(input: unknown): unknown {
  return migrateDocument('scene', input);
}

export function migrateProjectDocument(input: unknown): unknown {
  return migrateDocument('project', input);
}

export function migrateConfigDocument(input: unknown): unknown {
  return migrateDocument('config', input);
}
