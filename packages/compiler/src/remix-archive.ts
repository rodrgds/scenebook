import { zipSync, type Zippable } from 'fflate';

// fflate reads local wall-clock fields. Constructing this with an ISO/UTC date
// would produce different DOS timestamps in different build timezones.
const ZIP_TIME = new Date(1980, 0, 1, 0, 0, 0, 0);

function zipEntries(files: ReadonlyMap<string, Uint8Array>): Zippable {
  return Object.fromEntries(
    [...files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, bytes]) => [path, [bytes, { level: 9, mtime: ZIP_TIME, os: 3 }]]),
  );
}

export function deterministicRemixArchive(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  return zipSync(zipEntries(files), { level: 9, mtime: ZIP_TIME });
}
