import type { JsonObject, JsonValue } from '@scenebook/schema';

export interface StructuredAssetIdentity {
  readonly sha256: string;
  readonly mediaType: string;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAssetIdentity(
  value: JsonValue,
): value is JsonObject & { readonly sha256: string; readonly mediaType: string } {
  return (
    isJsonObject(value) &&
    typeof value['sha256'] === 'string' &&
    /^[a-f0-9]{64}$/u.test(value['sha256']) &&
    typeof value['mediaType'] === 'string'
  );
}

/** Collect distinct content-addressed asset identities referenced anywhere inside a JSON value. */
export function structuredAssetIdentities(value: JsonValue): readonly StructuredAssetIdentity[] {
  const values = new Map<string, StructuredAssetIdentity>();
  const visit = (candidate: JsonValue): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (isAssetIdentity(candidate)) {
      const { sha256, mediaType } = candidate;
      values.set(`${sha256}\0${mediaType}`, { sha256, mediaType });
    }
    if (!isJsonObject(candidate)) return;
    for (const child of Object.values(candidate)) visit(child);
  };
  visit(value);
  return [...values.values()];
}
