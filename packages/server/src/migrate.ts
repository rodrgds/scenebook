import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import { loadServerConfig } from './config.js';
import { runMigrations } from './migrations.js';

export async function migrateFromEnvironment(): Promise<void> {
  const config = loadServerConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const applied = await runMigrations(pool);
    process.stdout.write(`${JSON.stringify({ applied })}\n`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrateFromEnvironment();
}
