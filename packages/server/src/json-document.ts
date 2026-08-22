import type { JsonObject, JsonValue } from '@scenebook/schema';

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonString(value: JsonValue): value is string {
  return typeof value === 'string';
}

/**
 * View a schema-derived value as its JSON document shape.
 *
 * SAFETY: callers pass Zod-parsed records whose schemas only admit
 * JSON-compatible primitives, arrays, and plain objects.
 */
export function asJsonDocument<T>(value: T): JsonValue {
  // SAFETY: callers pass Zod-parsed records whose schemas only admit JSON values.
  return value as JsonValue;
}
