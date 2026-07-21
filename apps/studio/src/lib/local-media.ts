const localMedia = new Map<string, Blob>();

export function createLocalMediaUrl(bytes: BlobPart, mediaType: string): string {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mediaType });
  const url = URL.createObjectURL(blob);
  localMedia.set(url, blob);
  return url;
}

export function getLocalMediaBlob(url: string): Blob | null {
  return localMedia.get(url) ?? null;
}

export function revokeLocalMediaUrl(url: string): void {
  localMedia.delete(url);
  URL.revokeObjectURL(url);
}
