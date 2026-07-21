/**
 * Artifact digests identify bytes, while media types identify how those bytes
 * may be interpreted. Both values are required anywhere an upload object is
 * selected so immutable metadata cannot alias across media representations.
 */
export function artifactObjectIdentity(sha256: string, mediaType: string): string {
  return `${sha256}\0${mediaType}`;
}
