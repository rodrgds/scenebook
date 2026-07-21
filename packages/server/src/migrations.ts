import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256 } from '@scenebook/core';
import type { Pool, PoolClient } from 'pg';

export interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
}

async function migrationFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name)).sort();
}

async function applyOne(
  client: PoolClient,
  name: string,
  sql: string,
  checksum: string,
): Promise<boolean> {
  const existing = await client.query<{ checksum: string }>(
    'SELECT checksum FROM schema_migrations WHERE name = $1',
    [name],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].checksum !== checksum)
      throw new Error(`Migration checksum changed after application: ${name}`);
    return false;
  }
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [
      name,
      checksum,
    ]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function runMigrations(
  pool: Pool,
  directory = fileURLToPath(new URL('../migrations/', import.meta.url)),
): Promise<AppliedMigration[]> {
  const client = await pool.connect();
  const applied: AppliedMigration[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [1_394_915_386]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of await migrationFiles(directory)) {
      const sql = await readFile(join(directory, name), 'utf8');
      const checksum = sha256(sql);
      if (await applyOne(client, name, sql, checksum)) applied.push({ name, checksum });
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [1_394_915_386]).catch(() => undefined);
    client.release();
  }
  return applied;
}
