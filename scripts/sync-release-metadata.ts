import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  deriveReleaseMetadata,
  discoverPublicPackages,
  metadataMatches,
  readManifest,
  workspaceRoot,
} from './release-packages';

const write = process.argv.includes('--write');
const check = process.argv.includes('--check');
if (write === check) {
  throw new Error('Use exactly one of --write or --check');
}

async function main(): Promise<void> {
  const root = await readManifest(join(workspaceRoot, 'package.json'));
  const packages = await discoverPublicPackages();

  for (const item of packages) {
    const expected = deriveReleaseMetadata(root, item);
    if (metadataMatches(item.manifest, expected)) continue;
    if (check) {
      throw new Error(
        `${item.manifest.name} repository/homepage/bugs metadata is not synchronized; run bun run release:metadata:write`,
      );
    }
    const updated = { ...item.manifest, ...expected };
    await writeFile(item.manifestPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o644 });
    console.log(`updated ${item.relativeDirectory}/package.json`);
  }

  console.log(
    `${check ? 'verified' : 'synchronized'} metadata for ${packages.length} public packages`,
  );
}

await main().catch((error: unknown) => {
  console.error(
    `release metadata blocked: ${(error as Error).message}. Configure real values in root package.json; placeholders are not accepted.`,
  );
  process.exitCode = 1;
});
